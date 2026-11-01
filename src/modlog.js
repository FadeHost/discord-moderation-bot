/** Posts to the server's moderation log channel, if one is set. Nobody is pinged by a log entry. */
export async function postLog(guild, settings, payload) {
  if (!settings.logChannelId) return false;
  const channel = guild.channels.cache.get(settings.logChannelId);
  if (!channel) return false;
  try {
    await channel.send({ allowedMentions: { parse: [] }, ...payload });
    return true;
  } catch (err) {
    // An AutoMod rule that does not exempt the bot blocks a log entry quoting
    // an invite link (error 200000). Post it again with the links broken up.
    if (err.code === 200000) {
      try {
        await channel.send({ allowedMentions: { parse: [] }, ...defanged(payload) });
        return true;
      } catch (again) {
        err = again;
      }
    }
    console.error('[moderation-bot] log not posted:', err.message);
    return false;
  }
}

/** The payload with discord.gg and discord.com/invite links written as discord[.]gg, which AutoMod keyword rules do not match. */
function defanged(payload) {
  const json = JSON.stringify({ content: payload.content, embeds: payload.embeds?.map((embed) => embed.toJSON?.() ?? embed) });
  const { content, embeds } = JSON.parse(json.replace(/discord(app)?\.(gg|com)/gi, 'discord$1[.]$2'));
  return { ...payload, content, embeds };
}

/** Runs each step of a change and words the outcome; one refused step does not stop the rest. */
export async function runSteps(steps) {
  const lines = [];
  for (const step of steps) {
    try {
      await step.run();
      lines.push(`Done: ${step.text}`);
    } catch (err) {
      const why = err.code === 50013 ? 'Discord refused: the bot is missing a permission, or the role is above the bot\'s role' : err.message;
      lines.push(`Not done: ${step.text} (${why})`);
    }
  }
  return lines;
}

/** Joins lines up to a length Discord accepts, saying how many were left out. */
export function fit(lines, max = 1900) {
  const shown = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > max - 40) {
      shown.push(`...and ${lines.length - shown.length} more`);
      break;
    }
    shown.push(line);
    length += line.length + 1;
  }
  return shown.join('\n');
}
