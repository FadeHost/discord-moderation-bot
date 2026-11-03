import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
} from 'discord.js';
import { postLog } from './modlog.js';
import { forgive, protectionCommand, span } from './protection.js';
import { automodSetup, securityButton, securityCheck } from './security.js';
import { COPY_CHANNELS_MAX, COPY_CHANNELS_MIN, COPY_WITHIN, PROTECTION_DEFAULTS, getGuild, save } from './store.js';

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
  new SlashCommandBuilder().setName('protection').setDescription('Automatic spam protection: see what it does, or change it').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption((o) => o.setName('app_spam').setDescription('Remove spam posted through apps members installed on their own account'))
    .addBooleanOption((o) => o.setName('copy_spam').setDescription('Remove one message posted in several channels at once, as hacked accounts do'))
    .addIntegerOption((o) => o.setName('copy_channels').setDescription(`In how many channels the same message counts as copy-paste spam, ${COPY_CHANNELS_MIN} to ${COPY_CHANNELS_MAX} (${PROTECTION_DEFAULTS.copyChannels} by default)`)
      .setMinValue(COPY_CHANNELS_MIN).setMaxValue(COPY_CHANNELS_MAX))
    .addIntegerOption((o) => o.setName('copy_within').setDescription(`How close together the copies must come to count as copy-paste spam (${span(PROTECTION_DEFAULTS.copySeconds)} by default)`)
      .addChoices(...COPY_WITHIN.map((seconds) => ({ name: span(seconds), value: seconds }))))
    .addIntegerOption((o) => o.setName('timeout_minutes').setDescription('How long the person is timed out, 1 to 40320 (four weeks)').setMinValue(1).setMaxValue(40320))
    .addBooleanOption((o) => o.setName('ban').setDescription('Ban instead of a timeout (off by default)')),
  new SlashCommandBuilder().setName('securitycheck').setDescription('Find risky server settings, with buttons that fix them').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('automod-setup').setDescription('Set up Discord AutoMod to block invite links to other servers and mention spam')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('allow').setDescription('More invite links or codes to allow, separated by spaces').setMaxLength(1000)),
].map((c) => c.setContexts(InteractionContextType.Guild).toJSON());

const COLORS = { warn: 0xfee75c, timeout: 0xe67e22, untimeout: 0x57f287, kick: 0xed4245, ban: 0x992d22, unban: 0x57f287, purge: 0x5865f2, clearwarnings: 0x57f287, protection: 0x5865f2 };

async function log(interaction, settings, action, target, details) {
  const embed = new EmbedBuilder()
    .setTitle(action)
    .setColor(COLORS[action] ?? 0x99aab5)
    .addFields(
      { name: 'Target', value: target ? `<@${target.id}> (${target.tag ?? target.id})` : '-', inline: true },
      { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
      ...(details ? [{ name: 'Details', value: details.slice(0, 1000) }] : []),
    )
    .setTimestamp();
  await postLog(interaction.guild, settings, { embeds: [embed] });
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
    await interaction.reply({ content: channel ? `Moderation actions are logged in <#${channel.id}>.` : 'Moderation logging is off.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (name === 'protection') {
    const changes = await protectionCommand(interaction, settings);
    const details = Object.entries(changes).map(([key, value]) => `${key}: ${value}`).join(', ');
    if (details) await log(interaction, settings, 'protection', null, details);
    return;
  }

  if (name === 'securitycheck') return securityCheck(interaction, settings);
  if (name === 'automod-setup') return automodSetup(interaction, settings);

  if (name === 'purge') {
    const amount = interaction.options.getInteger('amount');
    const from = interaction.options.getUser('from');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    await interaction.reply({ content: seconds === 0 ? 'Slowmode is off.' : `One message every ${seconds} second(s).`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (name === 'unban') {
    const id = interaction.options.getString('user_id').trim();
    await interaction.guild.members.unban(id).catch(() => null);
    await interaction.reply({ content: `Ban lifted for ${id}.`, flags: MessageFlags.Ephemeral });
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
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (name === 'clearwarnings') {
    delete settings.warnings[target.id];
    await save();
    await interaction.reply({ content: `Warnings of ${target.tag} forgotten.`, flags: MessageFlags.Ephemeral });
    await log(interaction, settings, 'clearwarnings', target, null);
    return;
  }

  const check = canActOn(interaction, member);
  if (!check.ok) {
    await interaction.reply({ content: check.why, flags: MessageFlags.Ephemeral });
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
      await interaction.reply({ content: 'That user is not in the server.', flags: MessageFlags.Ephemeral });
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
      await interaction.reply({ content: 'That user is not in the server.', flags: MessageFlags.Ephemeral });
      return;
    }
    await member.timeout(null);
    forgive(interaction.guildId, target.id);
    await interaction.reply({ content: `${target.tag}'s timeout ended.` });
    await log(interaction, settings, 'untimeout', target, null);
    return;
  }

  if (name === 'kick') {
    if (!member) {
      await interaction.reply({ content: 'That user is not in the server.', flags: MessageFlags.Ephemeral });
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

export async function handleButton(interaction) {
  const settings = await getGuild(interaction.guildId);
  if (interaction.customId.startsWith('sec:')) return securityButton(interaction, settings);
  if (interaction.customId.startsWith('mod:')) return logButton(interaction, settings);
}

/** The buttons under an automatic action in the log: lift the timeout, or ban after a second click. */
async function logButton(interaction, settings) {
  const [, action, userId] = interaction.customId.split(':');
  if (action === 'cancel') {
    await interaction.update({ content: 'Nothing was changed.', components: [] });
    return;
  }
  const lifting = action === 'untimeout';
  if (!interaction.memberPermissions?.has(lifting ? PermissionFlagsBits.ModerateMembers : PermissionFlagsBits.BanMembers)) {
    await interaction.reply({ content: `You need ${lifting ? 'Moderate Members' : 'Ban Members'} for that.`, flags: MessageFlags.Ephemeral });
    return;
  }
  const target = await interaction.client.users.fetch(userId);
  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  const check = canActOn(interaction, member);
  if (!check.ok) {
    await interaction.reply({ content: check.why, flags: MessageFlags.Ephemeral });
    return;
  }

  if (lifting) {
    if (!member) {
      await interaction.reply({ content: 'That user is not in the server.', flags: MessageFlags.Ephemeral });
      return;
    }
    await member.timeout(null);
    forgive(interaction.guildId, userId);
    await interaction.reply({ content: `${target.tag}'s timeout ended.`, flags: MessageFlags.Ephemeral });
    await log(interaction, settings, 'untimeout', target, 'From the moderation log');
    return;
  }

  if (action === 'ban') {
    await interaction.reply({
      content: `Ban ${target.tag}? Their messages from the last hour are deleted too.`,
      flags: MessageFlags.Ephemeral,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mod:banyes:${userId}`).setLabel('Ban').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('mod:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      )],
    });
    return;
  }

  if (action === 'banyes') {
    const why = `Spam caught by the moderation bot; banned from the log by ${interaction.user.tag}`;
    await interaction.guild.members.ban(userId, { reason: why, deleteMessageSeconds: 3600 });
    await interaction.update({ content: `${target.tag} banned.`, components: [] });
    await log(interaction, settings, 'ban', target, why);
  }
}
