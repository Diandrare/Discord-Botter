import { Client, Events, GatewayIntentBits, type GuildMember, type PartialGuildMember } from "discord.js";
import { logger } from "./lib/logger";

const FOX_PEOPLE_ROLE_NAME = "Fox People";
const UNVERIFIED_ROLE_NAME = "Unverified";

export function startBot(): void {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN is not set — Discord bot will not start");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
    ],
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info({ tag: readyClient.user.tag }, "Discord bot is ready");
  });

  client.on(Events.GuildMemberUpdate, async (
    oldMember: GuildMember | PartialGuildMember,
    newMember: GuildMember,
  ) => {
    try {
      const hadFoxPeople = oldMember.roles.cache.some(
        (r) => r.name === FOX_PEOPLE_ROLE_NAME,
      );
      const hasFoxPeople = newMember.roles.cache.some(
        (r) => r.name === FOX_PEOPLE_ROLE_NAME,
      );

      // Only act when Fox People role was just added
      if (hadFoxPeople || !hasFoxPeople) return;

      const unverifiedRole = newMember.guild.roles.cache.find(
        (r) => r.name === UNVERIFIED_ROLE_NAME,
      );

      if (!unverifiedRole) {
        logger.warn(
          { guild: newMember.guild.name },
          `Role "${UNVERIFIED_ROLE_NAME}" not found in guild`,
        );
        return;
      }

      if (!newMember.roles.cache.has(unverifiedRole.id)) return;

      await newMember.roles.remove(unverifiedRole, "Member verified via Fox People role");

      logger.info(
        { userId: newMember.id, guild: newMember.guild.name },
        `Removed "${UNVERIFIED_ROLE_NAME}" from member who received "${FOX_PEOPLE_ROLE_NAME}"`,
      );
    } catch (err) {
      logger.error({ err, userId: newMember.id }, "Failed to update member roles");
    }
  });

  client.login(token).catch((err: unknown) => {
    logger.error({ err }, "Discord bot failed to log in");
  });
}
