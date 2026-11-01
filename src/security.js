import {
  ActionRowBuilder, AutoModerationRuleTriggerType, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, GatewayIntentBits, MessageFlags, OverwriteType,
  PermissionFlagsBits,
} from 'discord.js';
import { createHash } from 'node:crypto';
import { automodSteps, inviteCodes } from './automod.js';
import { fit, postLog, runSteps } from './modlog.js';
import { STAFF } from './protection.js';
import { save } from './store.js';

const P = PermissionFlagsBits;
const REASON = 'Moderation bot: /securitycheck fix';

// Servers with a change running. A second click, a second admin, or a fix
// racing /automod-setup would otherwise apply it twice (two #mod-log channels).
const busy = new Set();

/** Runs a change unless another one is running for the server; false when it had to wait its turn. */
async function oneAtATime(guildId, change) {
  if (busy.has(guildId)) return false;
  busy.add(guildId);
  try {
    await change();
  } finally {
    busy.delete(guildId);
  }
  return true;
}

/** A short fingerprint of a plan, carried by the confirm button so the second click changes only what the first one showed. */
const planId = (steps) => createHash('sha1').update(steps.map((s) => s.text).join('\n')).digest('hex').slice(0, 12);

// What the bot needs to clean up spam, act on members, keep its log, set up AutoMod and apply the fixes below.
const NEEDS = [
  ['View Channels', P.ViewChannel], ['Send Messages', P.SendMessages], ['Embed Links', P.EmbedLinks],
  ['Read Message History', P.ReadMessageHistory], ['Manage Messages', P.ManageMessages], ['Moderate Members', P.ModerateMembers],
  ['Kick Members', P.KickMembers], ['Ban Members', P.BanMembers], ['Manage Channels', P.ManageChannels],
  ['Manage Roles', P.ManageRoles], ['Manage Server', P.ManageGuild],
];

const roleName = (role) => (role.id === role.guild.id ? '@everyone' : `@${role.name}`);
const list = (items, max = 6) => (items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', '));

/** Roles ordinary members hold: not @everyone (checked on its own), not a bot's or the booster role, not staff. */
const memberRoles = (guild) => [...guild.roles.cache.values()].filter((role) => role.id !== guild.id && !role.managed && !role.permissions.any(STAFF));

/** Channel overrides that allow a permission to any of these roles. Threads have none: they follow their channel. */
function overridesAllowing(guild, flag, roles) {
  const ids = new Set(roles.map((role) => role.id));
  return [...guild.channels.cache.values()].flatMap((channel) => [...(channel.permissionOverwrites?.cache.values() ?? [])]
    .filter((overwrite) => ids.has(overwrite.id) && overwrite.allow.has(flag))
    .map((overwrite) => ({ channel, role: guild.roles.cache.get(overwrite.id) })));
}

/** Steps that switch a permission off for these roles, and back to "inherit" in these channel overrides. */
function permissionOff(name, label, roles, overrides) {
  return [
    ...roles.map((role) => ({ text: `turn off ${label} for ${roleName(role)}`, run: () => role.setPermissions(role.permissions.remove(P[name]), REASON) })),
    ...overrides.map(({ channel, role }) => ({
      text: `set ${label} back to inherit for ${roleName(role)} in <#${channel.id}>`,
      run: () => channel.permissionOverwrites.edit(role.id, { [name]: null }, { type: OverwriteType.Role, reason: REASON }),
    })),
  ];
}

