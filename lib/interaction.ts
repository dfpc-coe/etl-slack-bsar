import crypto from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import type Slack from './slack.js';
import type CoreEvents from './cloudtak.js';
import { Priority } from './cloudtak.js';

/** Slack rejects interactions signed more than five minutes ago as replays */
const MAX_AGE = 5 * 60;

/** action_id of each control on the pinned card - the Event ID travels in the element value */
export const Action = {
    Assign: 'incident:assign',
    Close: 'incident:close',
    Reopen: 'incident:reopen',
    Priority: 'incident:priority'
} as const;

export const BlockActions = Type.Object({
    type: Type.Literal('block_actions'),
    user: Type.Object({
        id: Type.String(),
        username: Type.Optional(Type.String())
    }),
    response_url: Type.String(),
    actions: Type.Array(Type.Object({
        action_id: Type.String(),
        value: Type.Optional(Type.String()),
        selected_option: Type.Optional(Type.Object({
            value: Type.String()
        }))
    }))
});

export type BlockActions = Static<typeof BlockActions>;

/**
 * Check the Slack signature of an interaction - v0=HMAC-SHA256(secret, "v0:<timestamp>:<raw body>")
 * carried in X-Slack-Signature, with X-Slack-Request-Timestamp within the replay window
 */
export function verify(secret: string, timestamp: unknown, signature: unknown, body: Buffer): boolean {
    if (typeof timestamp !== 'string' || typeof signature !== 'string') return false;

    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (!Number.isFinite(age) || age > MAX_AGE) return false;

    const expected = Buffer.from(`v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex')}`);
    const given = Buffer.from(signature);

    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/**
 * Act on the controls of a pinned incident card as the Layer - every change is reported back
 * to the channel through the response_url, and the resulting event:update rewrites the card
 */
export default class Interactions {
    slack: Slack;
    coreEvents: CoreEvents;
    debug: (msg: string) => void;

    constructor(slack: Slack, coreEvents: CoreEvents, debug: (msg: string) => void) {
        this.slack = slack;
        this.coreEvents = coreEvents;
        this.debug = debug;
    }

    async handle(payload: BlockActions): Promise<void> {
        for (const action of payload.actions) {
            const value = action.selected_option?.value || action.value || '';
            const [event, ...rest] = value.split(':');

            this.debug(`interaction ${action.action_id} value=${value} user=${payload.user.id}`);

            if (!event) continue;

            try {
                await this.act(payload, action.action_id, event, rest.join(':'));
            } catch (err) {
                console.error(`not ok - interaction ${action.action_id} on ${event} failed:`, err);
                await this.slack.respond(payload.response_url, `Sorry <@${payload.user.id}>, that didn't work: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    async act(payload: BlockActions, actionId: string, event: string, argument: string): Promise<void> {
        const mention = `<@${payload.user.id}>`;

        if (actionId === Action.Assign) {
            const name = await this.slack.userName(payload.user.id).catch(() => payload.user.username || payload.user.id);

            const existing = (await this.coreEvents.assignments(event)).find((a) => a.name === name);

            if (existing) {
                await this.slack.respond(payload.response_url, `You are already assigned to this incident as ${existing.name}`);
                return;
            }

            await this.coreEvents.assign(event, name, `Assigned from Slack by ${name}`);
            await this.slack.respond(payload.response_url, `${mention} is now assigned to this incident`, { inChannel: true });
        } else if (actionId === Action.Close) {
            await this.coreEvents.setActive(event, false);
            await this.slack.respond(payload.response_url, `${mention} closed this incident`, { inChannel: true });
        } else if (actionId === Action.Reopen) {
            await this.coreEvents.setActive(event, true);
            await this.slack.respond(payload.response_url, `${mention} reopened this incident`, { inChannel: true });
        } else if (actionId === Action.Priority) {
            const priority = this.coreEvents.task.type(Priority, argument);

            await this.coreEvents.setPriority(event, priority);
            await this.slack.respond(payload.response_url, `${mention} set the priority to ${priority}`, { inChannel: true });
        } else {
            this.debug(`skip - unknown interaction ${actionId}`);
        }
    }
}
