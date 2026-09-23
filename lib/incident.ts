import type { Static } from '@sinclair/typebox';
import type Slack from './slack.js';
import type { SlackChannelInfo } from './slack.js';
import type { IncidentEvent } from './cloudtak.js';

export type IncidentChannel = Static<typeof SlackChannelInfo> & { reopened: boolean };

/**
 * The Slack channel of a SAR incident - naming, opening & announcing
 */
export default class Incidents {
    slack: Slack;
    prefix: string;
    isPrivate: boolean;
    invite: string[];
    usergroup?: string;
    members?: Promise<string[]>;

    constructor(slack: Slack, opts: { prefix: string, isPrivate: boolean, invite: string[], usergroup?: string }) {
        this.slack = slack;
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
     * Post the current state of the Event, notifying everyone in the channel
     * with @here - a reopened channel always states the remarks, even when empty
     */
    async announce(channel: string, event: IncidentEvent, opts: { reopened?: boolean } = {}): Promise<void> {
        const [lng, lat] = event.geometry.coordinates;

        const lines = [
            opts.reopened ? `<!here> *Reopened: ${event.name}*` : `<!here> *${event.name}*`,
            event.priority ? `Priority: ${event.priority}` : null,
            event.location ? `Location: ${event.location}` : null,
            `Coordinates: ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
            opts.reopened ? `Remarks: ${event.remarks || 'none'}` : (event.remarks || null)
        ].filter(Boolean);

        await this.slack.setTopic(channel, event.name);
        await this.slack.post(channel, lines.join('\n'));
    }
}
