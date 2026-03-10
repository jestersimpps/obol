const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { getTenant } = require('../tenant');
const { register, unregister } = require('../transport');
const { handleCommand } = require('./commands');
const { startWizard, handleSchedInput, handleSchedAction } = require('./schedule-wizard');
const { OPTIONAL_TOOLS } = require('../claude/constants');

const clients = new Map();
const pendingAsks = new Map();
let askIdCounter = 0;

function wsSend(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function createDesktopAsk(ws, message, options, timeout = 120000) {
  const askId = String(++askIdCounter);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAsks.delete(askId);
      wsSend(ws, { type: 'ask_expire', askId });
      resolve(null);
    }, timeout);

    pendingAsks.set(askId, { resolve, timer });
    wsSend(ws, { type: 'ask', askId, message, options });
  });
}

function createWsServer(config) {
  const port = config.desktop?.port || 9230;
  const tokens = config.desktop?.tokens || {};
  const allowedUsers = new Set(config.telegram?.allowedUsers?.map(Number) || []);

  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws) => {
    let userId = null;
    let transport = null;
    let bgInterval = null;
    let authTimeout = setTimeout(() => {
      wsSend(ws, { type: 'auth_error', error: 'Auth timeout' });
      ws.close();
    }, 10000);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (!userId) {
        if (msg.type !== 'auth') {
          wsSend(ws, { type: 'auth_error', error: 'Must authenticate first' });
          return;
        }
        clearTimeout(authTimeout);
        authTimeout = null;

        const mappedUserId = tokens[msg.token];
        if (!mappedUserId || !allowedUsers.has(Number(mappedUserId))) {
          wsSend(ws, { type: 'auth_error', error: 'Invalid token' });
          ws.close();
          return;
        }

        userId = Number(mappedUserId);
        const send = (data) => wsSend(ws, data);
        transport = {
          type: 'desktop',
          send: (message, opts = {}) => {
            send({ type: 'proactive', text: message, source: opts.source || 'system' });
            return Promise.resolve();
          },
        };
        register(userId, transport);
        clients.set(ws, { userId, transport });
        send({ type: 'auth_ok', userId });
        console.log(`[ws] Desktop client connected (user ${userId})`);
        return;
      }

      switch (msg.type) {
        case 'message':
          await handleMessage(ws, userId, msg, config);
          break;

        case 'stop': {
          const tenant = await getTenant(userId, config);
          tenant.claude?.stopChat?.(userId);
          break;
        }

        case 'force_stop': {
          const tenant = await getTenant(userId, config);
          tenant.claude?.forceStopChat?.(userId);
          break;
        }

        case 'command':
          await handleCommand((data) => wsSend(ws, data), msg.name, msg.args, userId, config);
          break;

        case 'ask_reply': {
          const pending = pendingAsks.get(msg.askId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingAsks.delete(msg.askId);
            pending.resolve(msg.optionIndex);
          }
          break;
        }

        case 'tool_toggle': {
          const tenant = await getTenant(userId, config);
          if (tenant.toolPrefsApi) {
            const pref = tenant.toolPrefs?.get(msg.key);
            const wasEnabled = pref ? pref.enabled : (OPTIONAL_TOOLS[msg.key]?.defaultEnabled || false);
            await tenant.toolPrefsApi.set(msg.key, !wasEnabled, pref?.config || {});
            await tenant.reloadToolPrefs();
            wsSend(ws, { type: 'tool_toggled', key: msg.key, enabled: !wasEnabled });
          }
          break;
        }

        case 'topics_add': {
          const tenant = await getTenant(userId, config);
          if (tenant.toolPrefsApi) {
            const pref = tenant.toolPrefs?.get('proactive_news');
            const existing = pref?.config?.topics || [];
            const newTopics = (msg.topics || '').split(',').map(t => t.trim()).filter(Boolean);
            const merged = [...new Set([...existing, ...newTopics])].slice(0, 20);
            await tenant.toolPrefsApi.set('proactive_news', pref?.enabled ?? false, { ...(pref?.config || {}), topics: merged });
            await tenant.reloadToolPrefs();
            wsSend(ws, { type: 'topics_state', topics: merged, maxTopics: 20 });
          }
          break;
        }

        case 'topics_remove': {
          const tenant = await getTenant(userId, config);
          if (tenant.toolPrefsApi) {
            const pref = tenant.toolPrefs?.get('proactive_news');
            const existing = pref?.config?.topics || [];
            const idx = typeof msg.index === 'number' ? msg.index : -1;
            if (idx >= 0 && idx < existing.length) {
              existing.splice(idx, 1);
              await tenant.toolPrefsApi.set('proactive_news', pref?.enabled ?? false, { ...(pref?.config || {}), topics: existing });
              await tenant.reloadToolPrefs();
            }
            wsSend(ws, { type: 'topics_state', topics: existing, maxTopics: 20 });
          }
          break;
        }

        case 'sched_start':
          startWizard((data) => wsSend(ws, data), userId);
          break;

        case 'sched_input':
          await handleSchedInput((data) => wsSend(ws, data), userId, msg.step, msg.value, config);
          break;

        case 'sched_action':
          await handleSchedAction((data) => wsSend(ws, data), userId, msg.action, msg.field, config);
          break;

        case 'file': {
          await handleFile(ws, userId, msg, config);
          break;
        }

        case 'voice_audio': {
          await handleVoiceAudio(ws, userId, msg, config);
          break;
        }

        case 'voice_languages': {
          const { VOICE_LANGUAGES, TTS_SAMPLES } = getVoiceData();
          wsSend(ws, { type: 'voice_languages_result', languages: VOICE_LANGUAGES });
          break;
        }

        case 'voice_list': {
          try {
            const tts = require('../media/tts');
            const voices = tts.getVoices(msg.langCode);
            wsSend(ws, { type: 'voice_list_result', voices, langCode: msg.langCode });
          } catch (e) {
            wsSend(ws, { type: 'voice_list_result', voices: [], error: e.message });
          }
          break;
        }

        case 'voice_sample': {
          try {
            const tts = require('../media/tts');
            const { TTS_SAMPLES } = getVoiceData();
            const langPrefix = msg.voiceName.split('-').slice(0, 2).join('-');
            const sampleText = TTS_SAMPLES[langPrefix] || TTS_SAMPLES['en-US'];
            const filePath = tts.synthesize(sampleText, msg.voiceName);
            const audio = fs.readFileSync(filePath);
            wsSend(ws, { type: 'voice_sample_audio', audio: audio.toString('base64'), format: 'mp3', voiceName: msg.voiceName });
            try { fs.unlinkSync(filePath); } catch {}
          } catch (e) {
            wsSend(ws, { type: 'error', message: `Voice sample failed: ${e.message}` });
          }
          break;
        }

        case 'voice_save': {
          const tenant = await getTenant(userId, config);
          if (tenant.toolPrefsApi) {
            const pref = tenant.toolPrefs?.get('text_to_speech');
            const newConfig = { ...(pref?.config || {}), voice: msg.voiceName };
            await tenant.toolPrefsApi.set('text_to_speech', true, newConfig);
            await tenant.reloadToolPrefs();
            wsSend(ws, { type: 'command_result', name: 'voice', text: `Voice set: ${msg.voiceName}` });
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      if (authTimeout) clearTimeout(authTimeout);
      if (bgInterval) clearInterval(bgInterval);
      const info = clients.get(ws);
      if (info) {
        unregister(info.userId, info.transport);
        clients.delete(ws);
        console.log(`[ws] Desktop client disconnected (user ${info.userId})`);
      }
    });

    ws.on('error', () => {});
  });

  console.log(`  WS server listening on port ${port}`);
  return wss;
}

