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
import { setupVoice } from "./fox/voice";
import { handleModCommand } from "./moderation/commands";
import { initStats, initStatsForGuild, scheduleStatsUpdate } from "./stats/serverStats";

const FOX_PEOPLE_ROLE_NAME = "Fox People";
const UNVERIFIED_ROLE_NAME = "Unverified";

const STATUSES = [
  { name: "Doomestic",     type: ActivityType.Watching },
  { name: "Fox",           type: ActivityType.Playing },
  { name: "Miaww",         type: ActivityType.Listening },
  { name: "Doomestic Bot", type: ActivityType.Watching },
  { name: "the Night",     type: ActivityType.Watching },
];

export function startBot(): void {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN is not set — Discord bot will not start");
    return;
  }

  if (!process.env["GROQ_API_KEY"]) {
    logger.warn("GROQ_API_KEY is not set — Fox AI chat will be disabled");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,    // Privileged
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildPresences,  // Privileged — needed for online count in server stats
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.MessageContent,  // Privileged
      GatewayIntentBits.DirectMessages,
    ],
  });

  // ── Ready ────────────────────────────────────────────────────────────────────
  client.once(Events.ClientReady, (readyClient) => {
    logger.info({ tag: readyClient.user.tag }, "Discord bot is ready");

    // Status rotation
    let index = 0;
    readyClient.user.setPresence({ activities: [STATUSES[0]!], status: "online" });
    setInterval(() => {
      index = (index + 1) % STATUSES.length;
      readyClient.user.setPresence({ activities: [STATUSES[index]!], status: "online" });
    }, 15_000);

    // 24/7 Voice
    setupVoice(readyClient).catch((err: unknown) => {
      logger.error({ err }, "Failed to set up voice");
    });

    // Server stats — initialise for all guilds on startup
    initStats(readyClient).catch((err: unknown) => {
      logger.error({ err }, "Failed to initialise server stats");
    });
  });

  // ── Guild joined (bot added to a new server) ──────────────────────────────
  client.on(Events.GuildCreate, (guild) => {
    initStatsForGuild(guild).catch((err: unknown) => {
      logger.error({ err, guild: guild.name }, "Failed to init stats for new guild");
    });
  });

  // ── Member joined — update stats ──────────────────────────────────────────
  client.on(Events.GuildMemberAdd, (member) => {
    scheduleStatsUpdate(member.guild);
  });

  // ── Member left — update stats ────────────────────────────────────────────
  client.on(Events.GuildMemberRemove, (member) => {
    scheduleStatsUpdate(member.guild);
  });

  // ── Presence changed — update online count ────────────────────────────────
  client.on(Events.PresenceUpdate, (_old, newPresence) => {
    if (!newPresence.guild) return;
    scheduleStatsUpdate(newPresence.guild);
  });

  // ── Role management: remove Unverified when Fox People is granted ─────────
  client.on(
    Events.GuildMemberUpdate,
    async (
      oldMember: GuildMember | PartialGuildMember,
      newMember: GuildMember,
    ) => {
      try {
        const hadFoxPeople = oldMember.roles.cache.some((r) => r.name === FOX_PEOPLE_ROLE_NAME);
        const hasFoxPeople = newMember.roles.cache.some((r) => r.name === FOX_PEOPLE_ROLE_NAME);

        // Only act when Fox People role was just added
        if (hadFoxPeople || !hasFoxPeople) return;

        const unverifiedRole = newMember.guild.roles.cache.find(
          (r) => r.name === UNVERIFIED_ROLE_NAME,
        );

        if (!unverifiedRole) {
          logger.warn({ guild: newMember.guild.name }, `Role "${UNVERIFIED_ROLE_NAME}" not found`);
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
    },
  );

  // ── Messages — moderation commands first, then Fox AI ────────────────────
  client.on(Events.MessageCreate, (message) => {
    (async () => {
      // Mod commands take priority — they return true if consumed
      const consumed = await handleModCommand(message);
      if (consumed) return;

      // Fox AI chat
      await handleMessage(message);
    })().catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in message handler");
    });
  });

  // ── Login ─────────────────────────────────────────────────────────────────
  client.login(token).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes("disallowed intents")) {
      logger.warn(
        "One or more privileged intents are not enabled in the Discord Developer Portal.\n" +
        "Required intents: Message Content, Server Members, Presence\n" +
        "Go to: https://discord.com/developers/applications → your app → Bot → Privileged Gateway Intents\n" +
        "Enable all three, then restart the bot.\n" +
        "Falling back to minimal mode (role management only).",
      );

      // Minimal fallback so role management keeps working
      const fallbackClient = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
      });

      fallbackClient.once(Events.ClientReady, (readyClient) => {
        logger.info({ tag: readyClient.user.tag }, "Discord bot running in fallback mode");
      });

      fallbackClient.on(
        Events.GuildMemberUpdate,
        async (oldMember: GuildMember | PartialGuildMember, newMember: GuildMember) => {
          try {
            const hadFoxPeople = oldMember.roles.cache.some((r) => r.name === FOX_PEOPLE_ROLE_NAME);
            const hasFoxPeople = newMember.roles.cache.some((r) => r.name === FOX_PEOPLE_ROLE_NAME);
            if (hadFoxPeople || !hasFoxPeople) return;

            const unverifiedRole = newMember.guild.roles.cache.find((r) => r.name === UNVERIFIED_ROLE_NAME);
            if (!unverifiedRole || !newMember.roles.cache.has(unverifiedRole.id)) return;

            await newMember.roles.remove(unverifiedRole, "Member verified via Fox People role");
            logger.info({ userId: newMember.id }, `Removed "${UNVERIFIED_ROLE_NAME}" (fallback mode)`);
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
