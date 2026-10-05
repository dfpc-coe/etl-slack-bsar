<h1 align='center'>ETL-Slack-BSAR</h1>

<p align='center'>Create a Slack channel for every SAR CoreEvent placed on a CloudTAK Board or created in a TAK Server Channel</p>

## Flow

This is an Outgoing only task. The `TRIGGER` environment picks what starts the Slack flow:

- **Board Placement** - subscribe to `board:event:*`, `event:update` & `event:delete`. When a CoreEvent is placed on the configured Board,
  and its type is one of the configured SAR types, a channel is opened. Moving the Event on the Board revives an
  archived channel and removing it from the Board archives the channel, keeping the mapping so a re-placed Event
  gets the same channel back.
- **Channel Event** - subscribe to `event:*`. When a CoreEvent is created in the configured TAK Server Channel, and its
  type is one of the configured SAR types, a channel is opened. The Layer's Connection must also be a member of the
  Channel for the Event to be delivered to the Layer.

In both modes the channel is named `<prefix>-<date>-<event name>`, the configured users and User Group members are
invited, and the Event details are posted as a pinned message. The pinned message is rewritten with the current details
whenever the CoreEvent is updated, and the channel is archived when the CoreEvent is deleted.

The URL of the created channel is then appended to the `links` of the CoreEvent, and the `links` of the CoreEvent are
mirrored as bookmarks of the channel - kept up to date whenever the CoreEvent is updated. Bookmarks are added and
retitled but never removed.

Created channels are tracked in the Layer's ephemeral store by CoreEvent ID so an Event never gets a second channel.

| Permission | Required | Description |
| ---------- | -------- | ----------- |
| `event:read`, `event:update` | No | Append the Slack channel URL to the links of the CoreEvent |

| Environment | Description |
| ----------- | ----------- |
| `SLACK_TOKEN` | Slack Bot User OAuth Token (`xoxb-`) with `channels:manage`, `channels:read`, `groups:write`, `groups:read`, `chat:write`, `pins:read`, `pins:write`, `bookmarks:read`, `bookmarks:write` & `usergroups:read` scopes - see [Slack Installation](#slack-installation). A User OAuth Token (`xoxp-`) with the equivalent user scopes (`channels:write` in place of `channels:manage`) also works, in which case channels are created & messages posted as that User |
| `SLACK_PRIVATE` | Create private channels instead of public ones |
| `SLACK_PREFIX` | Prefix of created channel names |
| `SLACK_INVITE` | Slack User IDs invited to every created channel |
| `SLACK_USERGROUP` | Optional Slack User Group, by `@handle` or name, whose members are invited to every created channel - User Groups are a paid Slack feature |
| `TRIGGER` | **Board Placement** with the ID of the CoreEvent Board to watch, or **Channel Event** with the TAK Server Channel ID (bitpos) to watch |
| `SAR_TYPES` | MIL-STD-2525E Symbol IDs considered SAR - every Event is accepted if empty |

## Slack Installation

The ETL authenticates as the App's Bot User via a Bot User OAuth Token. Channels are created & messages posted as the
Bot, which is automatically a member of every channel it creates.

1. Navigate to [Slack App Management](https://app.slack.com/apps-manage/) and select the workspace you want to install
   the integration into
2. Select **Build** in the top right corner
3. From the **Your Apps** page click the green **Create New App** button & select **From a manifest**
4. Select the workspace, then paste the following manifest into the JSON tab

```json
{
    "display_information": {
        "name": "CloudTAK BSAR",
        "description": "Create a Slack channel for every SAR CoreEvent placed on a CloudTAK Board or created in a TAK Server Channel",
        "background_color": "#1f2937"
    },
    "features": {
        "bot_user": {
            "display_name": "CloudTAK BSAR",
            "always_online": true
        }
    },
    "oauth_config": {
        "scopes": {
            "bot": [
                "channels:read",
                "channels:manage",
                "groups:read",
                "groups:write",
                "chat:write",
                "pins:read",
                "pins:write",
                "bookmarks:read",
                "bookmarks:write",
                "usergroups:read"
            ]
        }
    },
    "settings": {
        "org_deploy_enabled": false,
        "socket_mode_enabled": false,
        "token_rotation_enabled": false
    }
}
```

5. Review the App summary and then select **Create & Install**
6. Click **Go To App Settings**, select **OAuth & Permissions** on the left, and copy the **Bot User OAuth Token**
   (`xoxb-`) into the `SLACK_TOKEN` field of the CloudTAK Layer

## Development

DFPC provided Lambda ETLs are currently all written in [NodeJS](https://nodejs.org/en) through the use of a AWS Lambda optimized
Docker container. Documentation for the Dockerfile can be found in the [AWS Help Center](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)

```sh
npm install
```

Add a .env file in the root directory that gives the ETL script the necessary variables to communicate with a local ETL server.
When the ETL is deployed the `ETL_API` and `ETL_LAYER` variables will be provided by the Lambda Environment

```json
{
    "ETL_API": "http://localhost:5001",
    "ETL_LAYER": "19"
}
```

To run the task, ensure the local [CloudTAK](https://github.com/dfpc-coe/CloudTAK/) server is running and then run with typescript runtime
or build to JS and run natively with node

```
ts-node task.ts
```

```
npm run build
cp .env dist/
node dist/task.js
```

### Deployment

Deployment into the CloudTAK environment for configuration is done via automatic releases to the DFPC AWS environment.

Github actions will build and push docker releases on every version tag which can then be automatically configured via the
CloudTAK API.

Builds are performed by the `cloudtak-etl` script provided by [`@tak-ps/etl`](https://github.com/dfpc-coe/etl-base).
It requires a `capabilities.json` document alongside the `Dockerfile` which describes the task (name, description,
compute requirements, permissions & invocation types) and is validated and embedded in the OCI Image Manifest as a
`com.cloudtak.capabilities` annotation so CloudTAK can read it directly from ECR before the task is ever deployed.
Update `capabilities.json` whenever the task's requirements change.

To build & push manually:

```sh
export AWS_REGION='us-east-1'
export AWS_ACCOUNT_ID='123456789012'
export Environment='prod' # Optional - defaults to prod

npx cloudtak-etl
```

Non-DFPC users will need to setup their own docker => ECS build system via something like Github Actions or AWS Codebuild.