async function handleMessage(ws, userId, msg, config) {
  const startTime = Date.now();
  try {
    const tenant = await getTenant(userId, config);

    const images = msg.images?.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.data },
    }));

    tenant.messageLog?.log(userId, 'user', msg.text);

    const chatContext = {
      userId,
      userName: 'Desktop',
      chatId: userId,
      bg: tenant.bg,
      claude: tenant.claude,
      scheduler: tenant.scheduler,
      messageLog: tenant.messageLog,
      toolPrefs: tenant.toolPrefs,
      config,
      verbose: tenant.verbose,
      images,
      _verboseNotify: (text) => wsSend(ws, { type: 'status', event: 'verbose', data: { text } }),
      _onRouteDecision: (info) => wsSend(ws, { type: 'status', event: 'route', data: info }),
      _onRouteUpdate: (update) => wsSend(ws, { type: 'status', event: 'route_update', data: update }),
      _onToolStart: (name, summary) => wsSend(ws, { type: 'status', event: 'tool', data: { name, summary } }),
      _onLockTimeout: () => wsSend(ws, { type: 'error', message: 'Request timed out after 10 minutes' }),
      telegramAsk: (message, options) => createDesktopAsk(ws, message, options),
      _onAvatarUpdate: (data) => wsSend(ws, { type: 'avatar_update', ...data }),
      _notifyFn: (targetUserId, message, opts = {}) => {
        const allowedSet = new Set(config.telegram?.allowedUsers?.map(Number) || []);
        if (!allowedSet.has(targetUserId)) throw new Error('Cannot notify user outside allowed list');
        const { broadcast } = require('../transport');
        broadcast(targetUserId, message, opts);
        return Promise.resolve();
      },
    };

    const { text, usage, model } = await tenant.claude.chat(msg.text, chatContext);

    if (text?.trim()) {
      tenant.messageLog?.log(userId, 'assistant', text, {
        model,
        tokensIn: usage?.input_tokens,
        tokensOut: usage?.output_tokens,
      });
    }

    wsSend(ws, {
      type: 'response',
      text: text || '',
      usage,
      model,
      elapsed: Math.round((Date.now() - startTime) / 1000),
    });

    if (text?.trim() && msg.tts) {
      generateTtsAudio(ws, tenant, text).catch(e =>
        console.error('[ws] TTS failed:', e.message)
      );
    }
  } catch (e) {
    console.error('[ws] Message handling error:', e.message);
    const errMsg = (e.status === 401 || e.message?.includes('401'))
      ? 'API key invalid or expired.'
      : (e.status === 429 || e.message?.includes('rate'))
        ? 'Rate limited. Wait a moment and try again.'
        : 'Something went wrong. Check logs.';
    wsSend(ws, { type: 'error', message: errMsg });
  }
}

