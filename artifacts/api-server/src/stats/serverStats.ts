import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type VoiceChannel,
  type CategoryChannel,
} from "discord.js";
import { logger } from "../lib/logger";

// ── Config ─────────────────────────────────────────────────────────────────────

const CATEGORY_NAME = "📊 SERVER STATS";

const STAT_CHANNELS = [
  { key: "members", label: (n: number) => `👥・Members: ${n}` },
  { key: "humans",  label: (n: number) => `🧑・Humans: ${n}` },
  { key: "bots",    label: (n: number) => `🤖・Bots: ${n}` },
  { key: "online",  label: (n: number) => `🟢・Online: ${n}` },
] as const;

type StatKey = (typeof STAT_CHANNELS)[number]["key"];

// ── State ──────────────────────────────────────────────────────────────────────

/** guildId → { key → channelId } */
const channelIds = new Map<string, Partial<Record<StatKey, string>>>();

/** guildId → debounce timer */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** guildId → last known values (to skip no-op updates) */
const lastValues = new Map<string, Partial<Record<StatKey, number>>>();

// ── Stats calculation ─────────────────────────────────────────────────────────

function calcStats(guild: Guild): Record<StatKey, number> {
  const members = guild.members.cache;
  const total = members.size;
  const bots = members.filter((m) => m.user.bot).size;
  const humans = total - bots;
  const online = members.filter(
    (m) =>
      !m.user.bot &&
      (m.presence?.status === "online" ||
        m.presence?.status === "idle" ||
        m.presence?.status === "dnd"),
  ).size;

  return { members: total, humans, bots, online };
}

// ── Channel management ────────────────────────────────────────────────────────

async function getOrCreateCategory(guild: Guild): Promise<CategoryChannel> {
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME,
  ) as CategoryChannel | undefined;

  if (existing) return existing;

  logger.info({ guild: guild.name }, "Creating SERVER STATS category");
  return guild.channels.create({
    name: CATEGORY_NAME,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages],
      },
    ],
  });
}

async function getOrCreateStatChannel(
  guild: Guild,
  category: CategoryChannel,
  key: StatKey,
  initialName: string,
): Promise<VoiceChannel> {
  const ids = channelIds.get(guild.id) ?? {};

  // Check by stored ID first
  const storedId = ids[key];
  if (storedId) {
    const ch = guild.channels.cache.get(storedId);
    if (ch?.type === ChannelType.GuildVoice) return ch as VoiceChannel;
  }

  // Fallback: find by matching emoji prefix in the category
  const emoji = STAT_CHANNELS.find((s) => s.key === key)!.label(0).split("・")[0]!;
  const found = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildVoice &&
      c.parentId === category.id &&
      c.name.startsWith(emoji),
  ) as VoiceChannel | undefined;

  if (found) {
    ids[key] = found.id;
    channelIds.set(guild.id, ids);
    return found;
  }

  // Create it
  logger.info({ guild: guild.name, key }, "Creating stat channel");
  const created = await guild.channels.create({
    name: initialName,
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.Connect],
        allow: [PermissionFlagsBits.ViewChannel],
      },
    ],
  });

  ids[key] = created.id;
  channelIds.set(guild.id, ids);
  return created;
}

async function ensureChannels(guild: Guild): Promise<void> {
  const category = await getOrCreateCategory(guild);

  // Create all channels sequentially to avoid rate-limit spikes on first run
  for (const stat of STAT_CHANNELS) {
    await getOrCreateStatChannel(guild, category, stat.key, stat.label(0));
  }

  // Place channels into the category if they were found elsewhere
  const ids = channelIds.get(guild.id) ?? {};
  for (const stat of STAT_CHANNELS) {
    const id = ids[stat.key];
    if (!id) continue;
    const ch = guild.channels.cache.get(id) as VoiceChannel | undefined;
    if (ch && ch.parentId !== category.id) {
      await ch.setParent(category.id, { lockPermissions: false }).catch(() => undefined);
    }
  }
}

// ── Update logic ──────────────────────────────────────────────────────────────

async function applyUpdate(guild: Guild): Promise<void> {
  try {
    await guild.members.fetch(); // Refresh member cache
    const stats = calcStats(guild);
    const prev = lastValues.get(guild.id) ?? {};
    const ids = channelIds.get(guild.id) ?? {};

    for (const stat of STAT_CHANNELS) {
      const newVal = stats[stat.key];
      if (prev[stat.key] === newVal) continue; // Skip if unchanged

      const id = ids[stat.key];
      if (!id) continue;
      const ch = guild.channels.cache.get(id) as VoiceChannel | undefined;
      if (!ch) continue;

      const newName = stat.label(newVal);
      if (ch.name !== newName) {
        await ch.setName(newName).catch((e: unknown) =>
          logger.warn({ err: e, key: stat.key }, "Failed to rename stat channel"),
        );
      }
    }

    lastValues.set(guild.id, { ...stats });
  } catch (err) {
    logger.error({ err, guild: guild.name }, "Failed to update server stats");
  }
}

/** Debounced update — coalesces rapid events (2s window) */
export function scheduleStatsUpdate(guild: Guild): void {
  const existing = debounceTimers.get(guild.id);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    debounceTimers.delete(guild.id);
    applyUpdate(guild).catch(() => undefined);
  }, 2_000);

  debounceTimers.set(guild.id, timer);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

export async function initStats(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.members.fetch();
      await ensureChannels(guild);
      await applyUpdate(guild);
      logger.info({ guild: guild.name }, "Server stats initialised");
    } catch (err) {
      logger.error({ err, guild: guild.name }, "Failed to initialise server stats for guild");
    }
  }
}

export async function initStatsForGuild(guild: Guild): Promise<void> {
  try {
    await guild.members.fetch();
    await ensureChannels(guild);
    await applyUpdate(guild);
    logger.info({ guild: guild.name }, "Server stats initialised for new guild");
  } catch (err) {
    logger.error({ err, guild: guild.name }, "Failed to initialise server stats");
  }
}
