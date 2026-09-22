import type { Static, TSchema } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import type Lambda from 'aws-lambda';
import type { Event } from '@tak-ps/etl';
import ETL, { SchemaType, handler as internal, local, fetch, DataFlowType, OutgoingMessageType, OutgoingAction } from '@tak-ps/etl';

const SLACK_API = 'https://slack.com/api';

const OutgoingInput = Type.Object({
    'SLACK_TOKEN': Type.String({
        description: 'Slack Bot User OAuth Token (xoxb-...) - requires channels:manage, groups:write & chat:write scopes'
    }),
    'SLACK_PRIVATE': Type.Boolean({
        default: false,
        description: 'Create private channels instead of public ones'
    }),
    'SLACK_PREFIX': Type.String({
        default: 'sar',
        description: 'Prefix of created channel names - ie: sar-2026-09-21-lost-hiker'
    }),
    'SLACK_INVITE': Type.Array(Type.Object({
        user: Type.String({ description: 'Slack User ID - ie: U012AB3CD' })
    }), {
        default: [],
        description: 'Slack Users invited to every created channel'
    }),
    'BOARD': Type.String({
        description: 'ID of the CoreEvent Board to watch for newly placed Events'
    }),
    'SAR_TYPES': Type.Array(Type.Object({
        type: Type.String({ description: 'MIL-STD-2525E Symbol ID' })
    }), {
        default: [],
        description: 'CoreEvent types considered SAR - any Event placed on the Board is accepted if empty'
    }),
    'DEBUG': Type.Boolean({
        default: false,
        description: 'Print results in logs'
    })
});

// CoreEvent ID => Slack Channel ID, so SQS redelivery or re-placing an Event doesn't create a second channel
const EphemeralStore = Type.Object({
    channels: Type.Optional(Type.Record(Type.String(), Type.String()))
});

// Subset of CloudTAK's CoreEventBoardEventResponse this task relies on
const Placement = Type.Object({
    id: Type.String(),
    board: Type.String(),
    event: Type.Object({
        id: Type.String(),
        name: Type.String(),
        type: Type.String(),
        created: Type.String(),
        priority: Type.Optional(Type.String()),
        location: Type.Optional(Type.String()),
        remarks: Type.Optional(Type.String()),
        geometry: Type.Object({
            type: Type.Literal('Point'),
            coordinates: Type.Array(Type.Number())
        })
    })
});

const SlackChannel = Type.Object({
    ok: Type.Boolean(),
    error: Type.Optional(Type.String()),
    channel: Type.Optional(Type.Object({
        id: Type.String(),
        name: Type.String()
    }))
});

const SlackAuth = Type.Object({
    ok: Type.Boolean(),
    error: Type.Optional(Type.String()),
    url: Type.Optional(Type.String({ description: 'Workspace URL - ie: https://example.slack.com/' }))
});

const CoreEventLinks = Type.Object({
    links: Type.Array(Type.Object({
        name: Type.String(),
        url: Type.String()
    }))
});

const SlackResponse = Type.Object({
    ok: Type.Boolean(),
    error: Type.Optional(Type.String())
});

export default class Task extends ETL {
    static name = 'etl-slack-bsar'
    static flow = [ DataFlowType.Outgoing ];

    async schema(
        type: SchemaType = SchemaType.Input,
        flow: DataFlowType = DataFlowType.Outgoing
    ): Promise<TSchema> {
        if (flow === DataFlowType.Outgoing && type === SchemaType.Input) {
            return OutgoingInput;
        } else {
            return Type.Object({});
        }
    }

    async outgoing(event: Lambda.SQSEvent): Promise<boolean> {
        const env = await this.env(OutgoingInput, DataFlowType.Outgoing);
        const ephem = await this.ephemeral(EphemeralStore, DataFlowType.Outgoing);
        const channels = ephem.channels || {};

        const types = new Set(env.SAR_TYPES.map((t) => t.type));

        const debug = (msg: string) => {
            if (env.DEBUG) console.log(`ok - debug - ${msg}`);
        };

        debug(`board=${env.BOARD} sar_types=[${[...types].join(',')}] known_channels=${Object.keys(channels).length} records=${event.Records.length}`);

        let created = 0;

        for (const message of Task.outgoingMessages(event)) {
            if (message.type !== OutgoingMessageType.BoardEvent || message.action !== OutgoingAction.Create) {
                debug(`skip - message ${message.type}:${'action' in message ? message.action : '-'} is not ${OutgoingMessageType.BoardEvent}:${OutgoingAction.Create}`);
                continue;
            }

            const placement = this.type(Placement, message.data);

            debug(`placement ${placement.id} board=${placement.board} event=${placement.event.id} type=${placement.event.type} name=${placement.event.name}`);

            if (placement.board !== env.BOARD) {
                debug(`skip - board ${placement.board} does not match ${env.BOARD}`);
                continue;
            }

            if (types.size && !types.has(placement.event.type)) {
                debug(`skip - type ${placement.event.type} is not in SAR_TYPES`);
                continue;
            }

            if (channels[placement.event.id]) {
                debug(`skip - event ${placement.event.id} already has channel ${channels[placement.event.id]}`);
                continue;
            }

            debug(`creating channel for ${placement.event.id}: ${placement.event.name}`);

            const channel = await this.createChannel(env, placement.event);
            channels[placement.event.id] = channel.id;
            created++;

            await this.announce(env, channel.id, placement.event);

            try {
                await this.link(env, placement.event.id, channel);
            } catch (err) {
                console.error(`not ok - failed to link Slack channel to CoreEvent ${placement.event.id}:`, err);
            }
        }

        if (created) await this.setEphemeral({ channels }, DataFlowType.Outgoing);

        debug(`created ${created} channel(s)`);

        return true;
    }

