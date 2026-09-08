import 'dotenv/config';
import { spawn } from 'child_process';
import { Client, GatewayIntentBits, ChannelType, Collection } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, VoiceConnectionStatus } from '@discordjs/voice';
import { Readable } from 'node:stream';
import gapi from 'google-tts-api';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const { getAudioUrl } = gapi;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const RECONNECT_DELAY_MS = 5000;
const CONNECTION_READY_TIMEOUT_MS = 5000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
  ],
});

client.commands = new Collection();

async function loadCommands() {
  try {
    const commandsPath = join(__dirname, 'commands');
    console.log(`Loading commands from ${commandsPath}`);

    async function getAllFiles(directory, fileList = []) {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory() && entry.name !== 'modules') {
          await getAllFiles(entryPath, fileList);
        } else if (entry.name.endsWith('.js')) {
          fileList.push(entryPath);
        }
      }
      return fileList;
    }

    const commandFiles = await getAllFiles(commandsPath);
    console.log(`Found ${commandFiles.length} command files`);

    for (const filePath of commandFiles) {
      try {
        const module = await import(pathToFileURL(filePath).href);
        const command = module.default;

        if (!command.data || !command.execute) {
          console.warn(`Command at ${filePath} missing data or execute`);
          continue;
        }

        client.commands.set(command.data.name, command);
        console.log(`Loaded command: ${command.data.name}`);
      } catch (error) {
        console.error(`Error loading command ${filePath}:`, error);
      }
    }

    console.log(`Total commands loaded: ${client.commands.size}`);
  } catch (error) {
    console.error('Error loading commands:', error);
  }
}

async function registerCommands() {
  try {
    const commands = Array.from(client.commands.values()).map(cmd => cmd.data.toJSON());
    
    if (commands.length === 0) {
      console.warn('No commands to register');
      return;
    }

    console.log(`Registering ${commands.length} commands...`);
    await client.rest.put(`/applications/${client.application.id}/commands`, { body: commands });
    console.log('Commands registered successfully');
  } catch (error) {
    console.error('Error registering commands:', error);
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

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    console.log(`Joined voice channel: ${channel.name} (${channel.id})`);

    return new Promise((resolve) => {
      if (connection.state.status === VoiceConnectionStatus.Ready) {
        console.log('[joinTargetVoiceChannel] Connection is ready immediately');
        resolve();
        return;
      }

      const handler = (state) => {
        console.log(`[joinTargetVoiceChannel] Connection state changed to: ${state.status}`);
        if (state.status === VoiceConnectionStatus.Ready) {
          connection.off('stateChange', handler);
          resolve();
        }
      };

      connection.on('stateChange', handler);

      setTimeout(() => {
        connection.off('stateChange', handler);
        console.warn('[joinTargetVoiceChannel] Connection ready timeout');
        resolve();
      }, 10000);
    });
  } catch (error) {
    console.error('Error joining target voice channel:', error);
  }
}

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

async function waitForConnectionReady(connection) {
  return new Promise((resolve) => {
    if (connection.state.status === VoiceConnectionStatus.Ready) {
      resolve();
      return;
    }

    const handler = (state) => {
      if (state.status === VoiceConnectionStatus.Ready) {
        connection.off('stateChange', handler);
        resolve();
      }
    };

    connection.on('stateChange', handler);

    setTimeout(() => {
      connection.off('stateChange', handler);
      console.warn('[announceEvent] Connection ready timeout, attempting to play anyway');
      resolve();
    }, CONNECTION_READY_TIMEOUT_MS);
  });
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

    await sendTextAnnouncement(member, type, voiceChannel);

    const guildId = voiceChannel.guildId;
    const connection = getVoiceConnection(guildId);
    if (!connection) {
      console.error('Bot is not connected to voice channel.');
      return;
    }

    console.log(`[announceEvent] Waiting for connection to be ready. Current state: ${connection.state.status}`);
    await waitForConnectionReady(connection);

    const text = type === 'joined'
      ? `${member.displayName || member.user.username} joined the voice channel`
      : `${member.displayName || member.user.username} left the voice channel`;

    const url = await getAudioUrl(text, {
      lang: 'en',
      slow: false,
      host: 'https://translate.google.com',
    });

    console.log(`[announceEvent] Fetching audio from: ${url}`);
    const audioResponse = await fetch(url);
    const audioBuffer = await audioResponse.arrayBuffer();

    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-v', 'quiet',
      'pipe:1'
    ]);

    const chunks = [];
    ffmpeg.stdout.on('data', chunk => chunks.push(chunk));

    ffmpeg.stderr.on('data', (data) => {
      console.log(`[FFmpeg] ${data.toString()}`);
    });

    ffmpeg.on('error', (error) => {
      console.error('[FFmpeg error]', error);
    });

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

    const pcmBuffer = Buffer.concat(chunks);
    console.log(`[announceEvent] Created PCM buffer, size: ${pcmBuffer.byteLength}`);

    const player = createAudioPlayer();
    const audioStream = Readable.from([pcmBuffer]);
    const resource = createAudioResource(audioStream, {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });

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

    console.log(`[announceEvent] About to play audio, connection state: ${connection.state.status}`);
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
    await registerCommands();
  } catch (error) {
    console.error('Error during ready event:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction, {}, client);
    } catch (error) {
      console.error(`Error executing command ${interaction.commandName}:`, error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'There was an error executing this command!' });
      } else {
        await interaction.reply({ content: 'There was an error executing this command!', ephemeral: true });
      }
    }
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

async function start() {
  if (!DISCORD_TOKEN) {
    console.error('DISCORD_TOKEN is not set. Cannot log in.');
    process.exit(1);
  }

  try {
    console.log('Loading commands...');
    await loadCommands();
    
    console.log('Logging in to Discord...');
    await client.login(DISCORD_TOKEN);
  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

console.log('=== Father-Time Starting ===');
start();

export default client;

