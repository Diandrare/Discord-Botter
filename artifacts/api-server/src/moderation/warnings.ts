import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger";

export interface Warning {
  id: number;
  userId: string;
  guildId: string;
  moderatorId: string;
  reason: string;
  timestamp: string;
}

type GuildData = {
  _nextId: number;
  byUser: Record<string, Warning[]>;
};

type Store = Record<string, GuildData>;

// Persist next to the running process working directory (artifacts/api-server/)
const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "warnings.json");

let store: Store = {};

function load(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(FILE)) {
      store = JSON.parse(readFileSync(FILE, "utf-8")) as Store;
    }
  } catch (err) {
    logger.error({ err }, "Failed to load warnings.json — starting fresh");
    store = {};
  }
}

function persist(): void {
  try {
    writeFileSync(FILE, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    logger.error({ err }, "Failed to save warnings.json");
  }
}

load();

function guild(guildId: string): GuildData {
  if (!store[guildId]) store[guildId] = { _nextId: 1, byUser: {} };
  return store[guildId]!;
}

export function addWarning(
  guildId: string,
  userId: string,
  moderatorId: string,
  reason: string,
): Warning {
  const g = guild(guildId);
  if (!g.byUser[userId]) g.byUser[userId] = [];

  const warning: Warning = {
    id: g._nextId++,
    userId,
    guildId,
    moderatorId,
    reason,
    timestamp: new Date().toISOString(),
  };

  g.byUser[userId]!.push(warning);
  persist();
  return warning;
}

export function getWarnings(guildId: string, userId: string): Warning[] {
  return guild(guildId).byUser[userId] ?? [];
}

export function getAllWarnings(guildId: string): Warning[] {
  return Object.values(guild(guildId).byUser).flat();
}

export function removeWarning(guildId: string, warnId: number): Warning | null {
  const g = guild(guildId);
  for (const [userId, list] of Object.entries(g.byUser)) {
    const idx = list.findIndex((w) => w.id === warnId);
    if (idx !== -1) {
      const [removed] = list.splice(idx, 1);
      persist();
      return removed ?? null;
    }
  }
  return null;
}

export function clearWarnings(guildId: string, userId: string): number {
  const g = guild(guildId);
  const count = (g.byUser[userId] ?? []).length;
  delete g.byUser[userId];
  persist();
  return count;
}