    /** Slack channel names are lowercase alphanumerics, hyphens & underscores up to 80 chars */
    channelName(prefix: string, event: Static<typeof Placement>['event'], suffix = ''): string {
        const slug = event.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');

        return [prefix, event.created.slice(0, 10), slug]
            .filter(Boolean)
            .join('-')
            .slice(0, 80 - suffix.length) + suffix;
    }

    async createChannel(
        env: Static<typeof OutgoingInput>,
        event: Static<typeof Placement>['event']
    ): Promise<{ id: string, name: string }> {
        let res = await this.slack(env, 'conversations.create', SlackChannel, {
            name: this.channelName(env.SLACK_PREFIX, event),
            is_private: env.SLACK_PRIVATE
        });

        if (res.error === 'name_taken') {
            res = await this.slack(env, 'conversations.create', SlackChannel, {
                name: this.channelName(env.SLACK_PREFIX, event, `-${event.id.slice(0, 6)}`),
                is_private: env.SLACK_PRIVATE
            });
        }

        if (!res.ok || !res.channel) throw new Error(`Slack conversations.create: ${res.error}`);

        if (env.SLACK_INVITE.length) {
            const invite = await this.slack(env, 'conversations.invite', SlackResponse, {
                channel: res.channel.id,
                users: env.SLACK_INVITE.map((u) => u.user).join(',')
            });

            if (!invite.ok) console.error(`not ok - Slack conversations.invite: ${invite.error}`);
        }

        return res.channel;
    }

    async announce(
        env: Static<typeof OutgoingInput>,
        channel: string,
        event: Static<typeof Placement>['event']
    ): Promise<void> {
        const [lng, lat] = event.geometry.coordinates;

        const lines = [
            `*${event.name}*`,
            event.priority ? `Priority: ${event.priority}` : null,
            event.location ? `Location: ${event.location}` : null,
            `Coordinates: ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
            event.remarks || null
        ].filter(Boolean);

        const topic = await this.slack(env, 'conversations.setTopic', SlackResponse, {
            channel,
            topic: event.name.slice(0, 250)
        });
        if (!topic.ok) console.error(`not ok - Slack conversations.setTopic: ${topic.error}`);

        const post = await this.slack(env, 'chat.postMessage', SlackResponse, {
            channel,
            text: lines.join('\n')
        });
        if (!post.ok) console.error(`not ok - Slack chat.postMessage: ${post.error}`);
    }

    /** PATCH replaces the links array, so append to the current links of the CoreEvent */
    async link(
        env: Static<typeof OutgoingInput>,
        event: string,
        channel: { id: string, name: string }
    ): Promise<void> {
        const auth = await this.slack(env, 'auth.test', SlackAuth, {});
        if (!auth.ok || !auth.url) throw new Error(`Slack auth.test: ${auth.error}`);

        const url = new URL(`/archives/${channel.id}`, auth.url).toString();

        const current = this.type(CoreEventLinks, await this.fetch(`/api/core/event/${event}`));
        if (current.links.some((l) => l.url === url)) return;

        await this.fetch(`/api/core/event/${event}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                links: [...current.links, { name: `Slack: #${channel.name}`, url }]
            })
        });
    }

    async slack<T extends TSchema>(
        env: Static<typeof OutgoingInput>,
        method: string,
        schema: T,
        body: Record<string, unknown>
    ): Promise<Static<T>> {
        const res = await fetch(`${SLACK_API}/${method}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.SLACK_TOKEN}`,
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: JSON.stringify(body)
        });

        return await res.typed(schema);
    }
}

await local(await Task.init(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(new Task(import.meta.url), event);
}
