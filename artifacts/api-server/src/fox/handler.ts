import {
  ChannelType,
  type Message,
  type TextChannel,
} from "discord.js";
import { logger } from "../lib/logger";
import { generateFoxReply } from "./gemini";
import { detectGreeting } from "./greetings";

/** Strip bot mention tags from content */
function stripMentions(content: string): string {
  return content.replace(/<@!?\d+>/g, "").trim();
}

/** Build a context header so Fox knows who it's talking to */
function buildContextHeader(message: Message): string {
  const username = message.author.username;
  const channelName =
    message.channel.type === ChannelType.GuildText
      ? `#${(message.channel as TextChannel).name}`
      : "DM";
  return `[Username: ${username}, Channel: ${channelName}]`;
}

export async function handleMessage(message: Message): Promise<void> {
  // Never reply to bots
  if (message.author.bot) return;

  const content = message.content.trim();
  if (!content) return;

  const clientUser = message.client.user;
  if (!clientUser) return;

  const isMentioned = message.mentions.has(clientUser);
  const startsWithFox = /^fox\b/i.test(content);
  const greeting = detectGreeting(content);

  // Only respond when explicitly addressed or greeted
  if (!isMentioned && !startsWithFox && !greeting) return;

  // Build the cleaned user text
  let userText = content;

  if (isMentioned) {
    userText = stripMentions(userText);
  }

  if (startsWithFox && !isMentioned) {
    // Remove leading "fox" trigger word so the AI sees the real message
    userText = userText.replace(/^fox\s*/i, "").trim();
  }

  // Fallback when someone just says "fox" or mentions with no text
  if (!userText) {
    userText = greeting
      ? content
      : "(the user addressed Fox without saying anything else)";
  }

  const context = buildContextHeader(message);
  const prompt = `${context}\n${userText}`;

  try {
    // Show typing indicator while generating
    if (
      message.channel.type === ChannelType.GuildText ||
      message.channel.type === ChannelType.DM
    ) {
      await message.channel.sendTyping();
    }

    const reply = await generateFoxReply(prompt);
    await message.reply(reply);

    logger.info(
      { userId: message.author.id, channel: buildContextHeader(message) },
      "Fox replied to message",
    );
  } catch (err) {
    logger.error({ err, userId: message.author.id }, "Fox failed to reply");

    // Graceful fallback — never crash silently
    await message
      .reply(
        "🦊 Hmm, sepertinya ada sesuatu yang mengganggu. Coba lagi nanti ya~ 🤍",
      )
      .catch(() => undefined);
  }
}
