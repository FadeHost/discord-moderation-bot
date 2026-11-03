import {
  ActionRowBuilder, ApplicationIntegrationType, ButtonBuilder, ButtonStyle, EmbedBuilder, GatewayIntentBits, MessageFlags, PermissionFlagsBits, escapeMarkdown,
} from 'discord.js';
import { postLog } from './modlog.js';
import { COPY_WITHIN, getGuild, protectionOf, save } from './store.js';

const P = PermissionFlagsBits;

// Anyone with one of these is staff, and the automatic checks leave staff alone.
export const STAFF = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.ManageMessages, P.ModerateMembers, P.KickMembers, P.BanMembers];

// App spam. A member can run an app installed on their own Discord account,
// not on this server, and have it post in any channel they can use. Discord
// shows those posts without saying who ran the app, but every one carries
// interaction metadata naming the account the app is installed on, so the
// bot acts on that person.
const APP_WINDOW = 60_000; // within a minute, that person's apps posted
const APP_CHANNELS = 3; // in this many channels,
const APP_MESSAGES = 10; // or this many times.
const APP_MEMORY = 15 * 60_000; // an app can keep posting for 15 minutes after it was run, so cleanup lasts that long

// Copy-paste spam, the usual sign of a hacked account: one member posts the
// same message in three channels within half a minute. How many channels and
// how close together are each server's own (/protection copy_channels and
// copy_within), so a server can also catch a member pasting one question into
// two channels minutes apart. Copies are remembered for 2 minutes, or for the
// server's time when that is longer.
const COPY_MEMORY = 2 * 60_000;
const COPY_MEMORY_MAX = Math.max(COPY_MEMORY, ...COPY_WITHIN.map((seconds) => seconds * 1000));

const INVITES = /(?:discord(?:app)?\.com\/invite|discord\.gg)\/([\w-]+)/gi;
const EVERYONE = /(?<![\w.@])@(?:everyone|here)\b/i;

const recent = new Map(); // kind:guild:user -> [{ channel, id, at, print, gone }], oldest first
const caught = new Map(); // kind:guild:user -> { until, print }: until then their posts are removed without a new log entry
const queues = new Map(); // kind:guild:user -> the check running for that person
const inviteHomes = new Map(); // invite code -> { guildId, until }

export const isStaff = (member) => member.id === member.guild.ownerId || member.permissions.any(STAFF);

/** Every message the bot can see comes through here. */
export async function protect(message) {
  // Taken now: a check can wait its turn behind others, and the channel may be gone by then.
  const channel = message.channel;
  if (!message.inGuild() || !channel || message.author.id === message.client.user.id) return;
  const owner = message.interactionMetadata && installedOn(message.interactionMetadata);
  if (owner) return checkApp(message, channel, owner);
  if (message.author.bot || message.webhookId || message.system || !message.member) return;
  // Without the Message Content intent every message arrives empty, so there is nothing to compare.
  if (canRead(message)) await checkCopies(message, channel);
}

/** An app that answers "thinking..." first says what it has to say in an edit, so app posts are read again then. */
export async function protectEdit(message) {
  const channel = message.channel;
  if (message.partial || !message.inGuild() || !channel) return;
  const owner = message.interactionMetadata && installedOn(message.interactionMetadata);
  if (owner) await checkApp(message, channel, owner, true);
}

const canRead = (message) => message.client.options.intents.has(GatewayIntentBits.MessageContent);

/**
 * The person whose account the app is installed on, when it is installed on
 * a person and not on this server. Not interaction_metadata.user: on a button
 * click that is whoever clicked, and anyone can click a spam app's button.
 */
function installedOn(meta) {
  const owners = meta.authorizingIntegrationOwners?.toJSON() ?? {};
  const kinds = Object.keys(owners);
  return kinds.length === 1 && kinds[0] === String(ApplicationIntegrationType.UserInstall) ? owners[kinds[0]] : null;
}

