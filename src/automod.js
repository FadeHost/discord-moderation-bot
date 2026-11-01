import { AutoModerationActionType, AutoModerationRuleEventType, AutoModerationRuleTriggerType } from 'discord.js';

export const INVITE_RULE = 'Block invite links to other servers';
export const MENTION_RULE = 'Block mention spam';
const INVITE_LINKS = ['discord.gg/', 'discord.com/invite/', 'discordapp.com/invite/'];
const MENTION_LIMIT = 10;

// AutoMod matches a keyword only as a whole word unless it has a * at an end.
// With one at both ends it matches inside a link too, and allow-list entries
// follow the same rule.
const anywhere = (text) => `*${text}*`;
const union = (a, b) => [...new Set([...a, ...b])];

/** Pulls invite codes out of text like "abc, discord.gg/def https://discord.com/invite/ghi". */
export function inviteCodes(text) {
  return (text ?? '').split(/[\s,]+/).map((part) => part.replace(/\/+$/, '').split('/').pop()).filter((code) => /^[\w-]{2,32}$/.test(code));
}

/** This server's own invites stay allowed: its vanity link, its permanent invites and any the admin named. */
async function ownCodes(guild, extra) {
  const codes = new Set(extra);
  if (guild.vanityURLCode) codes.add(guild.vanityURLCode);
  const invites = await guild.invites.fetch().catch(() => null);
  for (const invite of invites?.values() ?? []) if (!invite.maxAge) codes.add(invite.code);
  return [...codes].slice(0, Math.floor(100 / INVITE_LINKS.length)); // AutoMod takes up to 100 allow-list entries
}

/**
 * The steps that create the bot's AutoMod rules, or refresh them when they exist.
 * A refresh keeps the keywords, allowed links and exemptions an admin added by hand.
 */
export async function automodSteps(guild, settings, extra = []) {
  const me = guild.members.me;
  const rules = [...(await guild.autoModerationRules.fetch()).values()]; // needs Manage Server
  const codes = await ownCodes(guild, extra);
  const alert = settings.logChannelId ? [{ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: settings.logChannelId } }] : [];
  const common = {
    eventType: AutoModerationRuleEventType.MessageSend,
    enabled: true,
    // AutoMod blocks bots too (API error 200000), the bot's own log posts included.
    exemptRoles: me.roles.botRole ? [me.roles.botRole.id] : [],
    exemptChannels: settings.logChannelId ? [settings.logChannelId] : [],
    reason: 'Moderation bot: AutoMod setup',
  };
  const invite = {
    ...common,
    name: INVITE_RULE,
    triggerType: AutoModerationRuleTriggerType.Keyword,
    triggerMetadata: {
      keywordFilter: INVITE_LINKS.map(anywhere),
      allowList: codes.flatMap((code) => INVITE_LINKS.map((link) => anywhere(link + code))),
    },
    actions: [{ type: AutoModerationActionType.BlockMessage, metadata: { customMessage: 'Invite links to other servers are not allowed here.' } }, ...alert],
  };
  const mention = {
    ...common,
    name: MENTION_RULE,
    triggerType: AutoModerationRuleTriggerType.MentionSpam,
    triggerMetadata: { mentionTotalLimit: MENTION_LIMIT, mentionRaidProtectionEnabled: true },
    actions: [
      { type: AutoModerationActionType.BlockMessage, metadata: { customMessage: 'Too many mentions in one message.' } },
      { type: AutoModerationActionType.Timeout, metadata: { durationSeconds: 3600 } },
      ...alert,
    ],
  };
  const keep = (old, rule) => ({
    ...rule,
    triggerMetadata: rule.triggerMetadata.keywordFilter ? {
      keywordFilter: union(old.triggerMetadata.keywordFilter, rule.triggerMetadata.keywordFilter),
      allowList: union(old.triggerMetadata.allowList, rule.triggerMetadata.allowList).slice(0, 100),
    } : rule.triggerMetadata,
    exemptRoles: union(old.exemptRoles.keys(), rule.exemptRoles).slice(0, 20),
    exemptChannels: union(old.exemptChannels.keys(), rule.exemptChannels).slice(0, 50),
  });
  const mine = (rule) => rule.creatorId === guild.client.user.id;
  const oldInvite = rules.find((rule) => mine(rule) && rule.name === INVITE_RULE);
  const oldMention = rules.find((rule) => rule.triggerType === AutoModerationRuleTriggerType.MentionSpam); // a server can have only one
  const allowed = codes.length ? `, except this server's own invites (${codes.join(', ')})` : '';
  const steps = [{
    text: `${oldInvite ? 'update' : 'create'} the AutoMod rule "${INVITE_RULE}": messages with discord.gg, discord.com/invite or discordapp.com/invite links are blocked${allowed}`,
    run: () => (oldInvite ? oldInvite.edit(keep(oldInvite, invite)) : guild.autoModerationRules.create(invite)),
  }];
  if (!oldMention || mine(oldMention)) {
    steps.push({
      text: `${oldMention ? 'update' : 'create'} the AutoMod rule "${MENTION_RULE}": a message with more than ${MENTION_LIMIT} mentions is blocked and its sender timed out for an hour, and mention raids are blocked`,
      run: () => (oldMention ? oldMention.edit(keep(oldMention, mention)) : guild.autoModerationRules.create(mention)),
    });
  }
  return { steps, kept: oldMention && !mine(oldMention) ? oldMention.name : null, alerts: alert.length > 0, exempt: Boolean(me.roles.botRole) };
}
