import { Client, GatewayIntentBits, Events, REST, Routes } from 'discord.js';
import { commands, handleCommand } from './src/commands.js';

const token = (process.env.DISCORD_TOKEN || '').trim();
if (!token) {
  console.error('[moderation-bot] DISCORD_TOKEN is not set. Add your bot token in the FadeHost panel, under Environment variables.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages] });

client.once(Events.ClientReady, async (c) => {
  console.log(`[moderation-bot] online as ${c.user.tag} in ${c.guilds.cache.size} server(s)`);
  c.user.setActivity('over the server', { type: 3 });
  try {
    await new REST().setToken(token).put(Routes.applicationCommands(c.user.id), { body: commands });
    console.log('[moderation-bot] slash commands registered');
  } catch (err) {
    console.error('[moderation-bot] failed to register commands:', err.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleCommand(interaction);
  } catch (err) {
    console.error('[moderation-bot] command error:', err);
    const text = 'That did not work. The bot needs the matching permission (Moderate Members, Kick Members, Ban Members, Manage Messages) and a role above the member.';
    if (interaction.deferred) await interaction.editReply({ content: text }).catch(() => {});
    else if (!interaction.replied) await interaction.reply({ content: text, ephemeral: true }).catch(() => {});
  }
});

client.login(token).catch((error) => {
  if (String(error.code) === 'TokenInvalid' || String(error).includes('TOKEN_INVALID')) {
    console.error('[moderation-bot] Discord rejected DISCORD_TOKEN. Reset it at discord.com/developers, your app, Bot, Reset Token; paste the new one under Environment variables in the FadeHost panel and restart.');
  } else if (String(error.code) === 'DisallowedIntents' || String(error).includes('disallowed intents')) {
    console.error('[moderation-bot] Discord refused the Server Members intent. Open discord.com/developers, your app, Bot, Privileged Gateway Intents, turn on SERVER MEMBERS INTENT and restart the bot.');
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
