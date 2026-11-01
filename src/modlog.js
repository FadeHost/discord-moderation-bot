/** Posts to the server's moderation log channel, if one is set. Nobody is pinged by a log entry. */
export async function postLog(guild, settings, payload) {
  if (!settings.logChannelId) return false;
  const channel = guild.channels.cache.get(settings.logChannelId);
  if (!channel) return false;
  try {
    await channel.send({ allowedMentions: { parse: [] }, ...payload });
    return true;
  } catch (err) {
    console.error('[moderation-bot] log not posted:', err.message);
    return false;
  }
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