async function handleFile(ws, userId, msg, config) {
  const startTime = Date.now();
  try {
    const tenant = await getTenant(userId, config);
    const dateDir = new Date().toISOString().split('T')[0];
    const assetsDir = path.join(tenant.userDir, 'assets', dateDir);
    fs.mkdirSync(assetsDir, { recursive: true });

    const ext = (msg.filename || '').split('.').pop() || 'bin';
    const safeName = `${Date.now()}.${ext}`;
    const filePath = path.join(assetsDir, safeName);

    const buffer = Buffer.from(msg.data, 'base64');
    if (buffer.length > 50 * 1024 * 1024) {
      return wsSend(ws, { type: 'error', message: 'File too large (50MB max)' });
    }
    fs.writeFileSync(filePath, buffer);

    const mimeType = msg.mimeType || 'application/octet-stream';

    if (mimeType.startsWith('image/')) {
      const images = [{
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: msg.data },
      }];
      tenant.messageLog?.log(userId, 'user', msg.caption || 'Image uploaded');
      const chatContext = buildChatContext(ws, userId, tenant, config, images);
      const { text, usage, model } = await tenant.claude.chat(msg.caption || 'What is this image?', chatContext);
      if (text?.trim()) tenant.messageLog?.log(userId, 'assistant', text, { model });
      wsSend(ws, { type: 'response', text: text || '', usage, model, elapsed: Math.round((Date.now() - startTime) / 1000) });
      return;
    }

    if (mimeType.startsWith('audio/')) {
      const sttPref = tenant.toolPrefs?.get('speech_to_text');
      if (sttPref?.enabled) {
        try {
          const { transcribe } = require('../media/stt');
          const transcription = await transcribe(filePath);
          wsSend(ws, { type: 'voice_transcription', text: transcription });
          tenant.messageLog?.log(userId, 'user', transcription);
          const chatContext = buildChatContext(ws, userId, tenant, config);
          const { text, usage, model } = await tenant.claude.chat(transcription, chatContext);
          if (text?.trim()) tenant.messageLog?.log(userId, 'assistant', text, { model });
          wsSend(ws, { type: 'response', text: text || '', usage, model, elapsed: Math.round((Date.now() - startTime) / 1000) });
        } catch (e) {
          wsSend(ws, { type: 'error', message: `Transcription failed: ${e.message}` });
        }
        return;
      }
    }

    wsSend(ws, { type: 'command_result', name: 'file', text: `File saved: ${safeName}` });
  } catch (e) {
    wsSend(ws, { type: 'error', message: `File handling failed: ${e.message}` });
  }
}

async function handleVoiceAudio(ws, userId, msg, config) {
  try {
    const tenant = await getTenant(userId, config);
    const dateDir = new Date().toISOString().split('T')[0];
    const assetsDir = path.join(tenant.userDir, 'assets', dateDir);
    fs.mkdirSync(assetsDir, { recursive: true });

    const ext = (msg.mimeType || '').includes('webm') ? 'webm' : 'ogg';
    const filePath = path.join(assetsDir, `voice-${Date.now()}.${ext}`);
    fs.writeFileSync(filePath, Buffer.from(msg.data, 'base64'));

    const { transcribe } = require('../media/stt');
    const text = await transcribe(filePath);
    wsSend(ws, { type: 'voice_transcription', text });
    try { fs.unlinkSync(filePath); } catch {}
  } catch (e) {
    wsSend(ws, { type: 'error', message: `Transcription failed: ${e.message}` });
  }
}

