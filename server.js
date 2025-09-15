import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import fs from 'fs';
import { Readable } from 'stream';

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

console.log('[DEBUG] Environment variables:');
console.log('  OPENAI_API_KEY:', OPENAI_API_KEY ? `${OPENAI_API_KEY.slice(0, 8)}...${OPENAI_API_KEY.slice(-4)}` : 'NOT SET');
console.log('  REALTIME_MODEL:', REALTIME_MODEL);
console.log('  DEFAULT_VOICE:', DEFAULT_VOICE);

if (!OPENAI_API_KEY) {
  console.warn('[WARN] OPENAI_API_KEY is not set. /session will fail until configured.');
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Issues a short-lived (≈1 min) ephemeral client key for WebRTC.
app.post('/session', async (req, res) => {
  try {
    console.log('[DEBUG] /session request body:', JSON.stringify(req.body, null, 2));
    const voice = req.body?.voice || DEFAULT_VOICE;
    const instructions = req.body?.instructions;
    // Allow audio input for STT; we do not set voice so no OpenAI TTS is returned
    const modalities = req.body?.modalities || ['text', 'audio'];

    const body = {
      model: REALTIME_MODEL,
      modalities,
      turn_detection: { type: 'server_vad' }
    };
    if (instructions) body.instructions = instructions;
    if (voice) body.voice = voice;

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
      console.log('[DEBUG] OpenAI session creation failed:', r.status, errText);
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

// ElevenLabs endpoints removed; OpenAI handles output audio

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
