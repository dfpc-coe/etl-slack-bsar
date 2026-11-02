import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import Interactions, { Action, verify } from '../lib/interaction.js';
import type Slack from '../lib/slack.js';
import type CoreEvents from '../lib/cloudtak.js';
import { Value } from '@sinclair/typebox/value';
import type { TSchema, Static } from '@sinclair/typebox';

function type<T extends TSchema>(schema: T, body: unknown): Static<T> {
    if (!Value.Check(schema, body)) throw new Error('Validation failed');
    return body;
}

const SECRET = '8f742231b10e8888abcd99yyyzzz85a5';

function sign(body: string, timestamp = Math.floor(Date.now() / 1000)): { timestamp: string, signature: string } {
    const ts = String(timestamp);
    const signature = `v0=${crypto.createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
    return { timestamp: ts, signature };
}

test('verify - accepts a fresh signature over the raw body', () => {
    const body = 'payload=%7B%22type%22%3A%22block_actions%22%7D';
    const { timestamp, signature } = sign(body);

    assert.ok(verify(SECRET, timestamp, signature, Buffer.from(body)));
});

test('verify - rejects a tampered body, wrong secret, stale timestamp & missing headers', () => {
    const body = 'payload=a';
    const { timestamp, signature } = sign(body);

    assert.ok(!verify(SECRET, timestamp, signature, Buffer.from('payload=b')));
    assert.ok(!verify('other', timestamp, signature, Buffer.from(body)));
    assert.ok(!verify(SECRET, timestamp, 'v0=00', Buffer.from(body)));
    assert.ok(!verify(SECRET, undefined, signature, Buffer.from(body)));

    const stale = sign(body, Math.floor(Date.now() / 1000) - 600);
    assert.ok(!verify(SECRET, stale.timestamp, stale.signature, Buffer.from(body)));
});

function harness() {
    const calls: Array<{ fn: string, args: unknown[] }> = [];

    const slack = {
        userName: async (user: string) => {
            calls.push({ fn: 'userName', args: [user] });
            return 'Jane Doe';
        },
        respond: async (...args: unknown[]) => {
            calls.push({ fn: 'respond', args });
        }
    } as unknown as Slack;

    const coreEvents = {
        task: { type },
        assignments: async (event: string) => {
            calls.push({ fn: 'assignments', args: [event] });
            return [{ id: 'a1', name: 'Someone Else', uid: null, role: '' }];
        },
        assign: async (...args: unknown[]) => {
            calls.push({ fn: 'assign', args });
        },
        setActive: async (...args: unknown[]) => {
            calls.push({ fn: 'setActive', args });
        },
        setPriority: async (...args: unknown[]) => {
            calls.push({ fn: 'setPriority', args });
        }
    } as unknown as CoreEvents;

    return { calls, interactions: new Interactions(slack, coreEvents, () => {}) };
}

const user = { id: 'U1', username: 'jdoe' };
const response_url = 'https://hooks.slack.com/actions/T/1/x';

test('handle - Assign Me assigns the Slack user and tells the channel', async () => {
    const { calls, interactions } = harness();

    await interactions.handle({
        type: 'block_actions', user, response_url,
        actions: [{ action_id: Action.Assign, value: 'ev-1' }]
    });

    assert.deepEqual(calls, [
        { fn: 'userName', args: ['U1'] },
        { fn: 'assignments', args: ['ev-1'] },
        { fn: 'assign', args: ['ev-1', 'Jane Doe', 'Assigned from Slack by Jane Doe'] },
        { fn: 'respond', args: [response_url, '<@U1> is now assigned to this incident', { inChannel: true }] }
    ]);
});

test('handle - Assign Me is ephemeral when already assigned', async () => {
    const { calls, interactions } = harness();
    (interactions.coreEvents as unknown as { assignments: () => Promise<unknown[]> }).assignments = async () => [{ id: 'a1', name: 'Jane Doe', uid: null, role: 'IC' }];

    await interactions.handle({
        type: 'block_actions', user, response_url,
        actions: [{ action_id: Action.Assign, value: 'ev-1' }]
    });

    assert.deepEqual(calls.map((c) => c.fn), ['userName', 'respond']);
    assert.deepEqual(calls[1].args, [response_url, 'You are already assigned to this incident as Jane Doe']);
});

test('handle - Close, Reopen & Priority patch the Event', async () => {
    const { calls, interactions } = harness();

    await interactions.handle({
        type: 'block_actions', user, response_url,
        actions: [
            { action_id: Action.Close, value: 'ev-1' },
            { action_id: Action.Reopen, value: 'ev-1' },
            { action_id: Action.Priority, selected_option: { value: 'ev-1:high' } }
        ]
    });

    assert.deepEqual(calls, [
        { fn: 'setActive', args: ['ev-1', false] },
        { fn: 'respond', args: [response_url, '<@U1> closed this incident', { inChannel: true }] },
        { fn: 'setActive', args: ['ev-1', true] },
        { fn: 'respond', args: [response_url, '<@U1> reopened this incident', { inChannel: true }] },
        { fn: 'setPriority', args: ['ev-1', 'high'] },
        { fn: 'respond', args: [response_url, '<@U1> set the priority to high', { inChannel: true }] }
    ]);
});

test('handle - a failure is reported to the user only', async () => {
    const { calls, interactions } = harness();
    (interactions.coreEvents as unknown as { setActive: () => Promise<void> }).setActive = async () => { throw new Error('403 Forbidden'); };

    await interactions.handle({
        type: 'block_actions', user, response_url,
        actions: [{ action_id: Action.Close, value: 'ev-1' }]
    });

    assert.deepEqual(calls, [
        { fn: 'respond', args: [response_url, "Sorry <@U1>, that didn't work: 403 Forbidden"] }
    ]);
});

test('handle - an unknown priority is rejected before patching', async () => {
    const { calls, interactions } = harness();

    await interactions.handle({
        type: 'block_actions', user, response_url,
        actions: [{ action_id: Action.Priority, selected_option: { value: 'ev-1:urgent' } }]
    });

    assert.deepEqual(calls.map((c) => c.fn), ['respond']);
    assert.match(String(calls[0].args[1]), /^Sorry <@U1>, that didn't work: /);
});
