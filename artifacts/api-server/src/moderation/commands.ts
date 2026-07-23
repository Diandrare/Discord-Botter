import {
  ChannelType,
  PermissionFlagsBits,
  type GuildMember,
  type Message,
  type TextChannel,
  type PermissionsString,
} from "discord.js";
import { logger } from "../lib/logger";
import {
  buildActionEmbed,
  buildEmbed,
  buildErrorEmbed,
  buildSuccessEmbed,
  COLOR_DEFAULT,
  COLOR_WARN,
} from "./embed";
import { sendModLog } from "./logs";
import {
  addWarning,
  clearWarnings,
  getWarnings,
  removeWarning,
} from "./warnings";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CommandContext {
  message: Message;
  args: string[];
  member: GuildMember;
}

type CommandHandler = (ctx: CommandContext) => Promise<void>;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function reply(message: Message, content: { embeds: ReturnType<typeof buildEmbed>[] }) {
  return message.reply(content).catch(() => undefined);
}

async function err(message: Message, text: string) {
  return reply(message, { embeds: [buildErrorEmbed(text)] });
}

async function ok(message: Message, title: string, description?: string) {
  return reply(message, { embeds: [buildSuccessEmbed(title, description)] });
}

/** Parse a mention or raw ID into a GuildMember, returns null on failure */
async function resolveMember(message: Message, raw: string | undefined): Promise<GuildMember | null> {
  if (!raw || !message.guild) return null;
  const id = raw.replace(/[<@!>]/g, "");
  try {
    return await message.guild.members.fetch(id);
  } catch {
    return null;
  }
}

/** Check that the acting member has permission and outranks the target */
function checkHierarchy(
  actor: GuildMember,
  target: GuildMember,
  message: Message,
): string | null {
  if (target.id === message.guild!.ownerId) {
    return "You cannot moderate the server owner.";
  }
  if (
    actor.roles.highest.comparePositionTo(target.roles.highest) <= 0 &&
    actor.id !== message.guild!.ownerId
  ) {
    return "You cannot moderate a member with an equal or higher role.";
  }
  if (
    message.guild!.members.me &&
    message.guild!.members.me.roles.highest.comparePositionTo(target.roles.highest) <= 0
  ) {
    return "Fox's role is too low to take action against this member.";
  }
  return null;
}

/** Check that the acting member has a Discord permission */
function requirePerm(member: GuildMember, ...perms: PermissionsString[]): string | null {
  for (const perm of perms) {
    if (!member.permissions.has(perm)) {
      return `You need the **${perm}** permission to use this command.`;
    }
  }
  return null;
}