async function checkApp(message, channel, ownerId, edited = false) {
  const settings = await getGuild(message.guildId);
  const rules = protectionOf(settings);
  if (!rules.appSpam) return;
  const key = `app:${message.guildId}:${ownerId}`;
  await inTurn(key, async () => {
    // Discord's own time for the post or the edit: after a reconnect, missed messages arrive in one burst.
    const at = edited ? (message.editedTimestamp ?? Date.now()) : message.createdTimestamp;
    // An edit is no new post: the post was counted when it arrived, so only its new text is judged.
    // Counted again at the time it was first posted, it would make every post since look like one burst.
    const remembered = recent.get(key) ?? [];
    const posts = !edited ? remember(key, { channel, id: message.id, at }, APP_MEMORY)
      : remembered.some((post) => post.id === message.id) ? remembered : [...remembered, { channel, id: message.id, at: message.createdTimestamp }];
    if (caught.get(key)?.until > at) return removeAll(posts);
    const lately = edited ? [] : posts.filter((post) => at - post.at < APP_WINDOW);
    const channels = new Set(lately.map((post) => place(post.channel))).size;
    const text = textOf(message);
    const blast = (message.mentions.everyone || EVERYONE.test(text)) && (await invitesElsewhere(message.guild, text));
    const why = blast ? 'posted @everyone with an invite to another server'
      : channels >= APP_CHANNELS ? `posted in ${channels} channels within a minute`
        : lately.length >= APP_MESSAGES ? `posted ${lately.length} times within a minute`
          : null;
    if (!why) return;
    const guild = message.guild;
    if (ownerId === guild.ownerId) return;
    let member = null;
    try {
      member = await guild.members.fetch(ownerId);
    } catch (err) {
      // Only "Unknown Member" means they left. Any other failure could hide
      // a moderator, so nothing happens rather than the wrong thing.
      if (err.code !== 10007) {
        console.error(`[moderation-bot] could not look up ${ownerId}, so their app's posts are left alone:`, err.message);
        return;
      }
    }
    if (member && isStaff(member)) return;
    const person = member?.user ?? (await message.client.users.fetch(ownerId).catch(() => ({ id: ownerId, tag: ownerId })));
    const clicker = message.interactionMetadata.user;
    caught.set(key, { until: at + APP_MEMORY });
    const removed = await removeAll(posts);
    const outcome = await act(guild, member, person, rules, `Moderation bot: an app they ran ${why}`, 'an app you ran posted spam in the server.');
    await report(guild, settings, {
      title: 'App spam removed', person, app: message.author, clicker: clicker && clicker.id !== ownerId ? clicker : null, why: `An app they ran ${why}.`,
      text, readable: canRead(message), removed, outcome, later: 'Anything more their apps post in the next 15 minutes is deleted too.',
    });
  });
}

async function checkCopies(message, channel) {
  if (isStaff(message.member)) return;
  const print = fingerprint(message);
  if (!print) return;
  const settings = await getGuild(message.guildId);
  const rules = protectionOf(settings);
  if (!rules.copySpam) return;
  const key = `copy:${message.guildId}:${message.author.id}`;
  const copyWindow = rules.copySeconds * 1000;
  const memory = Math.max(COPY_MEMORY, copyWindow);
  await inTurn(key, async () => {
    const at = message.createdTimestamp;
    const copies = remember(key, { channel, id: message.id, at, print }, memory).filter((post) => post.print === print);
    const earlier = caught.get(key);
    if (earlier?.until > at && earlier.print === print) return removeAll(copies);
    const channels = new Set(copies.filter((post) => at - post.at < copyWindow).map((post) => place(post.channel))).size;
    if (channels < rules.copyChannels) return;
    caught.set(key, { until: at + memory, print });
    const removed = await removeAll(copies);
    const what = `the same message in ${channels} channels within ${span(rules.copySeconds)}`;
    const outcome = await act(message.guild, message.member, message.author, rules, `Moderation bot: ${what}`,
      `your account posted ${what}. If that was not you, change your Discord password and turn on two-factor authentication.`);
    await report(message.guild, settings, {
      title: 'Copy-paste spam removed', person: message.author, why: `Posted ${what}${asHacked(rules)}.`,
      text: textOf(message), readable: true, removed, outcome, later: `More copies in the next ${duration(memory / 60_000)} are deleted too.`,
    });
  });
}

