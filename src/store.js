import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// Warnings, the log channel and the protection settings persist to the FadeHost bot's /data volume.
const DATA_FILE = process.env.CONFIG_PATH || '/data/moderation-config.json';

// What the automatic protection does until /protection changes it. Banning is
// opt-in: a timeout given by mistake is lifted with one click, a ban is not.
export const PROTECTION_DEFAULTS = { appSpam: true, copySpam: true, timeoutMinutes: 1440, ban: false };

let cache = null;

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch {
    cache = { guilds: {} };
  }
  return cache;
}

export async function save() {
  try {
    await mkdir(dirname(DATA_FILE), { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('[moderation-bot] could not save:', err.message);
  }
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
  return { ...PROTECTION_DEFAULTS, ...settings.protection };
}
