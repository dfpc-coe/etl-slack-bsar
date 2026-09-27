import type { Static, TSchema } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import { fetch } from '@tak-ps/etl';

const SLACK_API = 'https://slack.com/api';

export const SlackChannelInfo = Type.Object({
    id: Type.String(),
    name: Type.String(),
    is_archived: Type.Optional(Type.Boolean()),
    purpose: Type.Optional(Type.Object({
        value: Type.String()
    }))
});

const SlackResponse = Type.Object({
    ok: Type.Boolean(),
    error: Type.Optional(Type.String())
});

const SlackChannel = Type.Object({
    ok: Type.Boolean(),
    error: Type.Optional(Type.String()),
    channel: Type.Optional(SlackChannelInfo)
});

const SlackChannelList = Type.Object({
    ok: Type.Boolean(),
    error: Type.Optional(Type.String()),
    channels: Type.Optional(Type.Array(SlackChannelInfo)),
    response_metadata: Type.Optional(Type.Object({
        next_cursor: Type.Optional(Type.String())
    }))
});

export const SlackBookmark = Type.Object({
    id: Type.String(),
    title: Type.String(),
    link: Type.Optional(Type.String())
});

const SlackBookmarkList = Type.Object({
    ok: Type.Boolean(),
    error: Type.Optional(Type.String()),
    bookmarks: Type.Optional(Type.Array(SlackBookmark))
});

const SlackPosted = Type.Object({
    ok: Type.Boolean(),
    error: Type.Optional(Type.String()),
    ts: Type.Optional(Type.String({ description: 'Timestamp of the message - the ID it is updated & pinned by' }))
});

export const SlackMessage = Type.Object({
    ts: Type.String(),
    text: Type.Optional(Type.String())
});

const SlackPinList = Type.Object({
    ok: Type.Boolean(),
    error: Type.Optional(Type.String()),
    items: Type.Optional(Type.Array(Type.Object({
        message: Type.Optional(SlackMessage)
    })))
});

const SlackUserGroupList = Type.Object({
    ok: Type.Boolean(),
    error: Type.Optional(Type.String()),
    usergroups: Type.Optional(Type.Array(Type.Object({
        id: Type.String(),
        handle: Type.String({ description: 'Mention handle without the @ - ie: sar-team' }),
        name: Type.String({ description: 'Display name - ie: SAR Team' }),
        users: Type.Optional(Type.Array(Type.String()))
    })))
});

const SlackAuth = Type.Object({
    ok: Type.Boolean(),
    error: Type.Optional(Type.String()),
    url: Type.Optional(Type.String({ description: 'Workspace URL - ie: https://example.slack.com/' })),
    user_id: Type.Optional(Type.String({ description: 'Slack User ID the token acts as' }))
});

export type ChannelState =
    { state: 'active' | 'unarchived', channel: Static<typeof SlackChannelInfo> }
    | { state: 'missing' };

/**
 * Thin client over the Slack Web API conversation & chat methods this task uses,
 * acting as the User (or Bot) the token belongs to
 */
export default class Slack {
    token: string;
    identity?: Promise<{ url: string, user: string }>;

    constructor(token: string) {
        this.token = token;
    }

    /** Workspace URL & User ID of the token, looked up once per invocation */
    async self(): Promise<{ url: string, user: string }> {
        if (!this.identity) {
            this.identity = this.call('auth.test', SlackAuth).then((auth) => {
                if (!auth.ok || !auth.url || !auth.user_id) throw new Error(`Slack auth.test: ${auth.error}`);
                return { url: auth.url, user: auth.user_id };
            });
        }

        return await this.identity;
    }

