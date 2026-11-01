import {
  ActionRowBuilder, ApplicationIntegrationType, ButtonBuilder, ButtonStyle, EmbedBuilder, GatewayIntentBits, MessageFlags, PermissionFlagsBits, escapeMarkdown,
} from 'discord.js';
import { postLog } from './modlog.js';
import { getGuild, protectionOf, save } from './store.js';

const P = PermissionFlagsBits;

// Anyone with one of these is staff, and the automatic checks leave staff alone.
export const STAFF = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.ManageMessages, P.ModerateMembers, P.KickMembers, P.BanMembers];

// App spam. A member can run an app installed on their own Discord account,
// not on this server, and have it post in any channel they can use. Discord
// shows those posts without saying who ran the app, but every one carries
// interaction metadata naming that person, so the bot acts on them.
const APP_WINDOW = 60_000; // within a minute, that person's apps posted
const APP_CHANNELS = 3; // in this many channels,
const APP_MESSAGES = 10; // or this many times.
const APP_MEMORY = 15 * 60_000; // an app can keep posting for 15 minutes after it was run, so cleanup lasts that long

// Copy-paste spam, the usual sign of a hacked account: one member posts the
// same message in three channels within half a minute.
const COPY_WINDOW = 30_000;
const COPY_CHANNELS = 3;
const COPY_MEMORY = 2 * 60_000;

const INVITE = /(?:discord(?:app)?\.com\/invite|discord\.gg)\/[\w-]+/i;
const EVERYONE = /@(?:everyone|here)/i;

const recent = new Map(); // kind:guild:user -> [{ channel, id, at, print, gone }], oldest first
const caught = new Map(); // kind:guild:user -> { until, print }: until then their posts are removed without a new log entry
const queues = new Map(); // kind:guild:user -> the check running for that person

export const isStaff = (member) => member.id === member.guild.ownerId || member.permissions.any(STAFF);

/** Every message the bot can see comes through here. */
export async function protect(message) {
  if (!message.inGuild() || message.author.id === message.client.user.id) return;
  const meta = message.interactionMetadata;
  if (meta && installedOnPersonOnly(meta)) return checkApp(message, meta.user);
  if (message.author.bot || message.webhookId || message.system || !message.member) return;
  // Without the Message Content intent every message arrives empty, so there is nothing to compare.
  if (canRead(message)) await checkCopies(message);
}

const canRead = (message) => message.client.options.intents.has(GatewayIntentBits.MessageContent);

/** The app is installed on the account of the person who ran it, and not on this server. */
function installedOnPersonOnly(meta) {
  const owners = Object.keys(meta.authorizingIntegrationOwners?.toJSON() ?? {});
  return owners.length === 1 && owners[0] === String(ApplicationIntegrationType.UserInstall);
}

async function checkApp(message, runner) {
  const settings = await getGuild(message.guildId);
  const rules = protectionOf(settings);
  if (!rules.appSpam) return;
  const key = `app:${message.guildId}:${runner.id}`;
  await inTurn(key, async () => {
    const now = Date.now();
    const posts = remember(key, { channel: message.channel, id: message.id, at: now }, APP_MEMORY);
    if (caught.get(key)?.until > now) return removeAll(posts);
    const lately = posts.filter((post) => now - post.at < APP_WINDOW);
    const channels = new Set(lately.map((post) => post.channel.id)).size;
    const text = textOf(message);
    const why = (message.mentions.everyone || EVERYONE.test(text)) && INVITE.test(text) ? 'posted @everyone with an invite link'
      : channels >= APP_CHANNELS ? `posted in ${channels} channels within a minute`
        : lately.length >= APP_MESSAGES ? `posted ${lately.length} times within a minute`
          : null;
    if (!why) return;
    const member = await message.guild.members.fetch(runner.id).catch(() => null);
    if (member && isStaff(member)) return;
    caught.set(key, { until: now + APP_MEMORY });
    const removed = await removeAll(posts);
    const outcome = await act(message.guild, member, runner, rules, `Moderation bot: an app they ran ${why}`, 'an app you ran posted spam in the server.');
    await report(message.guild, settings, {
      title: 'App spam removed', person: runner, app: message.author, why: `An app they ran ${why}.`, text, readable: canRead(message), removed, outcome,
      later: 'Anything more their apps post in the next 15 minutes is deleted too.',
    });
  });
}

