import test from 'node:test';
import assert from 'node:assert';
import Incidents from '../lib/incident.js';
import type Slack from '../lib/slack.js';
import type { IncidentEvent } from '../lib/cloudtak.js';

function setup() {
    const calls: Array<{ fn: string, args: unknown[] }> = [];

    const slack = {
        channelUrl: async (channel: string) => `https://example.slack.com/archives/${channel}`,
        post: async (...args: unknown[]) => {
            calls.push({ fn: 'post', args });
            return { channel: 'C_MAIN', ts: '1700000000.000100' };
        },
        update: async (...args: unknown[]) => {
            calls.push({ fn: 'update', args });
            return 'updated';
        }
    } as unknown as Slack;

    const incidents = new Incidents(slack, {
        api: 'https://map.example.com',
        prefix: 'sar',
        isPrivate: false,
        invite: [],
        announce: '#active-ops'
    });

    return { calls, incidents };
}

const channel = { id: 'C_INCIDENT', name: 'sar-2026-11-01-another-test' };

const event: IncidentEvent = {
    id: 'e1',
    name: 'Another Test',
    type: '10034000001100000000',
    created: '2026-11-01T20:00:00.000Z',
    priority: 'high',
    remarks: 'Hiker overdue',
    geometry: { type: 'Point', coordinates: [-105.1, 39.7] }
};

const heading = (card: { blocks: Array<{ type: string, text?: { text: string } }> }) => card.blocks.find((b) => b.type === 'header')?.text?.text;

test('broadcast - posts a New Incident card by the configured name & returns where it landed', async () => {
    const { calls, incidents } = setup();

    const posted = await incidents.broadcast(channel, event);

    assert.deepStrictEqual(posted, { channel: 'C_MAIN', ts: '1700000000.000100', reopened: false });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].args[0], 'active-ops');
    assert.strictEqual(calls[0].args[1], 'New Incident: Another Test - #sar-2026-11-01-another-test');
    assert.strictEqual(heading(calls[0].args[2] as Parameters<typeof heading>[0]), 'New Incident: Another Test');
});

test('broadcast - nothing is posted without a main channel', async () => {
    const { calls, incidents } = setup();
    incidents.announceChannel = undefined;

    assert.strictEqual(await incidents.broadcast(channel, event), null);
    assert.strictEqual(calls.length, 0);
});

test('rebroadcast - rewrites the card in place, headed Closed once the Event has ended', async () => {
    const { calls, incidents } = setup();
    const posted = { channel: 'C_MAIN', ts: '1700000000.000100', reopened: true };

    assert.ok(await incidents.rebroadcast(posted, channel, { ...event, priority: 'low' }));
    assert.strictEqual(calls[0].fn, 'update');
    assert.deepStrictEqual(calls[0].args.slice(0, 3), ['C_MAIN', '1700000000.000100', 'Reopened Incident: Another Test - #sar-2026-11-01-another-test']);
    assert.strictEqual((calls[0].args[3] as { color: string }).color, '#2e86c1');

    assert.ok(await incidents.rebroadcast(posted, channel, { ...event, ended: '2026-11-01T21:00:00.000Z' }));
    assert.strictEqual(calls[1].args[2], 'Closed Incident: Another Test - #sar-2026-11-01-another-test');
    assert.strictEqual(heading(calls[1].args[3] as Parameters<typeof heading>[0]), 'Closed Incident: Another Test');
    assert.strictEqual((calls[1].args[3] as { color: string }).color, '#6b7280');
});

test('rebroadcast - reports a card Slack no longer lets us edit', async () => {
    const { incidents } = setup();
    (incidents.slack as unknown as { update: () => Promise<string> }).update = async () => 'uneditable';

    assert.strictEqual(await incidents.rebroadcast({ channel: 'C_MAIN', ts: '1', reopened: false }, channel, event), false);
});
