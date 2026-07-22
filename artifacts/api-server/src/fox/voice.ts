import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
  StreamType,
  type AudioPlayer,
} from "@discordjs/voice";
import { ChannelType, type Client, type VoiceBasedChannel } from "discord.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { logger } from "../lib/logger";

const VOICE_CHANNEL_NAME = "Nobar";
const STREAM_URL = "https://youtu.be/8KY6ZE44scQ?si=wzWWhVjPTl0Wj4Mb";
const RECONNECT_DELAY_MS = 5_000;
const CHANNEL_RETRY_DELAY_MS = 30_000;

// Resolve the yt-dlp binary bundled with youtube-dl-exec
const _require = createRequire(import.meta.url);
const ytdlExecConstants = _require("youtube-dl-exec/src/constants") as {
  YOUTUBE_DL_PATH: string;
};
const YTDLP_BIN = ytdlExecConstants.YOUTUBE_DL_PATH;

async function startStream(player: AudioPlayer): Promise<void> {
  try {
    const ytdlp = spawn(YTDLP_BIN, [
      STREAM_URL,
      "--format", "bestaudio",
      "--output", "-",
      "--quiet",
      "--no-playlist",
    ]);

    ytdlp.stderr.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) logger.warn({ msg }, "yt-dlp stderr");
    });

    ytdlp.on("error", (err) => {
      logger.error({ err: err.message }, "yt-dlp spawn error");
    });

    const resource = createAudioResource(ytdlp.stdout, {
      inputType: StreamType.Arbitrary,
    });

    player.play(resource);
    logger.info({ channel: VOICE_CHANNEL_NAME }, "Fox started streaming audio");
  } catch (err) {
    logger.error({ err }, "Failed to start audio stream — retrying in 5s");
    setTimeout(() => startStream(player).catch(() => undefined), RECONNECT_DELAY_MS);
  }
}

function findVoiceChannel(client: Client): VoiceBasedChannel | null {
  for (const guild of client.guilds.cache.values()) {
    const ch = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildVoice &&
        c.name.toLowerCase() === VOICE_CHANNEL_NAME.toLowerCase(),
    );
    if (ch?.isVoiceBased()) return ch;
  }
  return null;
}

async function connect(client: Client): Promise<void> {
  const channel = findVoiceChannel(client);

  if (!channel) {
    logger.warn(
      { channelName: VOICE_CHANNEL_NAME },
      `Voice channel not found — retrying in ${CHANNEL_RETRY_DELAY_MS / 1000}s`,
    );
    setTimeout(() => connect(client), CHANNEL_RETRY_DELAY_MS);
    return;
  }

  logger.info(
    { guild: channel.guild.name, channel: channel.name },
    "Fox joining voice channel",
  );

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });

  connection.subscribe(player);
  await startStream(player);

  // Loop when the track finishes
  player.on(AudioPlayerStatus.Idle, () => {
    logger.info("Stream ended — looping");
    startStream(player).catch((err: unknown) =>
      logger.error({ err }, "Error restarting stream on idle"),
    );
  });

  // Debounced player error recovery
  let lastErrorAt = 0;
  player.on("error", (err) => {
    const now = Date.now();
    if (now - lastErrorAt < 10_000) return;
    lastErrorAt = now;
    logger.error({ err: err.message }, "Audio player error — restarting stream");
    setTimeout(() => startStream(player).catch(() => undefined), RECONNECT_DELAY_MS);
  });

  // Handle voice disconnects
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
      logger.warn("Voice connection lost — reconnecting in 5s");
      setTimeout(() => connect(client), RECONNECT_DELAY_MS);
    }
  });
}

export async function setupVoice(client: Client): Promise<void> {
  // Verify binary exists before attempting to connect
  const binPath = path.resolve(YTDLP_BIN);
  logger.info({ binPath }, "Using yt-dlp binary");
  await connect(client);
}
