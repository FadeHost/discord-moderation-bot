# FadeHost Moderation Bot

[![Deploy to FadeHost](https://fadehost.com/deploy-button.svg)](https://laplace.fadehost.com/register?intent=bot&repo=https://github.com/FadeHost/discord-moderation-bot)

Automatic spam protection, a security check that fixes risky server settings, Discord AutoMod in one command, and the everyday tools: warnings that are remembered, timeouts, kicks, bans, message purges and slowmode, every action logged to a channel of your choice.

## Setup on FadeHost
1. Create a bot at https://discord.com/developers/applications: New Application, Bot, Reset Token.
2. Under Bot, Privileged Gateway Intents, turn on **Server Members Intent** (required) and **Message Content Intent** (recommended: without it the bot cannot read messages, so it cannot spot copy-paste spam or judge spam by what it says).
3. Invite it with this link, with your Application ID (on the General Information page) in place of `YOUR_APP_ID`:
   `https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=1099780156470`
   It asks for View Channels, Send Messages, Embed Links, Read Message History, Manage Messages, Moderate Members, Kick Members, Ban Members, Manage Channels, Manage Roles and Manage Server. Then, in Server Settings, Roles, drag the bot's role above the roles your members have.
4. In your FadeHost panel, deploy the **Moderation Bot** template and paste the token as `DISCORD_TOKEN`.
5. In Discord, run `/securitycheck` and use its fix buttons, then `/automod-setup`.

Already running an older version? Redeploy it in the FadeHost panel, open the invite link above again to grant Manage Roles and Manage Server, and turn on the Message Content intent. Warnings and settings carry over.

## Automatic spam protection
It is on from the start. When it catches something, it deletes the spam, times the person out for a day and logs it with a copy of the message. Staff (anyone with Manage Messages, Moderate Members, Kick or Ban Members, Manage Channels, Manage Roles, Manage Server or Administrator) are never checked.

- **App spam.** Members can run apps installed on their own Discord account, not on your server, and have them post in your channels. Discord does not show who ran such an app; the bot reads it from the message and acts on that person. It steps in when their apps post in 3 channels or 10 times within a minute, or post @everyone with an invite link (that last check needs the Message Content intent).
- **Copy-paste spam.** The same message from one member in 3 channels within 30 seconds, the usual sign of a hacked account. Every copy goes, and the member gets a direct message telling them to change their password. A stricter server can lower it to 2 channels with `/protection copy_channels:2` (anything from 2 to 10) and give the copies longer with `copy_within`, up to an hour: 2 channels within 10 minutes also catches a member pasting one question into several channels. A deleted copy stops counting, so a member who deletes a post and asks again in the right channel is left alone. This check needs the Message Content intent and is skipped without it.

Each log entry has a **Remove timeout** button for mistakes and a **Ban** button that asks before it bans. `/protection` shows the settings and changes them: turn either check off, set how many channels the same message may reach and in how much time, set the timeout length, or ban instead of timing out. Banning is off by default, because a ban given by mistake is much harder to undo than a timeout.

## What /securitycheck looks for
- **Use External Apps** on for @everyone or a role ordinary members have. Discord turns it on by default, and it is how app spam gets in: with it off, apps members installed on their own account only answer the person who ran them. Fix button.
- **@everyone may mention @everyone**, so one hacked account can ping the whole server. Fix button.
- **The bot is missing permissions**, or cannot see channels members post in.
- **The bot's role is below roles your members have**, so it cannot time them out. Discord does not let a bot raise its own role: drag it up in Server Settings, Roles.
- **No moderation log.** Fix button: creates a private #mod-log.
- **No AutoMod rule** against invite links or mention spam. Fix button.
- **The Message Content intent is off**, with a link to where you turn it on.

Every fix button first shows exactly what it will change and asks you to confirm.

## Commands
| Command | What it does |
|---|---|
| `/securitycheck` | Lists risky server settings, each with a fix button. |
| `/automod-setup [allow]` | Creates Discord AutoMod rules: invite links to other servers are blocked (your server's own invites, and any you list, stay allowed), and so are messages with more than 10 mentions. Run it again to refresh. |
| `/protection [app_spam] [copy_spam] [copy_channels] [copy_within] [timeout_minutes] [ban]` | Shows the automatic spam protection, and changes it. |
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

Who may use what follows the server's own permissions: a member without Ban Members cannot see `/ban`, and the first three commands need Manage Server.

## Environment variables
| Variable | Default | What it does |
|---|---|---|
| `DISCORD_TOKEN` | | **Required.** Your bot token. |
| `MODLOG_CHANNEL_ID` | | Optional default log channel (or use `/modlog`). |

Warnings and settings are saved to the bot's persistent storage, so they survive restarts.

Built and maintained by [FadeHost](https://fadehost.com). MIT licensed.