/** Everything risky about the server, read fresh each time: a fix button reads it again before it changes anything. */
export async function findRisks(guild, settings) {
  const me = guild.members.me;
  const everyone = guild.roles.everyone;
  const plain = memberRoles(guild);
  const risks = [];

  const appRoles = [everyone, ...plain].filter((role) => role.permissions.has(P.UseExternalApps));
  const appOverrides = overridesAllowing(guild, P.UseExternalApps, [everyone, ...plain]);
  if (appRoles.length || appOverrides.length) {
    const where = [...appRoles.map(roleName), ...(appOverrides.length ? [`${appOverrides.length} channel override(s)`] : [])];
    risks.push({
      id: 'apps',
      title: 'Members\' own apps can post in your channels',
      detail: `Use External Apps is on for ${list(where)} (Discord turns it on for @everyone by default). A member can run an app installed on their own Discord account and have it post here, and Discord does not show who ran it. Spammers use this to drop invite links in every channel. With it off, those apps only answer the person who ran them.`,
      fix: 'Turn off Use External Apps',
      steps: async () => permissionOff('UseExternalApps', 'Use External Apps', appRoles, appOverrides),
    });
  }

  const pingRoles = everyone.permissions.has(P.MentionEveryone) ? [everyone] : [];
  const pingOverrides = overridesAllowing(guild, P.MentionEveryone, [everyone]);
  if (pingRoles.length || pingOverrides.length) {
    const channels = pingOverrides.length ? ` (${pingRoles.length ? 'and ' : ''}in ${list(pingOverrides.map(({ channel }) => `<#${channel.id}>`))})` : '';
    risks.push({
      id: 'everyone',
      title: 'Anyone can ping @everyone',
      detail: `@everyone may use Mention @everyone, @here and All Roles${channels}. One hacked account can then ping the whole server with a scam.`,
      fix: 'Stop @everyone pings',
      steps: async () => permissionOff('MentionEveryone', 'Mention @everyone', pingRoles, pingOverrides),
    });
  }

  const missing = NEEDS.filter(([, flag]) => !me.permissions.has(flag)).map(([name]) => name);
  const blind = [...guild.channels.cache.values()].filter((channel) => channel.isTextBased() && !channel.isThread()
    && channel.permissionsFor(everyone).has([P.ViewChannel, P.SendMessages]) && !channel.permissionsFor(me).has([P.ViewChannel, P.ManageMessages]));
  if (missing.length || blind.length) {
    risks.push({
      id: 'permissions',
      title: 'The bot is missing permissions',
      detail: [
        missing.length ? `It does not have ${list(missing, NEEDS.length)}.` : '',
        blind.length ? `It cannot see or clean up ${blind.length} channel(s) members can post in: ${list(blind.map((channel) => `<#${channel.id}>`))}.` : '',
      ].join(' ').trim(),
      howTo: `in Server Settings, Roles, give ${me.roles.botRole ? roleName(me.roles.botRole) : 'the bot\'s role'} what is missing${blind.length ? ' and let it see those channels' : ''}. Discord does not let a bot give itself permissions.`,
    });
  }

  const top = me.roles.highest;
  const above = plain.filter((role) => role.id !== top.id && role.comparePositionTo(top) > 0).sort((a, b) => b.position - a.position);
  if (above.length) {
    const own = me.roles.botRole ?? (top.id !== everyone.id ? top : null);
    risks.push({
      id: 'role',
      title: 'The bot\'s role is too low',
      detail: `${list(above.map(roleName))} ${above.length === 1 ? 'is' : 'are'} above ${own ? roleName(own) : 'every role the bot has'}, so the bot cannot time out, kick or ban members who have ${above.length === 1 ? 'that role' : 'those roles'}.`,
      howTo: `in Server Settings, Roles, ${own ? `drag ${roleName(own)} above ${above.length === 1 ? 'it' : 'them'}` : 'give the bot a role above them'}. Discord does not let a bot move its own role up.`,
    });
  }

  const logChannel = settings.logChannelId ? guild.channels.cache.get(settings.logChannelId) : null;
  if (!logChannel) {
    risks.push({
      id: 'log',
      title: 'No moderation log',
      detail: 'What the bot removes and who it times out is not written down anywhere, and the log is the only place that names who ran a spamming app.',
      fix: 'Create a private #mod-log',
      steps: async () => [{ text: 'create #mod-log, which only staff roles and the bot can see, and log there', run: () => createLogChannel(guild, settings) }],
    });
  } else if (!logChannel.permissionsFor(me).has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) {
    risks.push({
      id: 'log',
      title: 'The bot cannot write its log',
      detail: `It needs View Channel, Send Messages and Embed Links in <#${logChannel.id}>.`,
      howTo: `edit <#${logChannel.id}>, Permissions, and allow those for the bot's role.`,
    });
  }

  if (me.permissions.has(P.ManageGuild)) {
    const rules = await guild.autoModerationRules.fetch().catch(() => null);
    const enabled = [...(rules?.values() ?? [])].filter((rule) => rule.enabled);
    const invites = enabled.some((rule) => rule.triggerType === AutoModerationRuleTriggerType.Keyword && rule.triggerMetadata.keywordFilter.some((word) => word.includes('discord.gg')));
    const mentions = enabled.some((rule) => rule.triggerType === AutoModerationRuleTriggerType.MentionSpam);
    if (rules && !(invites && mentions)) {
      risks.push({
        id: 'automod',
        title: `AutoMod does not block ${[!invites && 'invite links', !mentions && 'mention spam'].filter(Boolean).join(' or ')}`,
        detail: 'Discord\'s own AutoMod stops these before anyone sees them, even while the bot is offline.',
        fix: 'Set up AutoMod',
        steps: async () => (await automodSteps(guild, settings)).steps,
      });
    }
  }

  if (!guild.client.options.intents.has(GatewayIntentBits.MessageContent)) {
    risks.push({
      id: 'intent',
      title: 'The bot cannot read messages',
      detail: 'The Message Content intent is off. The copy-paste check for hacked accounts is skipped, and app spam is caught only by how many channels it reaches, not by what it says.',
      howTo: 'in the Developer Portal, open your app, Bot, and turn on Message Content Intent. Then restart the bot in the FadeHost panel.',
      link: `https://discord.com/developers/applications/${guild.client.application?.id ?? guild.client.user.id}/bot`,
    });
  }
  return risks;
}