    /** Form encoded, as Slack read methods (conversations.info/list) reject JSON bodies with invalid_arguments */
    async call<T extends TSchema>(
        method: string,
        schema: T,
        body: Record<string, string | number | boolean> = {}
    ): Promise<Static<T>> {
        const form = new URLSearchParams();
        for (const [key, value] of Object.entries(body)) form.set(key, String(value));

        const res = await fetch(`${SLACK_API}/${method}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: form.toString()
        });

        return await res.typed(schema);
    }

    /** Create a channel - returns null if the name is already taken */
    async create(name: string, isPrivate: boolean): Promise<Static<typeof SlackChannelInfo> | null> {
        const res = await this.call('conversations.create', SlackChannel, { name, is_private: isPrivate });

        if (res.error === 'name_taken') return null;
        if (!res.ok || !res.channel) throw new Error(`Slack conversations.create: ${res.error}`);

        return res.channel;
    }

    /** Look up a channel by name, archived or not */
    async find(name: string): Promise<Static<typeof SlackChannelInfo> | null> {
        let cursor: string | undefined;

        do {
            const res = await this.call('conversations.list', SlackChannelList, {
                types: 'public_channel,private_channel',
                exclude_archived: false,
                limit: 1000,
                ...(cursor ? { cursor } : {})
            });

            if (!res.ok) throw new Error(`Slack conversations.list: ${res.error}`);

            const match = (res.channels || []).find((c) => c.name === name);
            if (match) return match;

            cursor = res.response_metadata?.next_cursor || undefined;
        } while (cursor);

        return null;
    }

    /** Look up a channel by ID - null if Slack no longer knows it */
    async info(channel: string): Promise<Static<typeof SlackChannelInfo> | null> {
        const res = await this.call('conversations.info', SlackChannel, { channel });

        if (res.error === 'channel_not_found') return null;
        if (!res.ok || !res.channel) throw new Error(`Slack conversations.info: ${res.error}`);

        return res.channel;
    }

    /** Ensure a channel is usable, unarchiving it if needed - `missing` if Slack no longer knows it */
    async ensureActive(channel: string): Promise<ChannelState> {
        const info = await this.info(channel);

        if (!info) return { state: 'missing' };
        if (!info.is_archived) return { state: 'active', channel: info };

        const res = await this.call('conversations.unarchive', SlackResponse, { channel });
        if (!res.ok && res.error !== 'not_archived') throw new Error(`Slack conversations.unarchive: ${res.error}`);

        return { state: 'unarchived', channel: info };
    }

    async archive(channel: string): Promise<'archived' | 'already_archived' | 'missing'> {
        const res = await this.call('conversations.archive', SlackResponse, { channel });

        if (res.ok) return 'archived';
        if (res.error === 'already_archived') return 'already_archived';
        if (res.error === 'channel_not_found') return 'missing';

        throw new Error(`Slack conversations.archive: ${res.error}`);
    }

    /** Invite users to a channel - the token's own User is already a member of channels it creates */
    async invite(channel: string, users: string[]): Promise<void> {
        const self = await this.self();
        const others = [...new Set(users)].filter((user) => user !== self.user);
        if (!others.length) return;

        // force => keep inviting the valid IDs when one is deactivated or already a member
        const res = await this.call('conversations.invite', SlackResponse, { channel, users: others.join(','), force: true });
        if (!res.ok) console.error(`not ok - Slack conversations.invite: ${res.error}`);
    }

    /** Member User IDs of a User Group, matched by @handle or display name - requires the usergroups:read scope */
    async usergroupMembers(name: string): Promise<string[]> {
        const wanted = name.trim().replace(/^@/, '').toLowerCase();

        const res = await this.call('usergroups.list', SlackUserGroupList, { include_users: true, include_disabled: false });
        if (!res.ok) throw new Error(`Slack usergroups.list: ${res.error}`);

        const group = (res.usergroups || []).find((g) => {
            return g.handle.toLowerCase() === wanted || g.name.trim().toLowerCase() === wanted;
        });

        if (!group) throw new Error(`Slack User Group "${name}" not found`);

        return group.users || [];
    }

    /** Bookmarks of a channel - requires the bookmarks:read scope */
    async bookmarks(channel: string): Promise<Array<Static<typeof SlackBookmark>>> {
        const res = await this.call('bookmarks.list', SlackBookmarkList, { channel_id: channel });
        if (!res.ok) throw new Error(`Slack bookmarks.list: ${res.error}`);

        return res.bookmarks || [];
    }

    /** Add a link bookmark to a channel - requires the bookmarks:write scope */
    async addBookmark(channel: string, title: string, link: string): Promise<void> {
        const res = await this.call('bookmarks.add', SlackResponse, { channel_id: channel, type: 'link', title, link });
        if (!res.ok) console.error(`not ok - Slack bookmarks.add: ${res.error}`);
    }

    async editBookmark(channel: string, bookmark: string, title: string): Promise<void> {
        const res = await this.call('bookmarks.edit', SlackResponse, { channel_id: channel, bookmark_id: bookmark, title });
        if (!res.ok) console.error(`not ok - Slack bookmarks.edit: ${res.error}`);
    }

    async setPurpose(channel: string, purpose: string): Promise<void> {
        const res = await this.call('conversations.setPurpose', SlackResponse, { channel, purpose: purpose.slice(0, 250) });
        if (!res.ok) console.error(`not ok - Slack conversations.setPurpose: ${res.error}`);
    }

    async setTopic(channel: string, topic: string): Promise<void> {
        const res = await this.call('conversations.setTopic', SlackResponse, { channel, topic: topic.slice(0, 250) });
        if (!res.ok) console.error(`not ok - Slack conversations.setTopic: ${res.error}`);
    }

    /** Post a message - returns its timestamp, null if it could not be posted */
    async post(channel: string, text: string): Promise<string | null> {
        const res = await this.call('chat.postMessage', SlackPosted, { channel, text, unfurl_links: false });

        if (!res.ok || !res.ts) {
            console.error(`not ok - Slack chat.postMessage: ${res.error}`);
            return null;
        }

        return res.ts;
    }

    /** Rewrite a message - `uneditable` if it was deleted or the workspace no longer allows editing it */
    async update(channel: string, ts: string, text: string): Promise<'updated' | 'uneditable'> {
        const res = await this.call('chat.update', SlackPosted, { channel, ts, text });

        if (res.ok) return 'updated';
        if (['message_not_found', 'cant_update_message', 'edit_window_closed'].includes(res.error || '')) return 'uneditable';

        throw new Error(`Slack chat.update: ${res.error}`);
    }

    /** Pinned messages of a channel - requires the pins:read scope */
    async pins(channel: string): Promise<Array<Static<typeof SlackMessage>>> {
        const res = await this.call('pins.list', SlackPinList, { channel });
        if (!res.ok) throw new Error(`Slack pins.list: ${res.error}`);

        return (res.items || []).flatMap((item) => item.message ? [item.message] : []);
    }

    /** Pin a message to a channel - requires the pins:write scope */
    async pin(channel: string, ts: string): Promise<void> {
        const res = await this.call('pins.add', SlackResponse, { channel, timestamp: ts });
        if (!res.ok && res.error !== 'already_pinned') console.error(`not ok - Slack pins.add: ${res.error}`);
    }

    async unpin(channel: string, ts: string): Promise<void> {
        const res = await this.call('pins.remove', SlackResponse, { channel, timestamp: ts });
        if (!res.ok && res.error !== 'no_pin') console.error(`not ok - Slack pins.remove: ${res.error}`);
    }

    /** Permalink of a channel in the workspace the token belongs to */
    async channelUrl(channel: string): Promise<string> {
        return new URL(`/archives/${channel}`, (await this.self()).url).toString();
    }
}