/** Half a minute or so is how hacked accounts post. A longer time is the server's own stricter rule, not a sign of one. */
const asHacked = (rules) => (rules.copySeconds <= 60 ? ', as hacked accounts do' : '');

/** A thread counts as the channel it belongs to: a helper answering three forum posts with the same link is not spreading spam. */
const place = (channel) => (channel.isThread?.() ? channel.parentId : channel.id);

/** True when the text links an invite to some other server. An invite Discord does not know counts as another server's. */
async function invitesElsewhere(guild, text) {
  for (const [, code] of text.matchAll(INVITES)) {
    if (guild.vanityURLCode && code.toLowerCase() === guild.vanityURLCode.toLowerCase()) continue;
    let home = inviteHomes.get(code);
    if (!home || home.until < Date.now()) {
      const guildId = await guild.client.fetchInvite(code).then((invite) => invite.guild?.id ?? null, () => null);
      home = { guildId, until: Date.now() + 10 * 60_000 };
      inviteHomes.set(code, home);
    }
    if (home.guildId !== guild.id) return true;
  }
  return false;
}

/** Checks one message at a time per person, so a burst is judged in order and acted on once. */
function inTurn(key, check) {
  const run = (queues.get(key) ?? Promise.resolve()).then(check);
  const done = run.catch(() => {});
  queues.set(key, done);
  done.then(() => queues.get(key) === done && queues.delete(key));
  return run;
}

/** Adds a post to the person's recent ones and returns those still remembered, oldest first. */
function remember(key, post, memory) {
  const posts = (recent.get(key) ?? []).filter((old) => post.at - old.at < memory).slice(-199);
  posts.push(post);
  recent.set(key, posts);
  return posts;
}

/**
 * The same message gives the same print. Short chat with no link or file
 * gives none: "thanks" in three channels is not spam, and neither is a lone
 * role ping or emoji, however long it is in its raw form (<@&123...>).
 */
function fingerprint(message) {
  const text = message.content.toLowerCase().replace(/\s+/g, ' ').trim();
  const words = text.replace(/<a?:\w+:\d+>|<@[!&]?\d+>|<#\d+>|\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim();
  const files = message.attachments.map((file) => `${file.name}:${file.size}`).join(',');
  if (!files && words.length < 20 && !/https?:\/\/|discord\.gg\//.test(text)) return null;
  return `${text}|${files}`;
}

/** What members saw: the text, plus the text inside embeds and buttons that apps add. All empty without the Message Content intent. */
function textOf(message) {
  const parts = [message.content];
  for (const embed of message.embeds) {
    parts.push(embed.title, embed.description, embed.url, embed.footer?.text, ...embed.fields.flatMap((field) => [field.name, field.value]));
  }
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (['label', 'url', 'content'].includes(key) && typeof value === 'string') parts.push(value);
      else walk(value);
    }
  };
  walk(message.components.map((component) => component.toJSON()));
  return parts.filter(Boolean).join('\n');
}

/** Deletes the posts that are still up, one request per channel. */
async function removeAll(posts) {
  const byChannel = new Map();
  for (const post of posts) {
    if (post.gone) continue;
    post.gone = true;
    byChannel.set(post.channel, [...(byChannel.get(post.channel) ?? []), post.id]);
  }
  let count = 0;
  const failed = [];
  for (const [channel, ids] of byChannel) {
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      try {
        await channel.bulkDelete(batch); // a batch of one is a plain delete
        count += batch.length;
      } catch (err) {
        if (err.code === 10008 || err.code === 10003) {
          count += batch.length; // Unknown Message or Channel: someone deleted it first
        } else {
          failed.push(channel.id);
          console.error(`[moderation-bot] could not delete spam in #${channel.name ?? channel.id}:`, err.message);
        }
      }
    }
  }
  return { count, channels: [...new Set(posts.map((post) => post.channel.id))], failed: [...new Set(failed)] };
}

