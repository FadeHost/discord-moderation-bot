import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

// Warnings, the log channel and the protection settings persist to the FadeHost bot's /data volume.
const DATA_FILE = process.env.CONFIG_PATH || '/data/moderation-config.json';

// What the automatic protection does until /protection changes it. Banning is
// opt-in: a timeout given by mistake is lifted with one click, a ban is not.
export const PROTECTION_DEFAULTS = { appSpam: true, copySpam: true, copyChannels: 3, timeoutMinutes: 1440, ban: false };

// How many channels the same message may reach before it counts as copy-paste
// spam. One would make every long message spam, so 2 is the floor.
export const COPY_CHANNELS_MIN = 2;
export const COPY_CHANNELS_MAX = 10;

let cache = null;
let loading = null;
let saving = Promise.resolve();

// Every message asks for its server's settings, so the first burst after a
// start must share one read rather than each replace what the others loaded.
function load() {
  loading ??= readFile(DATA_FILE, 'utf8').then(async (text) => {
    try {
      return JSON.parse(text);
    } catch (err) {
      // Kept aside rather than overwritten by an empty start: the warnings in it are not lost.
      const aside = `${DATA_FILE}.unreadable-${Date.now()}`;
      await rename(DATA_FILE, aside).catch(() => {});
      console.error(`[moderation-bot] the saved settings could not be read (${err.message}); kept as ${aside}, starting empty`);
      return null;
    }
  }, () => null).then((data) => {
    cache = data?.guilds ? data : { guilds: {} };
    return cache;
  });
  return loading;
}

/** Saves one at a time, through a temporary file, so a stop mid-write leaves the last good copy whole. */
export function save() {
  saving = saving.then(async () => {
    try {
      await mkdir(dirname(DATA_FILE), { recursive: true });
      await writeFile(`${DATA_FILE}.tmp`, JSON.stringify(cache, null, 2));
      await rename(`${DATA_FILE}.tmp`, DATA_FILE);
    } catch (err) {
      console.error('[moderation-bot] could not save:', err.message);
    }
  });
  return saving;
}

export async function getGuild(guildId) {
  const data = await load();
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      logChannelId: (process.env.MODLOG_CHANNEL_ID || '').trim() || null,
      warnings: {},
    };
    await save();
  }
  return data.guilds[guildId];
}

/** The server's protection settings. Servers saved before protection existed have none stored and get the defaults. */
export function protectionOf(settings) {
  const rules = { ...PROTECTION_DEFAULTS, ...settings.protection };
  // A hand-edited file can hold anything; outside the range the default applies.
  const { copyChannels } = rules;
  if (!Number.isInteger(copyChannels) || copyChannels < COPY_CHANNELS_MIN || copyChannels > COPY_CHANNELS_MAX) {
    rules.copyChannels = PROTECTION_DEFAULTS.copyChannels;
  }
  return rules;
}
