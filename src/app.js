import 'dotenv/config';
import { spawn } from 'child_process';
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } from '@discordjs/voice';
import { Readable } from 'node:stream';
import gapi from 'google-tts-api';
const { getAudioUrl } = gapi;

const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const RECONNECT_DELAY_MS = 5000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
});

async function sendTextAnnouncement(member, type, voiceChannel) {
  try {
    if (!member || member.user?.bot) {
      return;
    }

    const username = member.displayName || member.user.username;
    const text = type === 'joined'
      ? `**${username}** joined the voice channel`
      : `**${username}** left the voice channel`;

    await voiceChannel.send(text);
    console.log(`[sendTextAnnouncement] Sent: ${text}`);
  } catch (error) {
    console.error('Error sending text announcement:', error);
  }
}

async function joinTargetVoiceChannel() {
  try {
    if (!VOICE_CHANNEL_ID) {
      console.error('VOICE_CHANNEL_ID is not set. Cannot join voice channel.');
      return;
    }

    const channel = await client.channels.fetch(VOICE_CHANNEL_ID).catch((error) => {
      console.error(`Failed to fetch voice channel ${VOICE_CHANNEL_ID}:`, error);
      return null;
    });

    if (!channel) {
      console.error(`Voice channel ${VOICE_CHANNEL_ID} not found.`);
      return;
    }

    if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
      console.error(`Channel ${VOICE_CHANNEL_ID} is not a voice channel.`);
      return;
    }

    joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    console.log(`Joined voice channel: ${channel.name} (${channel.id})`);
  } catch (error) {
    console.error('Error joining target voice channel:', error);
  }
}

async function announceEvent(member, type, channelName) {
  console.log(`[announceEvent] Called with member: ${member?.user?.username}, type: ${type}, channel: ${channelName}`);
  try {
    if (!member || member.user?.bot) {
      return;
    }

    const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID).catch((error) => {
      console.error(`Failed to fetch voice channel ${VOICE_CHANNEL_ID}:`, error);
      return null;
    });

    if (!voiceChannel || !voiceChannel.isVoiceBased?.()) {
      console.error(`Voice channel ${VOICE_CHANNEL_ID} not found or not voice-based.`);
      return;
    }

    // Send text announcement
    await sendTextAnnouncement(member, type, voiceChannel);

    const guildId = voiceChannel.guildId;
    const connection = getVoiceConnection(guildId);
    if (!connection) {
      console.error('Bot is not connected to voice channel.');
      return;
    }

    const text = type === 'joined'
      ? `${member.displayName || member.user.username} joined the voice channel`
      : `${member.displayName || member.user.username} left the voice channel`;

    // Generate TTS audio URL
    const url = await getAudioUrl(text, {
      lang: 'en',
      slow: false,
      host: 'https://translate.google.com',
    });

    // Fetch audio as buffer
    console.log(`[announceEvent] Fetching audio from: ${url}`);
    const audioResponse = await fetch(url);
    const audioBuffer = await audioResponse.arrayBuffer();

    // Use FFmpeg to decode MP3 to PCM and buffer output
    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-v', 'quiet',  // Suppress stderr
      'pipe:1'
    ]);

    // Collect all PCM data
    const chunks = [];
    ffmpeg.stdout.on('data', chunk => chunks.push(chunk));

    ffmpeg.stderr.on('data', (data) => {
      console.log(`[FFmpeg] ${data.toString()}`);
    });

    ffmpeg.on('error', (error) => {
      console.error('[FFmpeg error]', error);
    });

    // Pipe input and wait for completion
    await new Promise((resolve, reject) => {
      ffmpeg.on('close', (code) => {
        if (code === 0) {
          console.log('[FFmpeg] Encoding complete');
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
      ffmpeg.stdin.write(Buffer.from(audioBuffer));
      ffmpeg.stdin.end();
    });

    // Create resource from complete PCM buffer using Readable.from()
    const pcmBuffer = Buffer.concat(chunks);
    console.log(`[announceEvent] Created PCM buffer, size: ${pcmBuffer.byteLength}`);

    const player = createAudioPlayer();
    const audioStream = Readable.from([pcmBuffer]);
    const resource = createAudioResource(audioStream, {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });

    // Log all player state changes
    player.on(AudioPlayerStatus.Playing, () => {
      console.log(`[Player] Now playing: ${text}`);
    });

    player.on(AudioPlayerStatus.Idle, () => {
      console.log(`[Player] Finished playing: ${text}`);
      player.stop();
    });

    player.on('error', error => {
      console.error('[Player error]', error);
    });

    console.log(`[announceEvent] About to play audio, connection state: ${connection.state?.status}`);
    player.play(resource);
    connection.subscribe(player);
    console.log(`[announceEvent] Called player.play() and connection.subscribe()`);
  } catch (error) {
    console.error('Error announcing voice state event:', error);
  }
}

client.once('ready', async () => {
  try {
    console.log(`Logged in as ${client.user.tag}`);

    client.user.setPresence({
      activities: [{ name: 'for members joining', type: 3 }],
      status: 'online',
    });

    await joinTargetVoiceChannel();
  } catch (error) {
    console.error('Error during ready event:', error);
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const botLeft =
      oldState.member?.id === client.user.id &&
      oldState.channelId &&
      !newState.channelId;

    if (botLeft) {
      console.log('Bot was disconnected from the voice channel. Reconnecting...');
      setTimeout(() => {
        joinTargetVoiceChannel().catch((error) => {
          console.error('Error reconnecting to voice channel:', error);
        });
      }, RECONNECT_DELAY_MS);
      return;
    }

    if (!oldState.channelId && newState.channelId) {
      await announceEvent(newState.member, 'joined', newState.channel?.name ?? 'the channel');
      return;
    }

    if (oldState.channelId && !newState.channelId) {
      await announceEvent(oldState.member, 'left', oldState.channel?.name ?? 'the channel');
      return;
    }
  } catch (error) {
    console.error('Error handling voiceStateUpdate:', error);
  }
});

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

client.on('shardError', (error) => {
  console.error('Discord shard error:', error);
});

async function shutdown(reason) {
  console.log(`Shutting down (${reason})...`);
  try {
    const connection = getVoiceConnection(client.guilds.cache.first()?.id);
    if (connection) {
      connection.destroy();
    }
  } catch (error) {
    console.error('Error destroying voice connection during shutdown:', error);
  }

  try {
    client.destroy();
    console.log('Discord client destroyed.');
  } catch (error) {
    console.error('Error destroying Discord client:', error);
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set. Cannot log in.');
  process.exit(1);
}

client.login(DISCORD_TOKEN).catch((error) => {
  console.error('Failed to log in to Discord:', error);
  process.exit(1);
});

export default client;