/** Parse duration string (e.g. "10m", "2h", "1d") to milliseconds */
function parseDuration(str: string): number | null {
  const match = /^(\d+)(s|m|h|d|w)$/i.exec(str);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  switch (match[2]!.toLowerCase()) {
    case "s": return n * 1_000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    case "d": return n * 86_400_000;
    case "w": return n * 7 * 86_400_000;
    default: return null;
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

const HANDLERS: Record<string, CommandHandler> = {

  // fban <@user> [reason]
  async fban({ message, args, member }) {
    const permErr = requirePerm(member, "BanMembers");
    if (permErr) { await err(message, permErr); return; }

    const target = await resolveMember(message, args[0]);
    if (!target) { await err(message, "Could not find that member."); return; }

    const hierErr = checkHierarchy(member, target, message);
    if (hierErr) { await err(message, hierErr); return; }

    const reason = args.slice(1).join(" ") || "No reason provided.";
    try {
      await target.ban({ reason, deleteMessageSeconds: 604_800 /* 7 days */ });
      const embed = buildActionEmbed({ action: "Member Banned", emoji: "🔨", target, moderator: member, reason, color: COLOR_DEFAULT });
      await reply(message, { embeds: [embed] });
      await sendModLog(message.guild!, embed);
    } catch (e) {
      await err(message, `Failed to ban: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  // fkick <@user> [reason]
  async fkick({ message, args, member }) {
    const permErr = requirePerm(member, "KickMembers");
    if (permErr) { await err(message, permErr); return; }

    const target = await resolveMember(message, args[0]);
    if (!target) { await err(message, "Could not find that member."); return; }

    const hierErr = checkHierarchy(member, target, message);
    if (hierErr) { await err(message, hierErr); return; }

    const reason = args.slice(1).join(" ") || "No reason provided.";
    try {
      await target.kick(reason);
      const embed = buildActionEmbed({ action: "Member Kicked", emoji: "👢", target, moderator: member, reason, color: COLOR_DEFAULT });
      await reply(message, { embeds: [embed] });
      await sendModLog(message.guild!, embed);
    } catch (e) {
      await err(message, `Failed to kick: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  // ftimeout <@user> <duration> [reason]   e.g. ftimeout @user 10m spamming
  async ftimeout({ message, args, member }) {
    const permErr = requirePerm(member, "ModerateMembers");
    if (permErr) { await err(message, permErr); return; }

    const target = await resolveMember(message, args[0]);
    if (!target) { await err(message, "Could not find that member."); return; }

    const hierErr = checkHierarchy(member, target, message);
    if (hierErr) { await err(message, hierErr); return; }

    const duration = parseDuration(args[1] ?? "");
    if (!duration) { await err(message, "Invalid duration. Examples: `10m`, `2h`, `1d`, `1w`"); return; }

    const MAX_TIMEOUT = 28 * 24 * 3_600_000;
    if (duration > MAX_TIMEOUT) { await err(message, "Maximum timeout duration is 28 days."); return; }

    const reason = args.slice(2).join(" ") || "No reason provided.";
    try {
      await target.timeout(duration, reason);
      const embed = buildActionEmbed({
        action: "Member Timed Out", emoji: "⏱️", target, moderator: member, reason, color: COLOR_WARN,
        extra: [{ name: "⏳ Duration", value: args[1]!, inline: true }],
      });
      await reply(message, { embeds: [embed] });
      await sendModLog(message.guild!, embed);
    } catch (e) {
      await err(message, `Failed to timeout: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  // funtimeout <@user> [reason]
  async funtimeout({ message, args, member }) {
    const permErr = requirePerm(member, "ModerateMembers");
    if (permErr) { await err(message, permErr); return; }

    const target = await resolveMember(message, args[0]);
    if (!target) { await err(message, "Could not find that member."); return; }

    const reason = args.slice(1).join(" ") || "Timeout removed.";
    try {
      await target.timeout(null, reason);
      const embed = buildActionEmbed({ action: "Timeout Removed", emoji: "✅", target, moderator: member, reason, color: COLOR_DEFAULT });
      await reply(message, { embeds: [embed] });
      await sendModLog(message.guild!, embed);
    } catch (e) {
      await err(message, `Failed to remove timeout: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  // fwarn <@user> <reason>
  async fwarn({ message, args, member }) {
    const permErr = requirePerm(member, "ModerateMembers");
    if (permErr) { await err(message, permErr); return; }

    const target = await resolveMember(message, args[0]);
    if (!target) { await err(message, "Could not find that member."); return; }

    if (target.user.bot) { await err(message, "You cannot warn bots."); return; }

    const reason = args.slice(1).join(" ");
    if (!reason) { await err(message, "Please provide a reason for the warning."); return; }

    const warning = addWarning(message.guild!.id, target.id, member.id, reason);
    const warnings = getWarnings(message.guild!.id, target.id);

    const embed = buildActionEmbed({
      action: "Member Warned", emoji: "⚠️", target, moderator: member, reason, color: COLOR_WARN,
      extra: [{ name: "🆔 Warning ID", value: `#${warning.id}`, inline: true }, { name: "📊 Total Warns", value: `${warnings.length}`, inline: true }],
    });

    await reply(message, { embeds: [embed] });
    await sendModLog(message.guild!, embed);

    // DM the target
    target.send({ embeds: [buildEmbed({
      title: "⚠️ You received a warning",
      description: `You were warned in **${message.guild!.name}**.\n**Reason:** ${reason}`,
      color: COLOR_WARN,
      footer: `Warning ID: #${warning.id}`,
    })] }).catch(() => undefined);
  },

  // fwarnings <@user>
  async fwarnings({ message, args }) {
    const target = await resolveMember(message, args[0]);
    if (!target) { await err(message, "Could not find that member."); return; }

    const warnings = getWarnings(message.guild!.id, target.id);

    if (!warnings.length) {
      await ok(message, `✅ No warnings for ${target.user.tag}`);
      return;
    }

    const fields = warnings.slice(-10).map((w) => ({
      name: `#${w.id} — <t:${Math.floor(new Date(w.timestamp).getTime() / 1000)}:R>`,
      value: `**Reason:** ${w.reason}\n**By:** <@${w.moderatorId}>`,
    }));

    await reply(message, { embeds: [buildEmbed({
      title: `⚠️ Warnings for ${target.user.tag}`,
      description: `Total: **${warnings.length}** warning(s) (showing last 10)`,
      fields,
      color: COLOR_WARN,
      footer: `User ID: ${target.id}`,
    })] });
  },

  // funwarn <warnId>
  async funwarn({ message, args, member }) {
    const permErr = requirePerm(member, "ModerateMembers");
    if (permErr) { await err(message, permErr); return; }

    const id = parseInt(args[0] ?? "", 10);
    if (isNaN(id)) { await err(message, "Provide a valid warning ID number."); return; }

    const removed = removeWarning(message.guild!.id, id);
    if (!removed) { await err(message, `Warning #${id} not found.`); return; }

    await ok(message, `✅ Warning #${id} removed`, `**Reason was:** ${removed.reason}`);
  },

  // fclear <amount>
  async fclear({ message, args, member }) {
    const permErr = requirePerm(member, "ManageMessages");
    if (permErr) { await err(message, permErr); return; }

    const amount = parseInt(args[0] ?? "", 10);
    if (isNaN(amount) || amount < 1 || amount > 100) {
      await err(message, "Provide a number between 1 and 100.");
      return;
    }

    const ch = message.channel as TextChannel;
    try {
      // Delete the command message itself first
      await message.delete().catch(() => undefined);
      const deleted = await ch.bulkDelete(amount, true /* skip old messages */);
      const notice = await ch.send({ embeds: [buildSuccessEmbed(`🗑️ Cleared ${deleted.size} message(s)`)] });
      setTimeout(() => notice.delete().catch(() => undefined), 4_000);
    } catch (e) {
      await err(message, `Could not clear: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  // flock [reason]
  async flock({ message, args, member }) {
    const permErr = requirePerm(member, "ManageChannels");
    if (permErr) { await err(message, permErr); return; }

    const ch = message.channel as TextChannel;
    const everyoneRole = message.guild!.roles.everyone;
    try {
      await ch.permissionOverwrites.edit(everyoneRole, { SendMessages: false });
      const reason = args.join(" ") || "Channel locked by moderator.";
      const embed = buildEmbed({ title: "🔒 Channel Locked", description: reason, color: COLOR_DEFAULT, footer: `By ${member.user.tag}` });
      await reply(message, { embeds: [embed] });
    } catch (e) {
      await err(message, `Failed to lock: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  // funlock [reason]
  async funlock({ message, args, member }) {
    const permErr = requirePerm(member, "ManageChannels");
    if (permErr) { await err(message, permErr); return; }

    const ch = message.channel as TextChannel;
    const everyoneRole = message.guild!.roles.everyone;
    try {
      await ch.permissionOverwrites.edit(everyoneRole, { SendMessages: null });
      const reason = args.join(" ") || "Channel unlocked.";
      const embed = buildEmbed({ title: "🔓 Channel Unlocked", description: reason, color: COLOR_DEFAULT, footer: `By ${member.user.tag}` });
      await reply(message, { embeds: [embed] });
    } catch (e) {
      await err(message, `Failed to unlock: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  // fsay [#channel] <message>
  async fsay({ message, args, member }) {
    const permErr = requirePerm(member, "ManageMessages");
    if (permErr) { await err(message, permErr); return; }

    if (!args.length) { await err(message, "Provide a message to say."); return; }

    // Check if first arg is a channel mention
    const channelMentionMatch = args[0]?.match(/^<#(\d+)>$/);
    let targetChannel = message.channel as TextChannel;
    let text: string;

    if (channelMentionMatch) {
      const found = message.guild!.channels.cache.get(channelMentionMatch[1]!);
      if (found?.type === ChannelType.GuildText) {
        targetChannel = found as TextChannel;
        text = args.slice(1).join(" ");
      } else {
        text = args.join(" ");
      }
    } else {
      text = args.join(" ");
    }

    if (!text) { await err(message, "Provide the message text."); return; }

    try {
      await targetChannel.send(text);
      await message.delete().catch(() => undefined);
    } catch (e) {
      await err(message, `Could not send: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  // fembed <title> | <description>
  async fembed({ message, args, member }) {
    const permErr = requirePerm(member, "ManageMessages");
    if (permErr) { await err(message, permErr); return; }

    const full = args.join(" ");
    const parts = full.split("|").map((s) => s.trim());
    const title = parts[0];
    const description = parts[1];

    if (!title) { await err(message, "Usage: `fembed Title | Description`"); return; }

    const embed = buildEmbed({ title, description, color: COLOR_DEFAULT, footer: `Sent by ${member.user.tag}` });
    try {
      await (message.channel as TextChannel).send({ embeds: [embed] });
      await message.delete().catch(() => undefined);
    } catch (e) {
      await err(message, `Could not send embed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  // fping
  async fping({ message }) {
    const sent = await reply(message, { embeds: [buildEmbed({ title: "🏓 Pinging...", timestamp: false })] });
    if (!sent) return;
    const latency = sent.createdTimestamp - message.createdTimestamp;
    const ws = message.client.ws.ping;
    await sent.edit({ embeds: [buildEmbed({
      title: "🏓 Pong!",
      fields: [
        { name: "📡 Message Latency", value: `${latency}ms`, inline: true },
        { name: "💓 WebSocket", value: `${ws}ms`, inline: true },
      ],
      color: COLOR_DEFAULT,
      timestamp: false,
    })] });
  },

  // fhelp
  async fhelp({ message }) {
    await reply(message, { embeds: [buildEmbed({
      title: "🦊 Fox Moderation — Help",
      description: "All commands use the **f** prefix. Arguments in `<>` are required, `[]` are optional.",
      fields: [
        { name: "🔨 Moderation", value: [
          "`fban <@user> [reason]` — Ban a member",
          "`fkick <@user> [reason]` — Kick a member",
          "`ftimeout <@user> <duration> [reason]` — Timeout (10m, 2h, 1d...)",
          "`funtimeout <@user> [reason]` — Remove timeout",
        ].join("\n") },
        { name: "⚠️ Warnings", value: [
          "`fwarn <@user> <reason>` — Warn a member",
          "`fwarnings <@user>` — View member warnings",
          "`funwarn <id>` — Remove a warning by ID",
        ].join("\n") },
        { name: "🛠️ Utility", value: [
          "`fclear <1–100>` — Bulk delete messages",
          "`flock [reason]` — Lock the channel",
          "`funlock [reason]` — Unlock the channel",
          "`fsay [#channel] <text>` — Send message as Fox",
          "`fembed <title> | <description>` — Send embed",
          "`fping` — Show bot latency",
          "`fhelp` — This menu",
        ].join("\n") },
      ],
      color: COLOR_DEFAULT,
      footer: "Doomestic Fox Bot",
    })] });
  },
};

// ── Entry point ────────────────────────────────────────────────────────────────

const VALID_CMDS = new Set(Object.keys(HANDLERS));

/**
 * Returns true if the message was a mod command (consumed), false otherwise.
 * Call this BEFORE the Fox AI handler.
 */
export async function handleModCommand(message: Message): Promise<boolean> {
  if (message.author.bot) return false;
  if (!message.guild) return false;
  if (!message.member) return false;

  const parts = message.content.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? "";

  if (!VALID_CMDS.has(cmd)) return false;

  const handler = HANDLERS[cmd]!;
  try {
    await handler({ message, args: parts.slice(1), member: message.member as GuildMember });
  } catch (err) {
    logger.error({ err, cmd }, "Mod command threw an unhandled error");
    await message.reply({ embeds: [buildErrorEmbed("An unexpected error occurred.")] }).catch(() => undefined);
  }
  return true;
}