/** A text channel only staff and the bot can see, set as the log. */
async function createLogChannel(guild, settings) {
  const me = guild.members.me;
  const has = (flags) => flags.filter((flag) => me.permissions.has(flag)); // a bot can only allow what it has itself
  const staff = [...guild.roles.cache.values()]
    .filter((role) => !role.managed && role.id !== guild.id && role.permissions.any(STAFF)) // the same staff the checks leave alone
    .slice(0, 20);
  const channel = await guild.channels.create({
    name: 'mod-log',
    type: ChannelType.GuildText,
    topic: 'What the moderation bot did, and why.',
    permissionOverwrites: [
      { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
      { id: me.id, type: OverwriteType.Member, allow: has([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory]) },
      ...staff.map((role) => ({ id: role.id, type: OverwriteType.Role, allow: has([P.ViewChannel, P.ReadMessageHistory]) })),
    ],
    reason: REASON,
  });
  settings.logChannelId = channel.id;
  await save();
}

/** /securitycheck */
export async function securityCheck(interaction, settings) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(render(await findRisks(interaction.guild, settings)));
}

function render(risks) {
  const embed = new EmbedBuilder()
    .setTitle('Security check')
    .setColor(risks.length ? 0xe67e22 : 0x57f287)
    .setDescription(risks.length ? `${risks.length} thing(s) to look at. A fix button shows what it will change and asks before it does.` : 'Nothing risky found.');
  for (const [i, risk] of risks.entries()) {
    const how = risk.fix ? `Fix: the "${i + 1}. ${risk.fix}" button.` : `To fix it, ${risk.howTo}`;
    embed.addFields({ name: `${i + 1}. ${risk.title}`, value: `${risk.detail}\n${how}`.slice(0, 1024) });
  }
  const buttons = risks.flatMap((risk, i) => [
    ...(risk.fix ? [new ButtonBuilder().setCustomId(`sec:ask:${risk.id}`).setLabel(`${i + 1}. ${risk.fix}`).setStyle(ButtonStyle.Primary)] : []),
    ...(risk.link ? [new ButtonBuilder().setURL(risk.link).setLabel('Open the Developer Portal').setStyle(ButtonStyle.Link)] : []),
  ]);
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  return { embeds: [embed], components: rows };
}

/** The fix buttons: the first click shows exactly what will change, the second one changes it. */
export async function securityButton(interaction, settings) {
  const [, step, id, shown] = interaction.customId.split(':');
  if (!interaction.memberPermissions?.has(P.ManageGuild)) {
    await interaction.reply({ content: 'Only members with Manage Server can change these settings.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (step === 'no') {
    await interaction.update({ content: 'Nothing was changed.', embeds: [], components: [] });
    return;
  }
  if (step === 'ask') await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else await interaction.deferUpdate();
  // Planned again inside the lock, so a change that just finished is seen.
  const ran = await oneAtATime(interaction.guildId, async () => {
    const risk = (await findRisks(interaction.guild, settings)).find((found) => found.id === id && found.fix);
    if (!risk) {
      await interaction.editReply({ content: 'That is already fixed.', embeds: [], components: [] });
      return;
    }
    const steps = await risk.steps();
    // The settings moved between the two clicks: show the new plan and ask again.
    if (step === 'ask' || planId(steps) !== shown) {
      const changed = step === 'ask' ? '' : 'The settings changed since you looked. ';
      await interaction.editReply({
        content: fit([`${changed}**${risk.fix}?** This will:`, ...steps.map((s) => `- ${s.text}`)]),
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`sec:do:${id}:${planId(steps)}`).setLabel('Yes, change it').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('sec:no').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        )],
      });
      return;
    }
    const lines = await runSteps(steps);
    await interaction.editReply({ content: fit(lines), components: [] });
    await logChange(interaction, settings, risk.fix, lines);
  });
  if (!ran) await interaction.editReply({ content: 'Another change is running on this server. Try again in a moment.', components: [] });
}

/** /automod-setup */
export async function automodSetup(interaction, settings) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const ran = await oneAtATime(interaction.guildId, async () => {
    let plan;
    try {
      plan = await automodSteps(interaction.guild, settings, inviteCodes(interaction.options.getString('allow')));
    } catch (err) {
      await interaction.editReply(err.code === 50013 ? 'The bot needs the Manage Server permission to set up AutoMod.' : `Could not read the AutoMod rules: ${err.message}`);
      return;
    }
    const lines = await runSteps(plan.steps);
    if (plan.kept) lines.push(`Kept your own mention spam rule "${plan.kept}": a server can have only one.`);
    if (!plan.alerts) lines.push('Blocked messages are not reported anywhere yet: pick a log channel with /modlog, then run /automod-setup again.');
    if (!plan.exempt) lines.push('The bot has no role of its own to exempt, so AutoMod may block its own log posts when they quote a link.');
    await interaction.editReply(fit(lines));
    await logChange(interaction, settings, 'AutoMod setup', lines);
  });
  if (!ran) await interaction.editReply('Another change is running on this server. Try again in a moment.');
}

/** A settings change in the mod log: who made it and how each step went. */
async function logChange(interaction, settings, what, lines) {
  const embed = new EmbedBuilder()
    .setTitle(what)
    .setColor(0x5865f2)
    .addFields({ name: 'By', value: `<@${interaction.user.id}>`, inline: true }, { name: 'Details', value: fit(lines, 1000) })
    .setTimestamp();
  await postLog(interaction.guild, settings, { embeds: [embed] });
}