async function checkCopies(message) {
  if (isStaff(message.member)) return;
  const print = fingerprint(message);
  if (!print) return;
  const settings = await getGuild(message.guildId);
  const rules = protectionOf(settings);
  if (!rules.copySpam) return;
  const key = `copy:${message.guildId}:${message.author.id}`;
  await inTurn(key, async () => {
    const now = Date.now();
    const copies = remember(key, { channel: message.channel, id: message.id, at: now, print }, COPY_MEMORY).filter((post) => post.print === print);
    const earlier = caught.get(key);
    if (earlier?.until > now && earlier.print === print) return removeAll(copies);
    const channels = new Set(copies.filter((post) => now - post.at < COPY_WINDOW).map((post) => post.channel.id)).size;
    if (channels < COPY_CHANNELS) return;
    caught.set(key, { until: now + COPY_MEMORY, print });
    const removed = await removeAll(copies);
    const outcome = await act(message.guild, message.member, message.author, rules, `Moderation bot: the same message in ${channels} channels within 30 seconds`,
      `your account posted the same message in ${channels} channels within 30 seconds. If that was not you, change your Discord password and turn on two-factor authentication.`);
    await report(message.guild, settings, {
      title: 'Copy-paste spam removed', person: message.author, why: `Posted the same message in ${channels} channels within 30 seconds, as hacked accounts do.`,
      text: textOf(message), readable: true, removed, outcome, later: 'More copies in the next 2 minutes are deleted too.',
    });
  });
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

/** The same message gives the same print. Short chat with no link or file gives none: "thanks" in three channels is not spam. */
function fingerprint(message) {
  const text = message.content.toLowerCase().replace(/\s+/g, ' ').trim();
  const files = message.attachments.map((file) => `${file.name}:${file.size}`).join(',');
  if (!files && text.length < 20 && !/https?:\/\/|discord\.gg\//.test(text)) return null;
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
        if (err.code === 10008) {
          count += batch.length; // Unknown Message: someone deleted it first
        } else {
          failed.push(channel.id);
          console.error(`[moderation-bot] could not delete spam in #${channel.name}:`, err.message);
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
async function report(guild, settings, { title, person, app, why, text, readable, removed, outcome, later }) {
  const where = removed.channels.map((id) => `<#${id}>`).join(' ');
  const failed = removed.failed.length ? `\nCould not delete in ${removed.failed.map((id) => `<#${id}>`).join(' ')}: the bot needs Manage Messages there.` : '';
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0xed4245)
    .setDescription(copyOf(text, readable))
    .addFields(
      { name: app ? 'Ran by' : 'Member', value: `<@${person.id}> ${escapeMarkdown(person.tag)} (${person.id})` },
      ...(app ? [{ name: 'App', value: `${escapeMarkdown(app.tag)} (${app.id}), installed on their own account, not on this server` }] : []),
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

/** A moderator lifted the timeout: stop removing that person's posts. */
export function forgive(guildId, userId) {
  for (const kind of ['app', 'copy']) {
    caught.delete(`${kind}:${guildId}:${userId}`);
    recent.delete(`${kind}:${guildId}:${userId}`);
  }
}

// Forget people who have gone quiet.
setInterval(() => {
  const now = Date.now();
  for (const [key, posts] of recent) if (now - posts.at(-1).at > APP_MEMORY) recent.delete(key);
  for (const [key, entry] of caught) if (entry.until < now) caught.delete(key);
}, 60_000).unref();

/** /protection: changes the settings given, then shows them all. Returns the changes for the log. */
export async function protectionCommand(interaction, settings) {
  const given = {
    appSpam: interaction.options.getBoolean('app_spam'),
    copySpam: interaction.options.getBoolean('copy_spam'),
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
    `- App spam: **${rules.appSpam ? 'on' : 'off'}**. Caught when apps a member installed on their own account post in ${APP_CHANNELS} channels or ${APP_MESSAGES} times within a minute${readable ? ', or post @everyone with an invite link' : ''}.`,
    `- Copy-paste spam: **${!rules.copySpam ? 'off' : readable ? 'on' : 'on, but skipped until the bot has the Message Content intent'}**. Caught when a member posts the same message in ${COPY_CHANNELS} channels within 30 seconds, as hacked accounts do.`,
    `- Then the spam is deleted, ${action}, and it is logged ${where}.`,
    '- Staff are never checked: anyone with Manage Messages, Moderate Members, Kick or Ban Members, Manage Channels, Manage Roles, Manage Server or Administrator.',
  ].join('\n');
}
