import type { TSchema, Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import type Lambda from 'aws-lambda';
import type { Event, OutgoingEventMessage, OutgoingBoardEventMessage } from '@tak-ps/etl';
import ETL, { SchemaType, handler as internal, local, DataFlowType, OutgoingMessageType, OutgoingAction } from '@tak-ps/etl';
import Slack from './lib/slack.js';
import Incidents from './lib/incident.js';
import CoreEvents, { Placement, IncidentEvent } from './lib/cloudtak.js';

const BoardTrigger = Type.Object({
    Mode: Type.Literal('Board'),
    BOARD: Type.String({
        description: 'ID of the CoreEvent Board to watch for newly placed Events'
    })
}, {
    title: 'Board Placement',
    description: 'A channel is opened when a SAR CoreEvent is placed on the Board and archived when it is removed'
});

const ChannelTrigger = Type.Object({
    Mode: Type.Literal('Channel'),
    CHANNEL: Type.Integer({
        description: 'TAK Server Channel ID (bitpos) - the Layer Connection must also be a member of this Channel'
    })
}, {
    title: 'Channel Event',
    description: 'A channel is opened when a SAR CoreEvent is created in the Channel and archived when the Event is deleted'
});

const Trigger = Type.Union([BoardTrigger, ChannelTrigger], {
    description: 'What starts the Slack flow'
});

type Trigger = Static<typeof Trigger>;

const OutgoingInput = Type.Object({
    'SLACK_TOKEN': Type.String({
        description: 'Slack Bot User OAuth Token (xoxb-...) with channels:manage, channels:read, groups:write, groups:read, chat:write, pins:read, pins:write, bookmarks:read & bookmarks:write scopes (plus usergroups:read if SLACK_USERGROUP is set) - a User OAuth Token (xoxp-...) with the equivalent user scopes also works'
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
    'SLACK_USERGROUP': Type.Optional(Type.String({
        description: 'Slack User Group (@handle or name - ie: @sar-team) whose members are invited to every created channel - requires the usergroups:read scope'
    })),
    'TRIGGER': Trigger,
    'SAR_TYPES': Type.Array(Type.Object({
        type: Type.String({ description: 'MIL-STD-2525E Symbol ID' })
    }), {
        default: [],
        description: 'CoreEvent types considered SAR - any Event is accepted if empty'
    }),
    'DEBUG': Type.Boolean({
        default: false,
        description: 'Print results in logs'
    })
});

// Layers configured before TRIGGER store the Board ID at the top level
const StoredInput = Type.Composite([
    Type.Omit(OutgoingInput, ['TRIGGER']),
    Type.Object({
        'TRIGGER': Type.Optional(Trigger),
        'BOARD': Type.Optional(Type.String())
    })
]);

// CoreEvent ID => Slack Channel ID, so SQS redelivery or re-placing an Event doesn't create a second channel
const EphemeralStore = Type.Object({
    channels: Type.Optional(Type.Record(Type.String(), Type.String()))
});

type Context = {
    trigger: Trigger;
    types: Set<string>;
    channels: Record<string, string>;
    slack: Slack;
    incidents: Incidents;
    coreEvents: CoreEvents;
    debug: (msg: string) => void;
    changed: boolean;
    created: number;
};

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
        const env = await this.env(StoredInput, DataFlowType.Outgoing);
        const ephem = await this.ephemeral(EphemeralStore, DataFlowType.Outgoing);

        const trigger: Trigger | undefined = env.TRIGGER || (env.BOARD ? { Mode: 'Board', BOARD: env.BOARD } : undefined);
        if (!trigger) throw new Error('TRIGGER is not configured');

        const slack = new Slack(env.SLACK_TOKEN);

        const ctx: Context = {
            trigger,
            types: new Set(env.SAR_TYPES.map((t) => t.type)),
            channels: ephem.channels || {},
            slack,
            incidents: new Incidents(slack, {
                api: this.etl.api,
                prefix: env.SLACK_PREFIX,
                isPrivate: env.SLACK_PRIVATE,
                invite: env.SLACK_INVITE.map((u) => u.user),
                usergroup: env.SLACK_USERGROUP
            }),
            coreEvents: new CoreEvents(this),
            debug: (msg: string) => {
                if (env.DEBUG) console.log(`ok - debug - ${msg}`);
            },
            changed: false,
            created: 0
        };

        const target = trigger.Mode === 'Board' ? `board=${trigger.BOARD}` : `channel=${trigger.CHANNEL}`;
        ctx.debug(`mode=${trigger.Mode} ${target} sar_types=[${[...ctx.types].join(',')}] known_channels=${Object.keys(ctx.channels).length} records=${event.Records.length}`);

        for (const message of Task.outgoingMessages(event)) {
            if (message.type === OutgoingMessageType.Event) {
                await this.event(ctx, message);
            } else if (message.type === OutgoingMessageType.BoardEvent) {
                await this.placement(ctx, message);
            } else {
                ctx.debug(`skip - message ${message.type} is not an ${OutgoingMessageType.Event} or ${OutgoingMessageType.BoardEvent}`);
            }
        }

        if (ctx.changed) await this.setEphemeral({ channels: ctx.channels }, DataFlowType.Outgoing);

        ctx.debug(`created ${ctx.created} channel(s)`);

        return true;
    }

    /**
     * event:<action> - an updated CoreEvent with a channel rewrites its pinned message & bookmarks in any mode,
     * a deleted CoreEvent archives its channel, and in Channel mode a CoreEvent created in the Channel opens one
     */
    async event(ctx: Context, message: Static<typeof OutgoingEventMessage>): Promise<void> {
        const incident = this.type(IncidentEvent, message.data);
        const known = ctx.channels[incident.id];

        ctx.debug(`event ${incident.id} ${message.action} type=${incident.type} name=${incident.name} channels=[${message.channels.join(',')}]`);

        if (message.action === OutgoingAction.Update) {
            if (!known) {
                ctx.debug(`skip - event ${incident.id} updated but has no channel`);
                return;
            }

            const info = await ctx.slack.info(known);

            if (!info || info.is_archived) {
                ctx.debug(`skip - event ${incident.id} channel ${known} is ${info ? 'archived' : 'missing'}`);
                return;
            }

            ctx.debug(`event ${incident.id} updated, rewriting the pinned message & bookmarking ${(incident.links || []).length} link(s) in ${known}`);
            await ctx.incidents.status(known, incident);
            await ctx.incidents.bookmark(known, incident.links);
        } else if (message.action === OutgoingAction.Delete) {
            if (!known) {
                ctx.debug(`skip - event ${incident.id} deleted but has no channel`);
                return;
            }

            const state = await ctx.slack.archive(known);
            ctx.debug(`event ${incident.id} deleted, channel ${known}: ${state}`);

            delete ctx.channels[incident.id];
            ctx.changed = true;
        } else {
            if (ctx.trigger.Mode !== 'Channel') {
                ctx.debug(`skip - event ${incident.id} created but mode is ${ctx.trigger.Mode}`);
                return;
            }

            if (!message.channels.includes(ctx.trigger.CHANNEL)) {
                ctx.debug(`skip - event ${incident.id} is not shared with channel ${ctx.trigger.CHANNEL}`);
                return;
            }

            if (ctx.types.size && !ctx.types.has(incident.type)) {
                ctx.debug(`skip - type ${incident.type} is not in SAR_TYPES`);
                return;
            }

            await this.open(ctx, incident);
        }
    }

    /**
     * board:event:<action> - in Board mode a CoreEvent placed on the Board opens a channel,
     * moved on the Board revives it, and removed from the Board archives it
     */
    async placement(ctx: Context, message: Static<typeof OutgoingBoardEventMessage>): Promise<void> {
        if (ctx.trigger.Mode !== 'Board') {
            ctx.debug(`skip - board placement message but mode is ${ctx.trigger.Mode}`);
            return;
        }

        const placement = this.type(Placement, message.data);

        ctx.debug(`placement ${placement.id} ${message.action} board=${placement.board} event=${placement.event.id} type=${placement.event.type} name=${placement.event.name}`);

        if (placement.board !== ctx.trigger.BOARD) {
            ctx.debug(`skip - board ${placement.board} does not match ${ctx.trigger.BOARD}`);
            return;
        }

        if (ctx.types.size && !ctx.types.has(placement.event.type)) {
            ctx.debug(`skip - type ${placement.event.type} is not in SAR_TYPES`);
            return;
        }

        const known = ctx.channels[placement.event.id];

        // Removed from the Board => archive, keeping the mapping so a re-placed Event revives the channel
        if (message.action === OutgoingAction.Delete) {
            if (!known) {
                ctx.debug(`skip - event ${placement.event.id} removed but has no channel`);
                return;
            }

            const state = await ctx.slack.archive(known);
            ctx.debug(`event ${placement.event.id} removed from board, channel ${known}: ${state}`);

            if (state === 'missing') {
                delete ctx.channels[placement.event.id];
                ctx.changed = true;
            }

            return;
        }

        // Moved on the Board => revive its channel, never open one
        await this.open(ctx, placement.event, { create: message.action !== OutgoingAction.Update });
    }

    /**
     * Ensure the Event has an active channel - reviving its known channel if archived,
     * otherwise opening a new one - and keep the CoreEvent linked to it
     */
    async open(ctx: Context, incident: IncidentEvent, opts: { create?: boolean } = {}): Promise<void> {
        const known = ctx.channels[incident.id];

        if (known) {
            const active = await ctx.slack.ensureActive(known);
            ctx.debug(`event ${incident.id} already has channel ${known}: ${active.state}`);

            if (active.state !== 'missing') {
                if (active.state === 'unarchived') {
                    await ctx.incidents.announce(known, incident, { reopened: true });
                    await ctx.incidents.bookmark(known, incident.links);
                }

                await this.link(ctx, incident.id, active.channel);

                return;
            }

            delete ctx.channels[incident.id];
            ctx.changed = true;
        }

        if (opts.create === false) {
            ctx.debug(`skip - event ${incident.id} has no channel`);
            return;
        }

        ctx.debug(`creating channel for ${incident.id}: ${incident.name}`);

        const channel = await ctx.incidents.open(incident);
        ctx.channels[incident.id] = channel.id;
        ctx.changed = true;
        ctx.created++;

        await ctx.incidents.announce(channel.id, incident, { reopened: channel.reopened });
        await ctx.incidents.bookmark(channel.id, incident.links);
        await this.link(ctx, incident.id, channel);
    }

    /** Linking is best effort - a CoreEvent the Layer cannot read or update must not block channel handling */
    async link(
        ctx: Context,
        event: string,
        channel: { id: string, name: string }
    ): Promise<void> {
        try {
            await ctx.coreEvents.link(event, [{
                name: `Slack: #${channel.name}`,
                url: await ctx.slack.channelUrl(channel.id)
            }]);
        } catch (err) {
            console.error(`not ok - failed to link Slack channel to CoreEvent ${event}:`, err);
        }
    }
}

await local(await Task.init(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(new Task(import.meta.url), event);
}
