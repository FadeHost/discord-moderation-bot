import { ChannelType, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getGuild, save } from './store.js';

const reason = (o) => o.setName('reason').setDescription('Why').setMaxLength(400);
const user = (o) => o.setName('user').setDescription('Who').setRequired(true);

export const commands = [
  new SlashCommandBuilder().setName('warn').setDescription('Warn a member; the warning is kept').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(user).addStringOption((o) => reason(o).setRequired(true)),
  new SlashCommandBuilder().setName('warnings').setDescription('The warnings a member has').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).addUserOption(user),
  new SlashCommandBuilder().setName('clearwarnings').setDescription('Forget a member\'s warnings').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).addUserOption(user),
  new SlashCommandBuilder().setName('timeout').setDescription('Time a member out').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(user).addIntegerOption((o) => o.setName('minutes').setDescription('How long, 1 to 40320 (four weeks)').setMinValue(1).setMaxValue(40320).setRequired(true)).addStringOption(reason),
  new SlashCommandBuilder().setName('untimeout').setDescription('End a member\'s timeout').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).addUserOption(user),
  new SlashCommandBuilder().setName('kick').setDescription('Kick a member').setDefaultMemberPermissions(PermissionFlagsBits.KickMembers).addUserOption(user).addStringOption(reason),
  new SlashCommandBuilder().setName('ban').setDescription('Ban a member').setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(user).addStringOption(reason).addIntegerOption((o) => o.setName('delete_days').setDescription('Also delete their messages from the last N days (0 to 7)').setMinValue(0).setMaxValue(7)),
  new SlashCommandBuilder().setName('unban').setDescription('Lift a ban').setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((o) => o.setName('user_id').setDescription('The banned user\'s id').setRequired(true)),
  new SlashCommandBuilder().setName('purge').setDescription('Delete the last messages in this channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((o) => o.setName('amount').setDescription('How many, 1 to 100 (messages older than two weeks stay)').setMinValue(1).setMaxValue(100).setRequired(true))
    .addUserOption((o) => o.setName('from').setDescription('Only messages by this member')),
  new SlashCommandBuilder().setName('slowmode').setDescription('Slow this channel down').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption((o) => o.setName('seconds').setDescription('Seconds between messages, 0 turns it off').setMinValue(0).setMaxValue(21600).setRequired(true)),
  new SlashCommandBuilder().setName('modlog').setDescription('Where moderation actions are logged').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName('channel').setDescription('The channel, or leave it out to stop logging').addChannelTypes(ChannelType.GuildText)),
].map((c) => c.toJSON());

const COLORS = { warn: 0xfee75c, timeout: 0xe67e22, untimeout: 0x57f287, kick: 0xed4245, ban: 0x992d22, unban: 0x57f287, purge: 0x5865f2, clearwarnings: 0x57f287 };