/** Times the person out, or bans them where the server turned banning on, and says what happened. */
async function act(guild, member, user, rules, reason, told) {
  if (rules.ban) {
    try {
      await guild.members.ban(user.id, { reason, deleteMessageSeconds: 3600 });
      return { text: 'Banned, and their messages from the last hour deleted.', banned: true };
    } catch (err) {
      return { text: `Not banned: ${refusal(err)}` };
    }
  }
  if (!member) return { text: 'Not timed out: they are no longer in the server.' };
  if (!member.moderatable) return { text: 'Not timed out: their role is not below the bot\'s role, or the bot lacks Moderate Members.' };
  try {
    await member.timeout(rules.timeoutMinutes * 60_000, reason);
  } catch (err) {
    return { text: `Not timed out: ${refusal(err)}` };
  }
  await member.send(`**${guild.name}:** you were timed out for ${duration(rules.timeoutMinutes)}: ${told}`).catch(() => {});
  return { text: `Timed out for ${duration(rules.timeoutMinutes)}.`, timedOut: true };
}

const refusal = (err) => (err.code === 50013 ? 'Discord refused, the bot is missing a permission or its role is too low.' : `${err.message}.`);

/** The log entry: a copy of the message, who was behind it, what was removed and done, and buttons to undo it or go further. */
async function report(guild, settings, { title, person, app, clicker, why, text, readable, removed, outcome, later }) {
  const where = removed.channels.map((id) => `<#${id}>`).join(' ');
  const failed = removed.failed.length ? `\nCould not delete in ${removed.failed.map((id) => `<#${id}>`).join(' ')}: the bot needs Manage Messages there.` : '';
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0xed4245)
    .setDescription(copyOf(text, readable))
    .addFields(
      { name: app ? 'Ran by' : 'Member', value: `<@${person.id}> ${escapeMarkdown(person.tag)} (${person.id})` },
      ...(app ? [{ name: 'App', value: `${escapeMarkdown(app.tag)} (${app.id}), installed on their own account, not on this server` }] : []),
      ...(clicker ? [{ name: 'Clicked by', value: `<@${clicker.id}> ${escapeMarkdown(clicker.tag)} (${clicker.id}), who pressed a button on the app's message and was left alone` }] : []),
      { name: 'Why', value: why },
      { name: 'Removed', value: `${removed.count} message(s) in ${where}${failed}\n${later}` },
      { name: 'Action', value: outcome.text },
    )
    .setTimestamp();
  const buttons = [
    ...(outcome.timedOut ? [new ButtonBuilder().setCustomId(`mod:untimeout:${person.id}`).setLabel('Remove timeout').setStyle(ButtonStyle.Secondary)] : []),
    ...(outcome.banned ? [] : [new ButtonBuilder().setCustomId(`mod:ban:${person.id}`).setLabel('Ban').setStyle(ButtonStyle.Danger)]),
  ];
  console.log(`[moderation-bot] ${title} in ${guild.name}: ${person.tag} (${person.id}). ${why} ${removed.count} message(s) removed. ${outcome.text}`);
  await postLog(guild, settings, { embeds: [embed], components: buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [] });
}

/** The message as members saw it, in a code block so its links and mentions stay inert. */
function copyOf(text, readable) {
  if (!readable) return 'The text is not shown: the bot does not have the Message Content intent (see /securitycheck).';
  if (!text) return 'The message had no text.';
  return `\`\`\`\n${text.replaceAll('```', '`​`​`').slice(0, 3900)}\n\`\`\``;
}

export function duration(minutes) {
  const [size, unit] = minutes % 1440 === 0 ? [minutes / 1440, 'day'] : minutes % 60 === 0 ? [minutes / 60, 'hour'] : [minutes, 'minute'];
  return `${size} ${unit}${size === 1 ? '' : 's'}`;
}

/** A time given in seconds, in words: 30 seconds, 10 minutes, 1 hour. */
export function span(seconds) {
  return seconds % 60 ? `${seconds} second${seconds === 1 ? '' : 's'}` : duration(seconds / 60);
}

/** A moderator lifted the timeout: stop removing that person's posts. */
export function forgive(guildId, userId) {
  for (const kind of ['app', 'copy']) {
    caught.delete(`${kind}:${guildId}:${userId}`);
    recent.delete(`${kind}:${guildId}:${userId}`);
  }
}