function buildChatContext(ws, userId, tenant, config, images) {
  return {
    userId,
    userName: 'Desktop',
    chatId: userId,
    bg: tenant.bg,
    claude: tenant.claude,
    scheduler: tenant.scheduler,
    messageLog: tenant.messageLog,
    toolPrefs: tenant.toolPrefs,
    config,
    verbose: tenant.verbose,
    images,
    _verboseNotify: (text) => wsSend(ws, { type: 'status', event: 'verbose', data: { text } }),
    _onRouteDecision: (info) => wsSend(ws, { type: 'status', event: 'route', data: info }),
    _onRouteUpdate: (update) => wsSend(ws, { type: 'status', event: 'route_update', data: update }),
    _onToolStart: (name, summary) => wsSend(ws, { type: 'status', event: 'tool', data: { name, summary } }),
    _onLockTimeout: () => wsSend(ws, { type: 'error', message: 'Request timed out after 10 minutes' }),
    telegramAsk: (message, options) => createDesktopAsk(ws, message, options),
    _onAvatarUpdate: (data) => wsSend(ws, { type: 'avatar_update', ...data }),
    _notifyFn: (targetUserId, message, opts = {}) => {
      const { broadcast } = require('../transport');
      broadcast(targetUserId, message, opts);
      return Promise.resolve();
    },
  };
}

function getVoiceData() {
  const VOICE_LANGUAGES = [
    { code: 'en-US', label: 'English (US)' },
    { code: 'en-GB', label: 'English (UK)' },
    { code: 'en-AU', label: 'English (AU)' },
    { code: 'fr-FR', label: 'French' },
    { code: 'de-DE', label: 'German' },
    { code: 'es-ES', label: 'Spanish' },
    { code: 'it-IT', label: 'Italian' },
    { code: 'pt-BR', label: 'Portuguese (BR)' },
    { code: 'nl-NL', label: 'Dutch' },
    { code: 'ja-JP', label: 'Japanese' },
    { code: 'ko-KR', label: 'Korean' },
    { code: 'zh-CN', label: 'Chinese' },
  ];

  const TTS_SAMPLES = {
    'en-US': 'Hello! This is what I sound like. Nice to meet you.',
    'en-GB': 'Hello! This is what I sound like. Lovely to meet you.',
    'en-AU': 'Hello! This is what I sound like. Good to meet you.',
    'fr-FR': 'Bonjour! Voici \u00e0 quoi ressemble ma voix. Ravie de vous rencontrer.',
    'de-DE': 'Hallo! So klinge ich. Freut mich, Sie kennenzulernen.',
    'es-ES': 'Hola! As\u00ed es como suena mi voz. Encantado de conocerte.',
    'it-IT': 'Ciao! Ecco come suona la mia voce. Piacere di conoscerti.',
    'pt-BR': 'Ol\u00e1! \u00c9 assim que a minha voz soa. Prazer em conhec\u00ea-lo.',
    'nl-NL': 'Hallo! Zo klink ik. Leuk je te ontmoeten.',
    'ja-JP': '\u3053\u3093\u306b\u3061\u306f\uff01\u3053\u308c\u304c\u79c1\u306e\u58f0\u3067\u3059\u3002\u306f\u3058\u3081\u307e\u3057\u3066\u3001\u3088\u308d\u3057\u304f\u304a\u9858\u3044\u3057\u307e\u3059\u3002',
    'ko-KR': '\uc548\ub155\ud558\uc138\uc694! \uc81c \ubaa9\uc18c\ub9ac\ub294 \uc774\ub807\uc2b5\ub2c8\ub2e4. \ub9cc\ub098\uc11c \ubc18\uac11\uc2b5\ub2c8\ub2e4.',
    'zh-CN': '\u4f60\u597d\uff01\u8fd9\u5c31\u662f\u6211\u7684\u58f0\u97f3\u3002\u5f88\u9ad8\u5174\u8ba4\u8bc6\u4f60\u3002',
  };

  return { VOICE_LANGUAGES, TTS_SAMPLES };
}

const DEFAULT_DESKTOP_VOICE = 'en-US-AndrewMultilingualNeural';

async function generateTtsAudio(ws, tenant, responseText) {
  const tts = require('../media/tts');

  const res = await tenant.claude.client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Summarize the following message in 1-2 short spoken sentences. Write in first person as if YOU are speaking directly to the user \u2014 say "I" not "the assistant". Use plain conversational language \u2014 no markdown, no code, no lists:\n\n${responseText.substring(0, 3000)}`,
    }],
  });

  const summary = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (!summary) return;

  const ttsConfig = tenant.toolPrefs?.get('text_to_speech')?.config || {};
  const voice = ttsConfig.desktopVoice || DEFAULT_DESKTOP_VOICE;

  const filePath = tts.synthesize(summary, voice, { rate: ttsConfig.rate, pitch: ttsConfig.pitch });
  try {
    const audio = fs.readFileSync(filePath);
    wsSend(ws, { type: 'tts', audio: audio.toString('base64'), format: 'mp3' });
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

module.exports = { createWsServer };
