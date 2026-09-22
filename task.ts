import type { TSchema } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import type Lambda from 'aws-lambda';
import type { Event } from '@tak-ps/etl';
import ETL, { SchemaType, handler as internal, local, DataFlowType, OutgoingMessageType, OutgoingAction } from '@tak-ps/etl';
import Slack from './lib/slack.js';
import Incidents from './lib/incident.js';
import CoreEvents, { Placement } from './lib/cloudtak.js';

const OutgoingInput = Type.Object({
    'SLACK_TOKEN': Type.String({
        description: 'Slack Bot User OAuth Token (xoxb-...) - requires channels:manage, channels:read, groups:write, groups:read & chat:write scopes - conversations.connect:write adds a shareable invite link to the CoreEvent'
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

        const slack = new Slack(env.SLACK_TOKEN);
        const incidents = new Incidents(slack, {
            prefix: env.SLACK_PREFIX,
            isPrivate: env.SLACK_PRIVATE,
            invite: env.SLACK_INVITE.map((u) => u.user)
        });
        const coreEvents = new CoreEvents(this);

        const debug = (msg: string) => {
            if (env.DEBUG) console.log(`ok - debug - ${msg}`);
        };

        debug(`board=${env.BOARD} sar_types=[${[...types].join(',')}] known_channels=${Object.keys(channels).length} records=${event.Records.length}`);

        let changed = false;
        let created = 0;

        for (const message of Task.outgoingMessages(event)) {
            if (message.type !== OutgoingMessageType.BoardEvent) {
                debug(`skip - message ${message.type} is not a ${OutgoingMessageType.BoardEvent}`);
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

            const known = channels[placement.event.id];

            // Removed from the Board => archive, keeping the mapping so a re-placed Event revives the channel
            if (message.action === OutgoingAction.Delete) {
                if (!known) {
                    debug(`skip - event ${placement.event.id} removed but has no channel`);
                    continue;
                }

                const state = await slack.archive(known);
                debug(`event ${placement.event.id} removed from board, channel ${known}: ${state}`);

                if (state === 'missing') {
                    delete channels[placement.event.id];
                    changed = true;
                }

                continue;
            }

            // Already has a channel => revive it if archived & keep the CoreEvent linked to it
            if (known) {
                const active = await slack.ensureActive(known);
                debug(`event ${placement.event.id} already has channel ${known}: ${active.state}`);

                if (active.state !== 'missing') {
                    if (active.state === 'unarchived') {
                        await incidents.announce(known, placement.event, { reopened: true });
                    }

                    await this.link(coreEvents, slack, placement.event.id, active.channel);

                    continue;
                }

                delete channels[placement.event.id];
                changed = true;
            }

            if (message.action === OutgoingAction.Update) {
                debug(`skip - event ${placement.event.id} updated but has no channel`);
                continue;
            }

            // Newly placed => open a channel, announce the incident & link the CoreEvent to it
            debug(`creating channel for ${placement.event.id}: ${placement.event.name}`);

            const channel = await incidents.open(placement.event);
            channels[placement.event.id] = channel.id;
            changed = true;
            created++;

            await incidents.announce(channel.id, placement.event, { reopened: channel.reopened });
            await this.link(coreEvents, slack, placement.event.id, channel);
        }

        if (changed) await this.setEphemeral({ channels }, DataFlowType.Outgoing);

        debug(`created ${created} channel(s)`);

        return true;
    }

    /** Linking is best effort - a CoreEvent the Layer cannot read or update must not block channel handling */
    async link(
        coreEvents: CoreEvents,
        slack: Slack,
        event: string,
        channel: { id: string, name: string }
    ): Promise<void> {
        try {
            const links = [{
                name: `Slack: #${channel.name}`,
                url: await slack.channelUrl(channel.id)
            }];

            try {
                links.push({
                    name: `Slack Invite: #${channel.name}`,
                    url: await slack.inviteLink(channel.id)
                });
            } catch (err) {
                console.error(`not ok - no invite link for Slack channel ${channel.id}:`, err);
            }

            await coreEvents.link(event, links);
        } catch (err) {
            console.error(`not ok - failed to link Slack channel to CoreEvent ${event}:`, err);
        }
    }
}

await local(await Task.init(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(new Task(import.meta.url), event);
}
