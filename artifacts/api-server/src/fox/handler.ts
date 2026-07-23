import {
  ChannelType,
  type Message,
  type TextChannel,
} from "discord.js";
import { logger } from "../lib/logger";
import { type ChatMessage, generateFoxReply } from "./gemini";
import { detectGreeting } from "./greetings";

// ── Conversation memory ────────────────────────────────────────────────────────

interface ConversationEntry {
  messages: ChatMessage[];
  lastActivity: number;
}

/**
 * Per-channel conversation history.
 * Keyed by channel ID (or "DM:<userId>" for DMs).
 */
const conversations = new Map<string, ConversationEntry>();

const MAX_HISTORY = 14;          // messages kept per channel (7 turns)
const HISTORY_TTL_MS = 30 * 60 * 1000; // 30 minutes idle → clear

function conversationKey(message: Message): string {
  if (message.channel.type === ChannelType.DM) {
    return `DM:${message.author.id}`;
  }
  return message.channel.id;
}

function getHistory(message: Message): ChatMessage[] {
  const key = conversationKey(message);
  const entry = conversations.get(key);
  if (!entry) return [];

  // Expired — wipe it
  if (Date.now() - entry.lastActivity > HISTORY_TTL_MS) {
    conversations.delete(key);
    return [];
  }

  return entry.messages;
}

function pushHistory(message: Message, userText: string, assistantText: string): void {
  const key = conversationKey(message);
  const entry = conversations.get(key) ?? { messages: [], lastActivity: 0 };

  entry.messages.push(
    { role: "user", content: userText },
    { role: "assistant", content: assistantText },
  );

  // Trim to last MAX_HISTORY messages
  if (entry.messages.length > MAX_HISTORY) {
    entry.messages = entry.messages.slice(-MAX_HISTORY);
  }

  entry.lastActivity = Date.now();
  conversations.set(key, entry);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Main handler ──────────────────────────────────────────────────────────────

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

    const history = getHistory(message);
    const reply = await generateFoxReply(prompt, history);
    await message.reply(reply);

    // Save this turn to memory
    pushHistory(message, prompt, reply);

    logger.info(
      { userId: message.author.id, channel: buildContextHeader(message) },
      "Fox replied to message",
    );
  } catch (err) {
    logger.error({ err, userId: message.author.id }, "Fox failed to reply");

    await message
      .reply("🦊 Hmm, ada sesuatu yang sedikit mengganggu Fox tadi... coba lagi nanti ya~ 🤍")
      .catch(() => undefined);
  }
}
