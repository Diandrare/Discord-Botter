import { ChannelType, type EmbedBuilder, type Guild, type TextChannel } from "discord.js";
import { logger } from "../lib/logger";

/** Channel names that will be used for moderation logs (checked in order) */
const LOG_CHANNEL_NAMES = ["mod-logs", "mod-log", "modlogs", "modlog", "fox-logs", "server-logs"];

export async function sendModLog(guild: Guild, embed: EmbedBuilder): Promise<void> {
  try {
    const ch = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildText &&
        LOG_CHANNEL_NAMES.includes(c.name.toLowerCase()),
    ) as TextChannel | undefined;

    if (!ch) return; // Silently skip — log channel is optional
    await ch.send({ embeds: [embed] });
  } catch (err) {
    logger.warn({ err, guild: guild.name }, "Could not send moderation log");
  }
}
