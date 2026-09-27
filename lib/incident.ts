import type { Static } from '@sinclair/typebox';
import type Slack from './slack.js';
import type { SlackChannelInfo } from './slack.js';
import type { IncidentEvent, Link } from './cloudtak.js';

export type IncidentChannel = Static<typeof SlackChannelInfo> & { reopened: boolean };

/** Slack reads &, < and > of a message as control characters */
function escape(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    members?: Promise<string[]>;

    constructor(slack: Slack, opts: { api: string, prefix: string, isPrivate: boolean, invite: string[], usergroup?: string }) {
        this.slack = slack;
        this.api = opts.api;
        this.prefix = opts.prefix;
        this.isPrivate = opts.isPrivate;
        this.invite = opts.invite;
        this.usergroup = opts.usergroup?.trim() || undefined;
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
            event.priority ? `Priority: ${escape(event.priority)}` : '',
            event.location ? `Location: ${escape(event.location)}` : '',
            `Coordinates: ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
            opts.reopened ? `Remarks: ${remarks || 'none'}` : remarks
        ].filter(Boolean);
    }

    /**
     * Write the current state of the Event to the pinned message of the
     * channel, recognised by its link back to the Event - posted & pinned if
     * the channel has none. Only a newly posted message can mention @here
     */
    async status(channel: string, event: IncidentEvent, opts: { mention?: boolean } = {}): Promise<void> {
        const path = `/event/${event.id}`;

        const text = [
            `*${escape(event.name)}*`,
            ...this.details(event),
            `<${new URL(path, this.api).toString()}|Open in CloudTAK>`
        ].join('\n');

        let pinned: Awaited<ReturnType<Slack['pins']>> = [];

        try {
            pinned = await this.slack.pins(channel);
        } catch (err) {
            console.error(`not ok - failed to list the pinned messages of ${channel}:`, err);
            if (!opts.mention) return;
        }

        const current = pinned.find((message) => message.text?.includes(path));

        if (current) {
            if (current.text?.replace(/^<!here> /, '') === text) return;
            if (await this.slack.update(channel, current.ts, text) === 'updated') return;

            await this.slack.unpin(channel, current.ts);
        }

        const ts = await this.slack.post(channel, opts.mention ? `<!here> ${text}` : text);
        if (ts) await this.slack.pin(channel, ts);
    }

    /**
     * Notify everyone in the channel with @here - a new channel by its pinned
     * message, a reopened channel by a message that always states the remarks,
     * even when empty, alongside its refreshed pinned message
     */
    async announce(channel: string, event: IncidentEvent, opts: { reopened?: boolean } = {}): Promise<void> {
        await this.slack.setTopic(channel, event.name);

        if (opts.reopened) {
            await this.slack.post(channel, [
                `<!here> *Reopened: ${escape(event.name)}*`,
                ...this.details(event, { reopened: true })
            ].join('\n'));
        }

        await this.status(channel, event, { mention: !opts.reopened });
    }
}
