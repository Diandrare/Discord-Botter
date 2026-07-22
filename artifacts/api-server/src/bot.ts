import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  type GuildMember,
  type PartialGuildMember,
} from "discord.js";
import { logger } from "./lib/logger";
import { handleMessage } from "./fox/handler";

const FOX_PEOPLE_ROLE_NAME = "Fox People";
const UNVERIFIED_ROLE_NAME = "Unverified";

const STATUSES = [
  { name: "Doomestic", type: ActivityType.Watching },
  { name: "Fox", type: ActivityType.Playing },
  { name: "Miaww", type: ActivityType.Listening },
  { name: "Doomestic Bot", type: ActivityType.Watching },
  { name: "the Night", type: ActivityType.Watching },
];

export function startBot(): void {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN is not set — Discord bot will not start");
    return;
  }

  const groqKey = process.env["GROQ_API_KEY"];
  if (!groqKey) {
    logger.warn("GROQ_API_KEY is not set — Fox AI chat will be disabled");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,   // Privileged — already enabled
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // Privileged — must be enabled in Discord Developer Portal → Bot → Privileged Gateway Intents
      GatewayIntentBits.DirectMessages,
    ],
  });

  // ── Ready ────────────────────────────────────────────────────────────────
  client.once(Events.ClientReady, (readyClient) => {
    logger.info({ tag: readyClient.user.tag }, "Discord bot is ready");

    let index = 0;
    readyClient.user.setPresence({
      activities: [STATUSES[0]!],
      status: "online",
    });

    setInterval(() => {
      index = (index + 1) % STATUSES.length;
      readyClient.user.setPresence({
        activities: [STATUSES[index]!],
        status: "online",
      });
    }, 15_000);
  });

  // ── Role management: remove Unverified when Fox People is granted ────────
  client.on(
    Events.GuildMemberUpdate,
    async (
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

        await newMember.roles.remove(
          unverifiedRole,
          "Member verified via Fox People role",
        );

        logger.info(
          { userId: newMember.id, guild: newMember.guild.name },
          `Removed "${UNVERIFIED_ROLE_NAME}" from member who received "${FOX_PEOPLE_ROLE_NAME}"`,
        );
      } catch (err) {
        logger.error(
          { err, userId: newMember.id },
          "Failed to update member roles",
        );
      }
    },
  );

  // ── Fox AI chat ──────────────────────────────────────────────────────────
  client.on(Events.MessageCreate, (message) => {
    // Fire-and-forget; errors are caught inside handleMessage
    handleMessage(message).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in Fox message handler");
    });
  });

  // ── Login ────────────────────────────────────────────────────────────────
  client.login(token).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes("disallowed intents")) {
      logger.warn(
        "MessageContent intent is not enabled in the Discord Developer Portal. " +
          "Fox AI chat requires it. " +
          "Go to https://discord.com/developers/applications → your app → Bot → " +
          "Privileged Gateway Intents → enable 'Message Content Intent', then restart the bot.",
      );

      // Reconnect with only the intents that are already permitted so that
      // role-management (Unverified removal) keeps working in the meantime.
      const fallbackClient = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
        ],
      });

      fallbackClient.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { tag: readyClient.user.tag },
          "Discord bot running in fallback mode (role management only — AI chat disabled until MessageContent intent is enabled)",
        );
      });

      fallbackClient.on(
        Events.GuildMemberUpdate,
        async (
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
            if (hadFoxPeople || !hasFoxPeople) return;

            const unverifiedRole = newMember.guild.roles.cache.find(
              (r) => r.name === UNVERIFIED_ROLE_NAME,
            );
            if (!unverifiedRole) return;
            if (!newMember.roles.cache.has(unverifiedRole.id)) return;

            await newMember.roles.remove(
              unverifiedRole,
              "Member verified via Fox People role",
            );
            logger.info(
              { userId: newMember.id },
              `Removed "${UNVERIFIED_ROLE_NAME}" (fallback mode)`,
            );
          } catch (fallbackErr) {
            logger.error({ err: fallbackErr }, "Fallback role update failed");
          }
        },
      );

      fallbackClient.login(token).catch((loginErr: unknown) => {
        logger.error({ err: loginErr }, "Fallback bot login also failed");
      });
    } else {
      logger.error({ err }, "Discord bot failed to log in");
    }
  });
}
