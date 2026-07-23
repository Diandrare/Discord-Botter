import { EmbedBuilder, GuildMember, type User } from "discord.js";

/** Doomestic brand color — pure black left bar on embeds */
export const COLOR_DEFAULT = 0x000000;
export const COLOR_SUCCESS = 0x2b2b2b;
export const COLOR_DANGER = 0x111111;
export const COLOR_WARN = 0x1a1a1a;
export const COLOR_INFO = 0x0d0d0d;

export interface ModEmbedOptions {
  title: string;
  description?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  color?: number;
  footer?: string;
  thumbnail?: string;
  timestamp?: boolean;
}

export function buildEmbed(opts: ModEmbedOptions): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(opts.color ?? COLOR_DEFAULT)
    .setTitle(opts.title);

  if (opts.description) embed.setDescription(opts.description);
  if (opts.fields?.length) embed.addFields(opts.fields);
  if (opts.footer) embed.setFooter({ text: `🦊 Doomestic • ${opts.footer}` });
  if (opts.thumbnail) embed.setThumbnail(opts.thumbnail);
  if (opts.timestamp !== false) embed.setTimestamp();

  return embed;
}

/** Shared action embed used for ban/kick/timeout/warn log entries */
export function buildActionEmbed(opts: {
  action: string;
  emoji: string;
  target: User | GuildMember;
  moderator: User | GuildMember;
  reason: string;
  extra?: Array<{ name: string; value: string; inline?: boolean }>;
  color?: number;
}): EmbedBuilder {
  const targetUser = opts.target instanceof GuildMember ? opts.target.user : opts.target;
  const modUser = opts.moderator instanceof GuildMember ? opts.moderator.user : opts.moderator;

  return buildEmbed({
    title: `${opts.emoji} ${opts.action}`,
    color: opts.color ?? COLOR_DEFAULT,
    fields: [
      { name: "👤 Target", value: `${targetUser.tag} (<@${targetUser.id}>)`, inline: true },
      { name: "🛡 Moderator", value: `${modUser.tag}`, inline: true },
      { name: "📝 Reason", value: opts.reason || "No reason provided." },
      ...(opts.extra ?? []),
    ],
    footer: `Target ID: ${targetUser.id}`,
  });
}

/** Simple error embed */
export function buildErrorEmbed(description: string): EmbedBuilder {
  return buildEmbed({ title: "⛔ Error", description, color: COLOR_DANGER, timestamp: false });
}

/** Simple success embed */
export function buildSuccessEmbed(title: string, description?: string): EmbedBuilder {
  return buildEmbed({ title, description, color: COLOR_SUCCESS, timestamp: false });
}
