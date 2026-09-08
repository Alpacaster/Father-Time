import { 
    Client, 
    Collection, 
    GatewayIntentBits, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    StringSelectMenuBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ChannelType 
} from 'discord.js';
import { REST, Routes } from 'discord.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import express from 'express';
import cron from 'node-cron';
import { spawn } from 'child_process';
import { joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, VoiceConnectionStatus } from '@discordjs/voice';
import { Readable } from 'node:stream';
import gapi from 'google-tts-api';
const { getAudioUrl } = gapi;

// Polyfill for ReadableStream in older Node.js environments
import { ReadableStream } from 'web-streams-polyfill';
if (typeof global.ReadableStream === 'undefined') {
    global.ReadableStream = ReadableStream;
}

import config from './config/index.js';
import { initializeDatabase, getFromDb, setInDb, deleteFromDb } from './utils/database.js';
import { getGuildConfig } from './services/guildConfig.js';
import { getAFKKey } from './utils/afk.js';
import { giveawayKey, getGuildGiveaways } from './utils/giveaways.js';
import { handleReactionRoles } from './handlers/reactionRoles.js';
import { createEmbed, errorEmbed, successEmbed } from './utils/embeds.js';
import { getLevelingConfig, getUserLevelData, saveUserLevelData, getXpForLevel } from './utils/database.js';
import { addXp } from './services/xpSystem.js';
import { getServerCounters, saveServerCounters, updateCounter } from './services/counterService.js';
import { logger } from './utils/logger.js';
import { checkBirthdays } from './services/birthdayService.js';
import { checkGiveaways } from './services/giveawayService.js';
import { loadCommands, registerCommands as registerSlashCommands } from './handlers/loaders/commandLoader.js';

const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const RECONNECT_DELAY_MS = 5000;
const CONNECTION_READY_TIMEOUT_MS = 5000;

