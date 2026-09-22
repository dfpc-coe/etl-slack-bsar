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

