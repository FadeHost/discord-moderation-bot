# FadeHost Moderation Bot

[![Deploy to FadeHost](https://fadehost.com/deploy-button.svg)](https://laplace.fadehost.com/register?intent=bot&repo=https://github.com/FadeHost/discord-moderation-bot)

Warnings that are remembered, timeouts, kicks, bans, message purges and slowmode, every action logged to a channel of your choice.

## Setup on FadeHost
1. Create a bot at https://discord.com/developers/applications: New Application, Bot, Reset Token.
2. Under Bot, Privileged Gateway Intents, turn on **Server Members Intent**.
3. Invite it with the `bot` and `applications.commands` scopes and the **Moderate Members**, **Kick Members**, **Ban Members**, **Manage Messages** and **Manage Channels** permissions. Put the bot's role above the members it should act on.
4. In your FadeHost panel, deploy the **Moderation Bot** template and paste the token as `DISCORD_TOKEN`.
5. In Discord, run `/modlog #mod-log` so every action leaves a trace.

## Commands
| Command | What it does |
|---|---|
| `/warn user reason` | Warns the member (they get a direct message) and remembers it. |
| `/warnings user` | The member's warnings. |
| `/clearwarnings user` | Forgets them. |
| `/timeout user minutes [reason]` | Times the member out, up to four weeks. |
| `/untimeout user` | Ends a timeout. |
| `/kick user [reason]` | Kicks the member. |
| `/ban user [reason] [delete_days]` | Bans the member, optionally deleting their recent messages. |
| `/unban user_id` | Lifts a ban. |
| `/purge amount [from]` | Deletes the last messages in the channel (Discord keeps ones older than two weeks). |
| `/slowmode seconds` | Slows the channel down; 0 turns it off. |
| `/modlog [#channel]` | Where actions are logged. |

Who may use what follows the server's own permissions: a member without Ban Members cannot see `/ban`.

## Environment variables
| Variable | Default | What it does |
|---|---|---|
| `DISCORD_TOKEN` | | **Required.** Your bot token. |
| `MODLOG_CHANNEL_ID` | | Optional default log channel (or use `/modlog`). |

Warnings and settings are saved to the bot's persistent storage, so they survive restarts.

Built and maintained by [FadeHost](https://fadehost.com). MIT licensed.