/**
 * A deleted message stops counting as a copy: a member who deletes a post and
 * asks again in the right channel is not spamming. Discord says only which
 * message went, so one the bot no longer holds is found among those remembered.
 * App posts keep counting: deleting spam as it comes must not hide the spammer.
 */
export function forget(messages) {
  const byKey = new Map();
  for (const message of messages) {
    if (!message.guildId) continue;
    const key = message.author ? `copy:${message.guildId}:${message.author.id}`
      : [...recent.keys()].find((known) => known.startsWith(`copy:${message.guildId}:`) && recent.get(known).some((post) => post.id === message.id));
    // Nothing remembered and no check waiting: most deleted messages were never copies.
    if (key && (recent.has(key) || queues.has(key))) byKey.set(key, [...(byKey.get(key) ?? []), message.id]);
  }
  // In turn, so a message deleted while its own check waits is forgotten after that check has counted it.
  return Promise.all([...byKey].map(([key, ids]) => inTurn(key, async () => {
    const posts = (recent.get(key) ?? []).filter((post) => !ids.includes(post.id));
    // No empty lists: the cleanup below reads each one's last post.
    if (posts.length) recent.set(key, posts);
    else recent.delete(key);
  })));
}

/** Forgets people who have gone quiet, and invites looked up a while ago. */
export function sweep(now = Date.now()) {
  // A server can give copies up to an hour, so copy-paste memories are kept that long.
  for (const [key, posts] of recent) if (now - posts.at(-1).at > (key.startsWith('copy:') ? COPY_MEMORY_MAX : APP_MEMORY)) recent.delete(key);
  for (const [key, entry] of caught) if (entry.until < now) caught.delete(key);
  for (const [code, home] of inviteHomes) if (home.until < now) inviteHomes.delete(code);
}
setInterval(sweep, 60_000).unref();

/** /protection: changes the settings given, then shows them all. Returns the changes for the log. */
export async function protectionCommand(interaction, settings) {
  const given = {
    appSpam: interaction.options.getBoolean('app_spam'),
    copySpam: interaction.options.getBoolean('copy_spam'),
    copyChannels: interaction.options.getInteger('copy_channels'),
    copySeconds: interaction.options.getInteger('copy_within'),
    timeoutMinutes: interaction.options.getInteger('timeout_minutes'),
    ban: interaction.options.getBoolean('ban'),
  };
  const changes = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== null));
  if (Object.keys(changes).length > 0) {
    settings.protection = { ...protectionOf(settings), ...changes };
    await save();
  }
  await interaction.reply({ content: describe(interaction.guild, settings), flags: MessageFlags.Ephemeral });
  return changes;
}

function describe(guild, settings) {
  const rules = protectionOf(settings);
  const readable = guild.client.options.intents.has(GatewayIntentBits.MessageContent);
  const action = rules.ban ? 'the person is banned and their messages from the last hour deleted' : `the person is timed out for ${duration(rules.timeoutMinutes)}`;
  const where = settings.logChannelId ? `in <#${settings.logChannelId}>` : 'in the bot\'s console only (pick a channel with /modlog)';
  return [
    '**Automatic spam protection**',
    `- App spam: **${rules.appSpam ? 'on' : 'off'}**. Caught when apps a member installed on their own account post in ${APP_CHANNELS} channels or ${APP_MESSAGES} times within a minute${readable ? ', or post @everyone with an invite to another server' : ''}.`,
    `- Copy-paste spam: **${!rules.copySpam ? 'off' : readable ? 'on' : 'on, but skipped until the bot has the Message Content intent'}**. Caught when a member posts the same message in ${rules.copyChannels} channels within ${span(rules.copySeconds)}${asHacked(rules)}.`,
    `- Then the spam is deleted, ${action}, and it is logged ${where}.`,
    '- Staff are never checked: anyone with Manage Messages, Moderate Members, Kick or Ban Members, Manage Channels, Manage Roles, Manage Server or Administrator.',
  ].join('\n');
}
