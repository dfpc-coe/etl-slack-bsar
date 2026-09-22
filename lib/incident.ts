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

    constructor(slack: Slack, opts: { prefix: string, isPrivate: boolean, invite: string[] }) {
        this.slack = slack;
        this.prefix = opts.prefix;
        this.isPrivate = opts.isPrivate;
        this.invite = opts.invite;
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

    /**
     * Open the channel of an incident - reusing (and unarchiving) a channel of
     * the same name when the ephemeral store was reset, otherwise creating one
     */
    async open(event: IncidentEvent): Promise<IncidentChannel> {
        const name = this.channelName(event);

        let channel = await this.slack.create(name, this.isPrivate);

        if (!channel) {
            const existing = await this.slack.find(name);

            if (existing) {
                const active = await this.slack.ensureActive(existing.id);
                return { ...existing, reopened: active.state === 'unarchived' };
            }

            channel = await this.slack.create(this.channelName(event, `-${event.id.slice(0, 6)}`), this.isPrivate);
            if (!channel) throw new Error(`Slack conversations.create: name_taken`);
        }

        await this.slack.invite(channel.id, this.invite);

        return { ...channel, reopened: false };
    }

    /** Post the current state of the Event - a reopened channel always states the remarks, even when empty */
    async announce(channel: string, event: IncidentEvent, opts: { reopened?: boolean } = {}): Promise<void> {
        const [lng, lat] = event.geometry.coordinates;

        const lines = [
            opts.reopened ? `*Reopened: ${event.name}*` : `*${event.name}*`,
            event.priority ? `Priority: ${event.priority}` : null,
            event.location ? `Location: ${event.location}` : null,
            `Coordinates: ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
            opts.reopened ? `Remarks: ${event.remarks || 'none'}` : (event.remarks || null)
        ].filter(Boolean);

        await this.slack.setTopic(channel, event.name);
        await this.slack.post(channel, lines.join('\n'));
    }
}
