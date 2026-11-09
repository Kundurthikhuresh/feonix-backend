/**
 * Live speech-to-text: words appear while a person is still speaking.
 *
 * The browser streams each voice channel (the candidate's mic, the
 * interviewer's meeting audio) to this server over a WebSocket, as raw
 * 16-bit PCM at 24 kHz, and sends "commit" when its voice detector hears the
 * speaker stop. This server relays the audio to an OpenAI realtime
 * transcription session (the API key never leaves the server) and sends the
 * transcript back: "delta" events while the person talks, then one cleaned
 * "final" per spoken turn.
 *
 * STT_MODE=live turns it on; STT_MODE=clips (the default) keeps the
 * clip-by-clip /api/transcribe path. The browser falls back to clips by
 * itself if a live connection cannot be made.
 *
 *   GET  /api/live-stt/config   → { mode }
 *   POST /api/live-stt/ticket   → { ticket }  (short-lived, one channel)
 *   WS   /api/live-stt?ticket=…  the audio stream itself
 */
const crypto = require('crypto');
const express = require('express');
const WebSocket = require('ws');
const { requireAuthLive, findUserById } = require('./auth');
const { tokensUsedThisMonth, reserveUsage } = require('./db');
const quota = require('./quota');
const {
  promptFor, stripPromptEcho, repairTechnicalAcoustics, looksForeignLatin,
  NON_LATIN_SCRIPT_REGEX,
} = require('./transcribe');

const LIVE_MODEL = process.env.LIVE_TRANSCRIBE_MODEL || 'gpt-live-transcribe';
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const TICKET_TTL_MS = 60 * 1000;
// Two channels per listening run (mic + meeting audio). Stop then Start
// opens two new ones while the old two are still finishing their last turn
// (up to a few seconds), so room is left for that overlap.
const MAX_CHANNELS_PER_USER = 6;
// 24 kHz, 16-bit mono.
const BYTES_PER_SECOND = 24000 * 2;
// A commit needs some audio behind it; shorter turns are dropped, not sent.
const MIN_COMMIT_BYTES = BYTES_PER_SECOND / 10;
/* Usage is stored like the other models' token counts so the monthly safety
 * limit and the admin cost report cover it: 10 "tokens" per second of audio
 * sent (600 a minute, priced in admin.js at the model's $0.017 a minute). */
const TOKENS_PER_AUDIO_SECOND = 10;
const QUOTA_RESERVE_TOKENS = 600;

const TICKET_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function sttMode() {
  const wanted = String(process.env.STT_MODE || 'clips').toLowerCase();
  return wanted === 'live' && process.env.OPENAI_API_KEY ? 'live' : 'clips';
}

function sign(payload) {
  return crypto.createHmac('sha256', TICKET_SECRET).update(payload).digest('base64url');
}

