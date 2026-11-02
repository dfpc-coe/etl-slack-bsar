import type { Static } from '@sinclair/typebox';
import type Slack from './slack.js';
import type { SlackChannelInfo, SlackBlock, SlackCard, SlackActionElement } from './slack.js';
import type { IncidentEvent, Link, Priority } from './cloudtak.js';
import { closed } from './cloudtak.js';
import { Action } from './interaction.js';

export type IncidentChannel = Static<typeof SlackChannelInfo> & { reopened: boolean };

/** Characters of the remarks shown on the main channel card - the pinned card carries them in full */
const ANNOUNCE_REMARKS = 200;

/** Options of the priority selector on the pinned card */
const PRIORITIES: Array<{ value: Priority, text: string }> = [
    { value: 'none', text: 'No Priority' },
    { value: 'low', text: 'Low' },
    { value: 'medium', text: 'Medium' },
    { value: 'high', text: 'High' },
    { value: 'critical', text: 'Critical' }
];

/** Attachment stripe colour by CoreEvent priority */
const PRIORITY_COLOR: Record<string, string> = {
    critical: '#8b0000',
    high: '#c0392b',
    medium: '#e69a28',
    low: '#2e86c1'
};

/** Slack reads &, < and > of a message as control characters */
function escape(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Cut text to at most `limit` characters at a word boundary, marking the cut with an ellipsis */
function truncate(text: string, limit: number): string {
    if (text.length <= limit) return text;

    const cut = text.slice(0, limit - 1);
    const space = cut.lastIndexOf(' ');

    return (space > limit / 2 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

/**
 * The Slack channel of a SAR incident - naming, opening & announcing
 */
export default class Incidents {
    slack: Slack;
    api: string;
    prefix: string;
    isPrivate: boolean;
    invite: string[];
    usergroup?: string;
    announceChannel?: string;
    interactive: boolean;
    members?: Promise<string[]>;

    constructor(slack: Slack, opts: {
        api: string,
        prefix: string,
        isPrivate: boolean,
        invite: string[],
        usergroup?: string,
        announce?: string,
        interactive?: boolean
    }) {
        this.slack = slack;
        this.api = opts.api;
        this.prefix = opts.prefix;
        this.isPrivate = opts.isPrivate;
        this.invite = opts.invite;
        this.usergroup = opts.usergroup?.trim() || undefined;
        this.announceChannel = opts.announce?.trim().replace(/^#/, '') || undefined;
        this.interactive = opts.interactive || false;
    }

    /** Users to invite to a new channel - the User Group is resolved once per invocation, and only if a channel is opened */
    async invitees(): Promise<string[]> {
        if (!this.usergroup) return this.invite;

        if (!this.members) {
            this.members = this.slack.usergroupMembers(this.usergroup).catch((err) => {
                console.error(`not ok - failed to resolve Slack User Group "${this.usergroup}":`, err);
                return [];
            });
        }

        return [...this.invite, ...await this.members];
    }

    /** Slack channel names are lowercase alphanumerics, hyphens & underscores up to 80 chars */
    channelName(event: IncidentEvent, suffix = ''): string {
        const slug = event.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');

        return [this.prefix, event.created.slice(0, 10), slug]
            .filter(Boolean)
            .join('-')
            .slice(0, 80 - suffix.length) + suffix;
    }

    /** The channel purpose records which CoreEvent a channel was opened for */
    purpose(event: IncidentEvent): string {
        return `CoreEvent: ${event.id}`;
    }

    /**
     * Open the channel of an incident - reusing (and unarchiving) the channel
     * opened for this same Event when the ephemeral store was reset, otherwise
     * creating one. A channel of the same name opened for a different Event
     * (ie: two incidents named alike on the same day) is never reused
     */
    async open(event: IncidentEvent): Promise<IncidentChannel> {
        const purpose = this.purpose(event);

        for (const name of [this.channelName(event), this.channelName(event, `-${event.id.slice(0, 6)}`)]) {
            const channel = await this.slack.create(name, this.isPrivate);

            if (channel) {
                await this.slack.setPurpose(channel.id, purpose);
                await this.slack.invite(channel.id, await this.invitees());

                return { ...channel, reopened: false };
            }

            const existing = await this.slack.find(name);

            if (existing && existing.purpose?.value === purpose) {
                const active = await this.slack.ensureActive(existing.id);
                return { ...existing, reopened: active.state === 'unarchived' };
            }
        }

        throw new Error(`Slack conversations.create: name_taken`);
    }

    /**
     * Mirror the Links of the Event as channel bookmarks - added by URL,
     * retitled when the Link is renamed, never removed. The Link back to the
     * channel itself is skipped
     */
    async bookmark(channel: string, links: Link[] = []): Promise<void> {
        const self = await this.slack.channelUrl(channel);
        const wanted = links.filter((link) => link.url && link.url !== self);
        if (!wanted.length) return;

        const existing = new Map((await this.slack.bookmarks(channel))
            .filter((b) => b.link)
            .map((b) => [b.link as string, b]));

        for (const link of wanted) {
            const current = existing.get(link.url);

            if (!current) {
                await this.slack.addBookmark(channel, link.name, link.url);
            } else if (current.title !== link.name) {
                await this.slack.editBookmark(channel, current.id, link.name);
            }
        }
    }

    details(event: IncidentEvent, opts: { reopened?: boolean } = {}): string[] {
        const [lng, lat] = event.geometry.coordinates;
        const remarks = escape(event.remarks || '');

        return [
            closed(event) ? 'Status: Closed' : '',
            event.priority ? `Priority: ${escape(event.priority)}` : '',
            event.location ? `Location: ${escape(event.location)}` : '',
            `Coordinates: ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
            opts.reopened ? `Remarks: ${remarks || 'none'}` : remarks
        ].filter(Boolean);
    }

    eventUrl(event: IncidentEvent): string {
        return new URL(`/event/${event.id}`, this.api).toString();
    }

    /**
     * Controls of the pinned card, acted on by the Interactivity webhook - assign the pressing
     * user, close or reopen the Event, and pick its priority
     */
    controls(event: IncidentEvent): SlackActionElement[] {
        if (!this.interactive) return [];

        const current = PRIORITIES.find((p) => p.value === (event.priority || 'none'));

        const option = (p: { value: Priority, text: string }) => ({
            text: { type: 'plain_text' as const, text: p.text },
            value: `${event.id}:${p.value}`
        });

        return [{
            type: 'button',
            text: { type: 'plain_text', text: 'Assign Me' },
            action_id: Action.Assign,
            value: event.id
        }, closed(event) ? {
            type: 'button',
            text: { type: 'plain_text', text: 'Reopen Incident' },
            action_id: Action.Reopen,
            value: event.id
        } : {
            type: 'button',
            text: { type: 'plain_text', text: 'Close Incident' },
            action_id: Action.Close,
            value: event.id,
            style: 'danger',
            confirm: {
                title: { type: 'plain_text', text: 'Close this incident?' },
                text: { type: 'mrkdwn', text: `*${escape(event.name)}* will be ended in CloudTAK` },
                confirm: { type: 'plain_text', text: 'Close' },
                deny: { type: 'plain_text', text: 'Cancel' },
                style: 'danger'
            }
        }, {
            type: 'static_select',
            action_id: Action.Priority,
            placeholder: { type: 'plain_text', text: 'Priority' },
            options: PRIORITIES.map(option),
            ...(current ? { initial_option: option(current) } : {})
        }];
    }

    /**
     * Block Kit card of an Event - a heading, the details as a field grid, the remarks
     * (cut to `remarks` characters), then the given buttons, controls & context line - striped by priority
     */
    card(heading: string, event: IncidentEvent, opts: {
        mention?: boolean,
        reopened?: boolean,
        remarks?: number,
        buttons?: Array<{ text: string, url: string, primary?: boolean }>,
        controls?: SlackActionElement[],
        context?: string[]
    } = {}): SlackCard {
        const [lng, lat] = event.geometry.coordinates;
        const created = Math.floor(Date.parse(event.created) / 1000);

        const fields = [
            closed(event) ? '*Status*\nClosed' : '',
            event.priority && event.priority !== 'none' ? `*Priority*\n${escape(event.priority)}` : '',
            event.location ? `*Location*\n${escape(event.location)}` : '',
            `*Coordinates*\n${lat.toFixed(5)}, ${lng.toFixed(5)}`
        ].filter(Boolean);

        const blocks: SlackBlock[] = [];

        if (opts.mention) {
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '<!here>' } });
        }

        blocks.push({
            type: 'header',
            text: { type: 'plain_text', text: heading.slice(0, 150) }
        }, {
            type: 'section',
            fields: fields.map((text) => ({ type: 'mrkdwn', text }))
        });

        const remarks = escape(truncate(event.remarks || '', opts.remarks || 3000));

        if (remarks || opts.reopened) {
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: remarks || '_No remarks_' }
            });
        }

        const elements: SlackActionElement[] = [
            ...(opts.buttons || []).map((button): SlackActionElement => ({
                type: 'button',
                text: { type: 'plain_text', text: button.text.slice(0, 75) },
                url: button.url,
                ...(button.primary ? { style: 'primary' } : {})
            })),
            ...(opts.controls || [])
        ];

        if (elements.length) {
            blocks.push({ type: 'actions', elements });
        }

        blocks.push({
            type: 'context',
            elements: [{
                type: 'mrkdwn',
                text: [
                    ...(opts.context || []),
                    `Created <!date^${created}^{date_short_pretty} at {time}|${event.created}>`
                ].join(' · ')
            }]
        });

        return {
            color: closed(event) ? '#6b7280' : PRIORITY_COLOR[event.priority || ''] || '#6b7280',
            blocks
        };
    }

    /**
     * Write the current state of the Event to the pinned message of the
     * channel, recognised by its link back to the Event - posted & pinned if
     * the channel has none. Only a newly posted message can mention @here.
     * The card fallback carries the full details so a change is detected by
     * comparing it with the pinned message - one still carrying the details
     * as rendered text is rewritten as a card
     */
    async status(channel: string, event: IncidentEvent, opts: { mention?: boolean } = {}): Promise<void> {
        const url = this.eventUrl(event);

        const text = [
            `*${escape(event.name)}*`,
            ...this.details(event),
            `<${url}|Open in CloudTAK>`
        ].join('\n');

        const buttons = [{ text: 'Open in CloudTAK', url, primary: true }];
        const controls = this.controls(event);

        let pinned: Awaited<ReturnType<Slack['pins']>> = [];

        try {
            pinned = await this.slack.pins(channel);
        } catch (err) {
            console.error(`not ok - failed to list the pinned messages of ${channel}:`, err);
            if (!opts.mention) return;
        }

        const current = pinned.find((message) => {
            return [message.text, ...(message.attachments || []).map((a) => a.fallback)]
                .some((candidate) => candidate?.includes(`/event/${event.id}`));
        });

        if (current) {
            if (current.attachments?.[0]?.fallback?.replace(/^<!here> /, '') === text) return;
            if (await this.slack.update(channel, current.ts, text, this.card(event.name, event, { buttons, controls })) === 'updated') return;

            await this.slack.unpin(channel, current.ts);
        }

        const ts = await this.slack.post(
            channel,
            opts.mention ? `<!here> ${text}` : text,
            this.card(event.name, event, { mention: opts.mention, buttons, controls })
        );

        if (ts) await this.slack.pin(channel, ts);
    }

    /**
     * Notify everyone in the channel with @here - a new channel by its pinned
     * message, a reopened channel by a card that always states the remarks,
     * even when empty, alongside its refreshed pinned message
     */
    async announce(channel: string, event: IncidentEvent, opts: { reopened?: boolean } = {}): Promise<void> {
        await this.slack.setTopic(channel, event.name);

        if (opts.reopened) {
            const heading = `Reopened: ${event.name}`;

            await this.slack.post(channel, [
                `<!here> *${escape(heading)}*`,
                ...this.details(event, { reopened: true })
            ].join('\n'), this.card(heading, event, { mention: true, reopened: true }));
        }

        await this.status(channel, event, { mention: !opts.reopened });
    }

    /**
     * Post an incident card to the main channel, if one is configured,
     * with a button into the incident channel
     */
    async broadcast(channel: { id: string, name: string }, event: IncidentEvent, opts: { reopened?: boolean } = {}): Promise<void> {
        if (!this.announceChannel) return;

        const heading = `${opts.reopened ? 'Reopened' : 'New'} Incident: ${event.name}`;

        await this.slack.post(
            this.announceChannel,
            `${escape(heading)} - #${channel.name}`,
            this.card(heading, event, {
                remarks: ANNOUNCE_REMARKS,
                buttons: [
                    { text: `#${channel.name}`, url: await this.slack.channelUrl(channel.id), primary: true },
                    { text: 'Open in CloudTAK', url: this.eventUrl(event) }
                ],
                context: [`<#${channel.id}>`]
            })
        );
    }
}