async function log(interaction, settings, action, target, details) {
  if (!settings.logChannelId) return;
  const channel = interaction.guild.channels.cache.get(settings.logChannelId);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setTitle(action)
    .setColor(COLORS[action] ?? 0x99aab5)
    .addFields(
      { name: 'Target', value: target ? `<@${target.id}> (${target.tag ?? target.id})` : '-', inline: true },
      { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
      ...(details ? [{ name: 'Details', value: details.slice(0, 1000) }] : []),
    )
    .setTimestamp();
  await channel.send({ embeds: [embed] }).catch((err) => console.error('[moderation-bot] log not posted:', err.message));
}

async function tell(target, guild, text) {
  await target.send(`**${guild.name}:** ${text}`).catch(() => {});
}

/** The bot can only act below its own top role, and a moderator only below theirs. */
function canActOn(interaction, member) {
  if (!member) return { ok: true };
  if (member.id === interaction.guild.ownerId) return { ok: false, why: 'That is the server owner.' };
  const me = interaction.guild.members.me;
  if (me && member.roles.highest.position >= me.roles.highest.position) return { ok: false, why: 'That member\'s role is above the bot\'s role.' };
  if (interaction.member.roles?.highest && member.roles.highest.position >= interaction.member.roles.highest.position && interaction.user.id !== interaction.guild.ownerId) {
    return { ok: false, why: 'That member\'s role is not below yours.' };
  }
  return { ok: true };
}

export async function handleCommand(interaction) {
  const settings = await getGuild(interaction.guildId);
  const name = interaction.commandName;

  if (name === 'modlog') {
    const channel = interaction.options.getChannel('channel');
    settings.logChannelId = channel ? channel.id : null;
    await save();
    await interaction.reply({ content: channel ? `Moderation actions are logged in <#${channel.id}>.` : 'Moderation logging is off.', ephemeral: true });
    return;
  }

  if (name === 'purge') {
    const amount = interaction.options.getInteger('amount');
    const from = interaction.options.getUser('from');
    await interaction.deferReply({ ephemeral: true });
    const fetched = await interaction.channel.messages.fetch({ limit: 100 });
    const cutoff = Date.now() - 13 * 24 * 3600 * 1000;
    const candidates = [...fetched.values()].filter((m) => m.createdTimestamp > cutoff && (!from || m.author.id === from.id)).slice(0, amount);
    const deleted = await interaction.channel.bulkDelete(candidates, true);
    await interaction.editReply({ content: `Deleted ${deleted.size} message(s).` });
    await log(interaction, settings, 'purge', from, `${deleted.size} message(s) in <#${interaction.channelId}>`);
    return;
  }

  if (name === 'slowmode') {
    const seconds = interaction.options.getInteger('seconds');
    await interaction.channel.setRateLimitPerUser(seconds);
    await interaction.reply({ content: seconds === 0 ? 'Slowmode is off.' : `One message every ${seconds} second(s).`, ephemeral: true });
    return;
  }

  if (name === 'unban') {
    const id = interaction.options.getString('user_id').trim();
    await interaction.guild.members.unban(id).catch(() => null);
    await interaction.reply({ content: `Ban lifted for ${id}.`, ephemeral: true });
    await log(interaction, settings, 'unban', { id, tag: id }, null);
    return;
  }

  const target = interaction.options.getUser('user');
  const member = await interaction.guild.members.fetch(target.id).catch(() => null);
  const why = interaction.options.getString('reason') || 'No reason given';

  if (name === 'warnings') {
    const list = settings.warnings[target.id] ?? [];
    await interaction.reply({
      content: list.length === 0 ? `${target.tag} has no warnings.` : list.map((w, i) => `${i + 1}. ${w.reason} (by <@${w.by}>, <t:${Math.floor(w.at / 1000)}:R>)`).join('\n'),
      ephemeral: true,
    });
    return;
  }

  if (name === 'clearwarnings') {
    delete settings.warnings[target.id];
    await save();
    await interaction.reply({ content: `Warnings of ${target.tag} forgotten.`, ephemeral: true });
    await log(interaction, settings, 'clearwarnings', target, null);
    return;
  }

  const check = canActOn(interaction, member);
  if (!check.ok) {
    await interaction.reply({ content: check.why, ephemeral: true });
    return;
  }

  if (name === 'warn') {
    const list = (settings.warnings[target.id] ??= []);
    list.push({ reason: why, by: interaction.user.id, at: Date.now() });
    await save();
    await tell(target, interaction.guild, `you were warned: ${why} (warning ${list.length})`);
    await interaction.reply({ content: `${target.tag} warned (${list.length} so far): ${why}` });
    await log(interaction, settings, 'warn', target, `${why} (warning ${list.length})`);
    return;
  }

  if (name === 'timeout') {
    if (!member) {
      await interaction.reply({ content: 'That user is not in the server.', ephemeral: true });
      return;
    }
    const minutes = interaction.options.getInteger('minutes');
    await member.timeout(minutes * 60 * 1000, why);
    await tell(target, interaction.guild, `you were timed out for ${minutes} minute(s): ${why}`);
    await interaction.reply({ content: `${target.tag} timed out for ${minutes} minute(s): ${why}` });
    await log(interaction, settings, 'timeout', target, `${minutes} minute(s): ${why}`);
    return;
  }

  if (name === 'untimeout') {
    if (!member) {
      await interaction.reply({ content: 'That user is not in the server.', ephemeral: true });
      return;
    }
    await member.timeout(null);
    await interaction.reply({ content: `${target.tag}'s timeout ended.` });
    await log(interaction, settings, 'untimeout', target, null);
    return;
  }

  if (name === 'kick') {
    if (!member) {
      await interaction.reply({ content: 'That user is not in the server.', ephemeral: true });
      return;
    }
    await tell(target, interaction.guild, `you were kicked: ${why}`);
    await member.kick(why);
    await interaction.reply({ content: `${target.tag} kicked: ${why}` });
    await log(interaction, settings, 'kick', target, why);
    return;
  }

  if (name === 'ban') {
    const days = interaction.options.getInteger('delete_days') ?? 0;
    await tell(target, interaction.guild, `you were banned: ${why}`);
    await interaction.guild.members.ban(target.id, { reason: why, deleteMessageSeconds: days * 24 * 3600 });
    await interaction.reply({ content: `${target.tag} banned: ${why}` });
    await log(interaction, settings, 'ban', target, why);
  }
}
