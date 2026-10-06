# CHANGELOG

## Emoji Cheatsheet
- :pencil2: doc updates
- :bug: when fixing a bug
- :rocket: when making general improvements
- :white_check_mark: when adding tests
- :arrow_up: when upgrading dependencies
- :tada: when adding new features

## Version History

### Pending Release

### v1.9.0

- :rocket: Open the channel of a CoreEvent on `event:update` when it qualifies for the trigger but has none - recovering from a missed or failed `event:create`/`board:event:create` or a channel Slack no longer knows. In Board mode the Event must be placed on the configured Board
- :rocket: In Channel mode an `event:update` reopens the archived channel of a CoreEvent, as a Board placement does in Board mode
- :pencil2: Install the Slack App with user scopes & a User OAuth Token (`xoxp-`) instead of a Bot User - the manifest no longer declares a `bot_user` and `SLACK_TOKEN` documents the user token first

### v1.8.1

- :rocket: Use channel name instead of int

### v1.8.0

- :tada: Replace `BOARD` with a `TRIGGER` union rendered as a variant picker - **Board Placement** keeps the existing Board flow while **Channel Event** opens a channel for every SAR CoreEvent created in a TAK Server Channel, requiring an `event:create` subscription
- :tada: Subscribe to `event:delete` to archive the Slack channel of a CoreEvent when the CoreEvent is deleted
- :rocket: Layers configured with a top level `BOARD` keep working as a Board Placement trigger

### v1.7.0

- :tada: Post the details of a CoreEvent as a pinned message of its Slack channel and rewrite it on every `event:update` - requiring the `pins:read` & `pins:write` scopes
- :tada: Subscribe to `event:update` and mirror the Links of a CoreEvent as bookmarks of its Slack channel - also set when a channel is opened or reopened - requiring the `bookmarks:read` & `bookmarks:write` scopes

### v1.6.1

- :rocket: The announcement posted when a channel is opened or reopened now mentions `@here`

### v1.6.0

- :rocket: Set Channel Purpose to the CoreEvent ID so a channel of the same name is only reused for that same Event, otherwise the ID-suffixed name is used

### v1.5.0

- :tada: Add optional `SLACK_USERGROUP` - members of the Slack User Group (by `@handle` or name) are invited to every created channel alongside `SLACK_INVITE`, requiring the `usergroups:read` scope
- :rocket: Invite with `force` so one deactivated or already-present User no longer blocks the rest of the invite
- :bug: Two Events with the same name on the same day no longer share a channel - the channel purpose records the CoreEvent ID and a name-matched channel is only reused when it was opened for that same Event, otherwise the ID-suffixed name is used

### v1.4.1

- :rocket: Remove the Slack invite link added in v1.4.0 - `conversations.inviteShared` is Bot token only and Bots must name recipients, so no token type can mint a shareable link
- :rocket: Act as a Slack User OAuth Token (`xoxp-`) rather than a Bot token - channels are created & messages posted as that User, who is skipped when inviting `SLACK_INVITE` users as they already belong to channels they create

### v1.4.0

- :tada: Add a shareable Slack invite link to the CoreEvent alongside the channel link when the bot has the `conversations.connect:write` scope
- :rocket: Split the Slack client, incident channel handling & CoreEvent linking into `lib/` so `task.ts` reads as the decision flow
- :rocket: Ensure the Slack channel link is present on the CoreEvent on every Board create or update, not only when the channel is first created

### v1.3.1

- :bug: Send Slack requests form encoded - read methods such as `conversations.info` reject JSON bodies

### v1.3.0

- :tada: Archive the Slack channel when its CoreEvent is removed from the Board (`board:event:delete`)
- :rocket: Post a `Reopened` announcement with the current remarks when a channel is unarchived

### v1.2.0

- :tada: Unarchive the Slack channel of a re-created or updated CoreEvent instead of skipping it, reusing a channel of the same name when the ephemeral store was reset
- :rocket: Subscribe to `board:event:update` so moving an Event on the Board also revives its channel

### v1.1.2

- :rocket: Log why each outgoing message is skipped when `DEBUG` is enabled

### v1.1.1

- :rocket: Add Capabilities doc

### v1.1.0

- :rocket: Build & push via `cloudtak-etl` so `capabilities.json` is annotated onto the OCI manifest
- :tada: Add starter `capabilities.json`
- :arrow_up: Update Github Actions to current versions & run build/test in CI

### v1.0.0

- :rocket: Initial Approach

