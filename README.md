# ainconv-discord

## Installation

### Use the hosted bot
* [Add the running BOT to Discord](https://discord.com/oauth2/authorize?client_id=1301574269704081568&permissions=0&integration_type=0&scope=bot+applications.commands)

### Self-host the bot

#### Prerequisites

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a bot in the application
3. Copy the bot token
4. Set the bot token as the `DISCORD_TOKEN`, application ID as `DISCORD_APPLICATION_ID`, and guild ID as `DISCORD_GUILD_ID` environment variables (usually by adding them to the `.env` file)

#### With Docker
1. Install and Setup Docker
2. Run the bot with `docker compose up`

#### Without Docker

1. Deploy the commands with `bun run deploy`
2. Run the bot with `bun start`

## Development

```bash
bun i
bun start
```
