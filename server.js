import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import fs from 'fs';
import { Readable } from 'stream';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Use gpt-realtime by default, allow override via env
const REALTIME_MODEL = (process.env.REALTIME_MODEL || 'gpt-realtime').trim();
const DEFAULT_VOICE = process.env.VOICE || 'alloy';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '';

console.log('[DEBUG] Environment variables:');
console.log('  OPENAI_API_KEY:', OPENAI_API_KEY ? `${OPENAI_API_KEY.slice(0, 8)}...${OPENAI_API_KEY.slice(-4)}` : 'NOT SET');
console.log('  REALTIME_MODEL:', REALTIME_MODEL);
console.log('  DEFAULT_VOICE:', DEFAULT_VOICE);
console.log('  ELEVENLABS_API_KEY:', ELEVENLABS_API_KEY ? 'SET' : 'NOT SET');
console.log('  ELEVENLABS_VOICE_ID:', ELEVENLABS_VOICE_ID || 'NOT SET');

if (!OPENAI_API_KEY) {
  console.warn('[WARN] OPENAI_API_KEY is not set. /session will fail until configured.');
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Issues a short-lived (≈1 min) ephemeral client key for WebRTC.
app.post('/session', async (req, res) => {
  try {
    const voice = req.body?.voice || undefined; // voice is ignored when using ElevenLabs for audio
    const instructions = req.body?.instructions;
    // Allow audio input for STT; we do not set voice so no OpenAI TTS is returned
    const modalities = req.body?.modalities || ['text', 'audio'];

    const body = {
      model: REALTIME_MODEL,
      modalities,
      turn_detection: { type: 'server_vad' }
    };
    if (instructions) body.instructions = instructions;
    // Do not include voice when delegating audio to ElevenLabs

    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'realtime=v1'
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return res.status(r.status).json({ error: 'Failed to create realtime session', details: errText });
    }

    const data = await r.json();
    const clientSecret = data?.client_secret?.value || null;
    if (!clientSecret) {
      return res.status(502).json({ error: 'Missing client_secret in upstream response' });
    }

    res.json({
      client_secret: clientSecret,
      model: data?.model || REALTIME_MODEL,
      voice: data?.voice || voice || null
    });
  } catch (err) {
    console.error('Error in /session:', err);
    res.status(500).json({ error: 'Internal error creating session' });
  }
});

// Cache ElevenLabs voices in-memory for a short time to avoid repeated fetches
let elevenVoicesCache = { at: 0, data: null };
async function getElevenVoices() {
  if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not configured');
  const now = Date.now();
  if (elevenVoicesCache.data && (now - elevenVoicesCache.at) < 5 * 60 * 1000) {
    return elevenVoicesCache.data;
  }
  const r = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY }
  });
  if (!r.ok) throw new Error(`ElevenLabs voices error: ${r.status}`);
  const j = await r.json();
  elevenVoicesCache = { at: now, data: j };
  return j;
}

app.get('/voices', async (_req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' });
    const j = await getElevenVoices();
    const list = (j?.voices || []).map(v => ({ id: v.voice_id, name: v.name }));
    res.json({ voices: list });
  } catch (e) {
    console.error('Error in /voices:', e);
    res.status(500).json({ error: 'Failed to fetch voices' });
  }
});

// Proxy ElevenLabs streaming TTS. Accepts { text, voiceId? }
app.post('/tts', async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' });
    }
    const text = (req.body?.text || '').toString().trim();
    if (!text) return res.status(400).json({ error: 'Missing text' });
    let voiceId = (req.body?.voiceId || ELEVENLABS_VOICE_ID || '').toString();
    if (!voiceId) {
      try {
        const j = await getElevenVoices();
        voiceId = (j?.voices?.[0]?.voice_id || '').toString();
      } catch {}
    }
    if (!voiceId) return res.status(400).json({ error: 'Missing ElevenLabs voice id (no default available)' });

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?optimize_streaming_latency=3`;
    const payload = {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.7,
        style: 0.55,
        use_speaker_boost: true
      }
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify(payload)
    });
    if (!r.ok || !r.body) {
      const errText = await r.text().catch(() => '');
      return res.status(r.status || 502).json({ error: 'TTS upstream error', details: errText });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    // Stream ElevenLabs response to client
    try {
      const nodeStream = Readable.fromWeb(r.body);
      nodeStream.pipe(res);
    } catch {
      // Fallback to manual reader
      const reader = r.body.getReader();
      const pump = async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      };
      pump().catch((e) => {
        console.error('TTS stream error:', e);
        try { res.end(); } catch {}
      });
    }
  } catch (err) {
    console.error('Error in /tts:', err);
    res.status(500).json({ error: 'Internal TTS error' });
  }
});

const isHttps = process.env.HTTPS === 'true';

if (isHttps) {
  const keyPath = process.env.SSL_KEY || './localhost-key.pem';
  const certPath = process.env.SSL_CERT || './localhost.pem';

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };

    https.createServer(httpsOptions, app).listen(PORT, () => {
      console.log(`Server listening on https://localhost:${PORT}`);
    });
  } else {
    console.warn('SSL certificates not found. Starting HTTP server.');
    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  }
} else {
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}