class TitanBot extends Client {
  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageTyping,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.DirectMessageTyping,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.GuildIntegrations,
        GatewayIntentBits.GuildEmojisAndStickers,
        GatewayIntentBits.GuildScheduledEvents,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMessagePolls,
        GatewayIntentBits.DirectMessagePolls,
        GatewayIntentBits.AutoModerationConfiguration,
        GatewayIntentBits.AutoModerationExecution,
        GatewayIntentBits.GuildModeration
      ],
    });

    this.config = config;
    this.commands = new Collection();
    this.events = new Collection();
    this.buttons = new Collection();
    this.selectMenus = new Collection();
    this.modals = new Collection();
    this.cooldowns = new Collection();
    this.db = null;
    this.rest = new REST({ version: '10' }).setToken(config.bot.token);
  }

  async start() {
    console.log('TitanBot.start() called');
    try {
      console.log('Step 1: Waiting for environment variables...');
      // Wait a moment for environment variables to be fully loaded (Railway specific)
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      console.log('Step 2: Initializing database...');
      // Initialize database
      const dbInstance = await initializeDatabase();
      this.db = dbInstance.db;
      console.log('Database initialized successfully');
      
      console.log('Step 3: Starting web server...');
      // Start the web server for keep-alive
      this.startWebServer();
      
      console.log('Step 4: Loading commands...');
      logger.info('Starting to load commands...');
      await loadCommands(this);
      logger.info(`Command loading completed. Total commands loaded: ${this.commands.size}`);
      console.log(`Commands loaded: ${this.commands.size}`);
      
      console.log('Step 5: Loading handlers...');
      // Load other handlers
      await this.loadHandlers();
      
      console.log('Step 6: Logging into Discord...');
      // Login to Discord first
      await this.login(this.config.bot.token);
      console.log('Discord login successful');
      
      console.log('Step 7: Registering commands...');
      // Register commands after login
      await this.registerCommands();

      console.log('Step 8: Setting up voice channel listener...');
      // Setup voice announcements
      await this.setupVoiceAnnouncements();
      
      console.log('Step 9: Setting up cron jobs...');
      logger.info('Bot is running!');
      
      // Start cron jobs after bot is ready
      this.setupCronJobs();
      console.log('TitanBot startup completed successfully');
    } catch (error) {
      console.error('Failed to start bot:', error);
      logger.error('Failed to start bot:', error);
      process.exit(1);
    }
  }

  async setupVoiceAnnouncements() {
    if (!VOICE_CHANNEL_ID) {
      console.warn('VOICE_CHANNEL_ID not set. Voice announcements disabled.');
      return;
    }

    // Join target voice channel
    await this.joinTargetVoiceChannel();

    // Setup voiceStateUpdate listener
    this.on('voiceStateUpdate', async (oldState, newState) => {
      await this.handleVoiceStateUpdate(oldState, newState);
    });
  }

  async joinTargetVoiceChannel() {
    try {
      const channel = await this.channels.fetch(VOICE_CHANNEL_ID).catch((error) => {
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

      // Wait for connection to be ready
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

        // Timeout after 10 seconds
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

  async sendTextAnnouncement(member, type, voiceChannel) {
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

  async waitForConnectionReady(connection) {
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

      // Timeout after 5 seconds
      setTimeout(() => {
        connection.off('stateChange', handler);
        console.warn('[announceEvent] Connection ready timeout, attempting to play anyway');
        resolve();
      }, CONNECTION_READY_TIMEOUT_MS);
    });
  }

  async announceEvent(member, type, channelName) {
    console.log(`[announceEvent] Called with member: ${member?.user?.username}, type: ${type}, channel: ${channelName}`);
    try {
      if (!member || member.user?.bot) {
        return;
      }

      const voiceChannel = await this.channels.fetch(VOICE_CHANNEL_ID).catch((error) => {
        console.error(`Failed to fetch voice channel ${VOICE_CHANNEL_ID}:`, error);
        return null;
      });

      if (!voiceChannel || !voiceChannel.isVoiceBased?.()) {
        console.error(`Voice channel ${VOICE_CHANNEL_ID} not found or not voice-based.`);
        return;
      }

      // Send text announcement
      await this.sendTextAnnouncement(member, type, voiceChannel);

      const guildId = voiceChannel.guildId;
      const connection = getVoiceConnection(guildId);
      if (!connection) {
        console.error('Bot is not connected to voice channel.');
        return;
      }

      console.log(`[announceEvent] Waiting for connection to be ready. Current state: ${connection.state.status}`);
      await this.waitForConnectionReady(connection);

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

      console.log(`[announceEvent] About to play audio, connection state: ${connection.state.status}`);
      player.play(resource);
      connection.subscribe(player);
      console.log(`[announceEvent] Called player.play() and connection.subscribe()`);
    } catch (error) {
      console.error('Error announcing voice state event:', error);
    }
  }

  async handleVoiceStateUpdate(oldState, newState) {
    try {
      const botLeft =
        oldState.member?.id === this.user.id &&
        oldState.channelId &&
        !newState.channelId;

      if (botLeft) {
        console.log('Bot was disconnected from the voice channel. Reconnecting...');
        setTimeout(() => {
          this.joinTargetVoiceChannel().catch((error) => {
            console.error('Error reconnecting to voice channel:', error);
          });
        }, RECONNECT_DELAY_MS);
        return;
      }

      if (!oldState.channelId && newState.channelId) {
        await this.announceEvent(newState.member, 'joined', newState.channel?.name ?? 'the channel');
        return;
      }

      if (oldState.channelId && !newState.channelId) {
        await this.announceEvent(oldState.member, 'left', oldState.channel?.name ?? 'the channel');
        return;
      }
    } catch (error) {
      console.error('Error handling voiceStateUpdate:', error);
    }
  }

  startWebServer() {
    const app = express();
    app.get("/", (req, res) => res.send("TitanBot System Online"));
    app.listen(3000, () => console.log(" Web Server is ready."));
  }

  setupCronJobs() {
    // Daily birthday check at 6 AM UTC
    cron.schedule('0 6 * * *', () => checkBirthdays(this));
    
    // Check giveaways every minute
    cron.schedule('* * * * *', () => checkGiveaways(this));
    
    // Update counters every 15 minutes
    cron.schedule('*/15 * * * *', () => this.updateAllCounters());
  }

  async updateAllCounters() {
    // Check if database is available
    if (!this.db) {
      console.warn('Database not available for counter updates');
      return;
    }
    
    for (const [guildId, guild] of this.guilds.cache) {
      try {
        const counters = await getServerCounters(this, guildId);
        for (const [counterName, counter] of Object.entries(counters)) {
          if (counter && counter.enabled) {
            await updateCounter(this, guild, counter);
          }
        }
      } catch (error) {
        console.error(`Error updating counters for guild ${guildId}:`, error);
      }
    }
  }

  async loadHandlers() {
    const handlers = ['events', 'interactions'];
    
    for (const handler of handlers) {
      try {
        const { default: loadHandler } = await import(`./handlers/loaders/${handler}.js`);
        await loadHandler(this);
        logger.info(`Loaded ${handler} handler`);
      } catch (error) {
        // Ignore missing handlers that might not exist
        if (error.code !== 'MODULE_NOT_FOUND') {
          logger.error(`Error loading ${handler} handler:`, error);
        }
      }
    }
  }

  async registerCommands() {
    try {
      await registerSlashCommands(this, this.config.bot.guildId);
    } catch (error) {
      logger.error('Error registering commands:', error);
    }
  }
}

// Start the bot when this file is run directly
console.log('=== TitanBot Starting ===');
console.log('Node.js version:', process.version);
console.log('Environment:', process.env.NODE_ENV);

try {
  const bot = new TitanBot();
  console.log('Bot instance created successfully');
  bot.start();
} catch (error) {
  console.error('Fatal error during bot startup:', error);
  process.exit(1);
}

export default TitanBot;