function makeTicket(data) {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + TICKET_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readTicket(ticket) {
  const [payload, mac] = String(ticket || '').split('.');
  if (!payload || !mac) return null;
  const expected = sign(payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

const router = express.Router();

router.get('/config', requireAuthLive, (req, res) => {
  res.json({ mode: sttMode() });
});

router.post('/ticket', requireAuthLive, express.json(), async (req, res, next) => {
  try {
    if (sttMode() !== 'live') return res.status(409).json({ error: 'live_off', mode: 'clips' });
    const speaker = ['you', 'interviewer', 'unknown'].includes(req.body && req.body.speaker)
      ? req.body.speaker : 'unknown';
    const { getSessionLive } = require('./sessions');
    const sessionId = req.body && req.body.session_id;
    const session = sessionId && sessionId !== 'default' ? await getSessionLive(req.user.id, sessionId) : null;
    if (session && session.status === 'ended') {
      return res.status(410).json({ error: 'session_ended', message: 'This session has ended.' });
    }
    return res.json({ ticket: makeTicket({ u: req.user.id, s: session ? session.id : null, sp: speaker }) });
  } catch (err) {
    return next(err);
  }
});

const openChannels = new Map(); // userId → number of open live channels

// The final text of one turn, cleaned like a clip transcript: prompt echoes,
// known silence hallucinations and wrong-language output are dropped.
function cleanFinal(text, prompt, langCode) {
  let out = String(text || '').trim();
  if (!out) return '';
  if (langCode === 'en' && (NON_LATIN_SCRIPT_REGEX.test(out) || looksForeignLatin(out))) return '';
  out = stripPromptEcho(out, prompt, langCode);
  return repairTechnicalAcoustics(out || '').trim();
}

async function handleChannel(client, ticket) {
  const userId = ticket.u;
  const send = (msg) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg));
  };
  const fail = (code, message) => {
    send({ type: 'error', code, message });
    client.close(1011, code);
  };

  const user = await findUserById(userId);
  if (!user || user.disabled) return fail('unauthenticated', 'Sign in first.');
  const used = await tokensUsedThisMonth(userId);
  if (quota.check(user, used, QUOTA_RESERVE_TOKENS).blocked) {
    return fail('quota_exhausted', 'Monthly token safety limit reached. Transcription stopped.');
  }
  // The checks above take seconds on a slow database. If the browser closed
  // this connection meanwhile (mic stopped), its close was missed: counting
  // it now would never be undone, and after a few stop/starts every new
  // channel was refused until the server restarted.
  if (client.readyState !== WebSocket.OPEN) return undefined;
  if ((openChannels.get(userId) || 0) >= MAX_CHANNELS_PER_USER) {
    return fail('too_many_channels', 'Too many live transcription channels open.');
  }
  openChannels.set(userId, (openChannels.get(userId) || 0) + 1);

  const { getSessionLive } = require('./sessions');
  const uncount = () => openChannels.set(userId, Math.max(0, (openChannels.get(userId) || 1) - 1));
  let session = null;
  try {
    session = ticket.s ? await getSessionLive(userId, ticket.s) : null;
  } catch (err) {
    uncount();
    throw err;
  }
  // Closed by the browser during that read: give the place back, and open
  // nothing upstream for it.
  if (client.readyState !== WebSocket.OPEN) {
    uncount();
    return undefined;
  }
  const prompt = promptFor(session);
  // English only, whatever an older session was created with.
  const langCode = 'en';

  const upstream = new WebSocket(OPENAI_REALTIME_URL, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });

  let upstreamReady = false;
  const queued = [];
  let bytesSinceCommit = 0;
  let totalBytes = 0;
  let closed = false;

  const toUpstream = (event) => {
    if (upstreamReady && upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(event));
    else queued.push(event);
  };

  upstream.on('open', () => {
    upstream.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            // The mic is a close-talking source; meeting audio is already clean.
            noise_reduction: ticket.sp === 'you' ? { type: 'near_field' } : null,
            transcription: { model: LIVE_MODEL, languages: [langCode], prompt },
            // Turns are ended by the browser's own voice detector ("commit").
            turn_detection: null,
          },
        },
      },
    }));
    upstreamReady = true;
    while (queued.length) upstream.send(JSON.stringify(queued.shift()));
    send({ type: 'ready' });
  });

  upstream.on('message', (raw) => {
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { return; }
    switch (event.type) {
      case 'input_audio_buffer.committed':
        send({ type: 'committed', item_id: event.item_id });
        break;
      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta) send({ type: 'delta', item_id: event.item_id, text: event.delta });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        send({ type: 'final', item_id: event.item_id, text: cleanFinal(event.transcript, prompt, langCode) });
        break;
      case 'conversation.item.input_audio_transcription.failed':
        send({ type: 'final', item_id: event.item_id, text: '' });
        break;
      case 'error':
        console.warn(`[LIVE STT] upstream error: ${event.error && event.error.message}`);
        send({ type: 'error', code: 'upstream_error', message: (event.error && event.error.message) || 'Transcription error.' });
        break;
      default:
        break;
    }
  });

  upstream.on('error', (err) => {
    console.warn(`[LIVE STT] upstream connection failed: ${err.message}`);
    fail('upstream_unavailable', 'Live transcription is unavailable.');
  });
  upstream.on('close', () => {
    if (client.readyState === WebSocket.OPEN) client.close(1011, 'upstream_closed');
  });

  client.on('message', (data, isBinary) => {
    if (isBinary) {
      // Whole 16-bit samples only.
      const buf = data.length % 2 ? data.subarray(0, data.length - 1) : data;
      if (!buf.length) return;
      bytesSinceCommit += buf.length;
      totalBytes += buf.length;
      toUpstream({ type: 'input_audio_buffer.append', audio: buf.toString('base64') });
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (msg.type === 'commit') {
      if (bytesSinceCommit >= MIN_COMMIT_BYTES) {
        toUpstream({ type: 'input_audio_buffer.commit' });
      } else {
        // Too little audio for a turn: drop it and tell the browser the turn
        // produced nothing, so it does not wait for a transcript.
        toUpstream({ type: 'input_audio_buffer.clear' });
        send({ type: 'committed', item_id: null });
      }
      bytesSinceCommit = 0;
    }
  });

  const finish = async () => {
    if (closed) return;
    closed = true;
    openChannels.set(userId, Math.max(0, (openChannels.get(userId) || 1) - 1));
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      try { upstream.close(); } catch { /* already closing */ }
    }
    const seconds = totalBytes / BYTES_PER_SECOND;
    if (seconds > 0) {
      try {
        await reserveUsage(userId, LIVE_MODEL, Math.round(seconds * TOKENS_PER_AUDIO_SECOND), 0, session ? session.id : null);
      } catch (err) {
        console.warn(`[LIVE STT] usage record failed: ${err.message}`);
      }
    }
  };
  client.on('close', finish);
  client.on('error', finish);
}

/* Accepts the WebSocket upgrade for /api/live-stt on the API server. Other
 * upgrade requests are left alone. */
function attachLiveStt(server) {
  const wss = new WebSocket.Server({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/live-stt') return;
    const ticket = readTicket(url.searchParams.get('ticket'));
    if (!ticket || sttMode() !== 'live') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      handleChannel(client, ticket).catch((err) => {
        console.warn(`[LIVE STT] channel error: ${err.message}`);
        try { client.close(1011, 'server_error'); } catch { /* gone */ }
      });
    });
  });
}

module.exports = { router, attachLiveStt, sttMode };
