import { ApplicationFlagsBitField, Client, GatewayIntentBits, Events, MessageFlags, REST, Routes } from 'discord.js';
import { commands, handleButton, handleCommand } from './src/commands.js';
import { protect } from './src/protection.js';

const token = (process.env.DISCORD_TOKEN || '').trim();
if (!token) {
  console.error('[moderation-bot] DISCORD_TOKEN is not set. Add your bot token in the FadeHost panel, under Environment variables.');
  process.exit(1);
}

const TOKEN_REJECTED = '[moderation-bot] Discord rejected DISCORD_TOKEN. Reset it at discord.com/developers, your app, Bot, Reset Token; paste the new one under Environment variables in the FadeHost panel and restart.';

// Which privileged intents are switched on in the Developer Portal. Server
// Members is required. Message Content is optional: without it the bot cannot
// read what messages say, so the copy-paste check is skipped and app spam is
// caught by how many channels it reaches rather than by what it says.
const app = await new REST().setToken(token).get(Routes.currentApplication()).catch((error) => {
  if (error.status === 401) {
    console.error(TOKEN_REJECTED);
    process.exit(1);
  }
  return null; // Discord did not answer: log in with every intent and let the login say what is wrong
});
const { Flags } = ApplicationFlagsBitField;
const appFlags = new ApplicationFlagsBitField(app?.flags ?? 0);
if (app && !appFlags.any([Flags.GatewayGuildMembers, Flags.GatewayGuildMembersLimited])) {
  console.error('[moderation-bot] The Server Members intent is off. Open discord.com/developers, your app, Bot, Privileged Gateway Intents, turn on SERVER MEMBERS INTENT and restart the bot.');
  process.exit(1);
}
const readsMessages = !app || appFlags.any([Flags.GatewayMessageContent, Flags.GatewayMessageContentLimited]);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages,
    ...(readsMessages ? [GatewayIntentBits.MessageContent] : []),
  ],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`[moderation-bot] online as ${c.user.tag} in ${c.guilds.cache.size} server(s)`);
  console.log(readsMessages
    ? '[moderation-bot] spam protection is on: app spam and copy-paste spam'
    : '[moderation-bot] spam protection is on for app spam. The copy-paste check stays off until you turn on MESSAGE CONTENT INTENT (discord.com/developers, your app, Bot, Privileged Gateway Intents) and restart.');
  c.user.setActivity('over the server', { type: 3 });
  try {
    await new REST().setToken(token).put(Routes.applicationCommands(c.user.id), { body: commands });
    console.log('[moderation-bot] slash commands registered');
  } catch (err) {
    console.error('[moderation-bot] failed to register commands:', err.message);
  }
});

// Every message the bot can see goes through the spam checks in src/protection.js.
client.on(Events.MessageCreate, (message) => {
  protect(message).catch((err) => console.error('[moderation-bot] spam check failed:', err));
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
  try {
    if (interaction.isButton()) await handleButton(interaction);
    else await handleCommand(interaction);
  } catch (err) {
    console.error('[moderation-bot] command error:', err);
    const text = 'That did not work. The bot needs the matching permission (Moderate Members, Kick Members, Ban Members, Manage Messages, Manage Roles, Manage Server) and a role above the member.';
    if (interaction.deferred) await interaction.editReply({ content: text }).catch(() => {});
    else if (!interaction.replied) await interaction.reply({ content: text, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.login(token).catch((error) => {
  if (String(error.code) === 'TokenInvalid' || String(error).includes('TOKEN_INVALID')) {
    console.error(TOKEN_REJECTED);
  } else if (String(error.code) === 'DisallowedIntents' || String(error).includes('disallowed intents')) {
    console.error('[moderation-bot] Discord refused a privileged intent. Open discord.com/developers, your app, Bot, Privileged Gateway Intents, turn on SERVER MEMBERS INTENT and MESSAGE CONTENT INTENT, and restart the bot.');
  } else {
    console.error(`[moderation-bot] Could not log in to Discord: ${error.message}`);
  }
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    client.destroy();
    process.exit(0);
  });
}
