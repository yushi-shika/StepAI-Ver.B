let pc = null;
let micStream = null;
let dc = null;
let isConnected = false;
let isRecording = false;
let aiBuffer = '';
// Track prompt status (informational only)
let promptApplied = false;
// No external TTS; audio is received from OpenAI over WebRTC

const els = {
  micButton: document.getElementById('micButton'),
  holdButton: document.getElementById('holdButton'),
  endButton: document.getElementById('endButton'),
  status: document.getElementById('status'),
  audio: document.getElementById('ai'),
  volume: document.getElementById('volume'),
  transcript: document.getElementById('transcript'),
  waveform: document.getElementById('waveform'),
  liveIndicator: document.getElementById('liveIndicator'),
  currentTime: document.getElementById('currentTime'),
  instructions: document.getElementById('instructions'),
  applyPrompt: document.getElementById('applyPrompt'),
  voice: document.getElementById('voice'),
};

function updateClock() {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const timeString = `${hours}:${minutes.toString().padStart(2, '0')}`;
  els.currentTime.textContent = timeString;
}

updateClock();
setInterval(updateClock, 60000);

console.log('App.js loaded successfully');
console.log('Elements found:', {
  micButton: !!els.micButton,
  status: !!els.status,
  transcript: !!els.transcript
});

function ensureAudioPlayback() {
  try {
    if (!els.audio) return;
    els.audio.muted = false;
    if (els.volume) {
      const v = parseFloat(els.volume.value || '1');
      if (!Number.isNaN(v)) els.audio.volume = v;
    } else {
      els.audio.volume = 1;
    }
    const p = els.audio.play();
    if (p && typeof p.then === 'function') p.catch(() => {});
  } catch {}
}

// No ElevenLabs voice preloading required

function setStatus(s) {
  els.status.textContent = s;
}

function setTranscript(text) {
  els.transcript.textContent = text;
}

function appendTranscript(text) {
  if (!text) return;
  // Clear placeholder if present (JP/EN)
  const placeholderJP = 'マイクを許可して、話しかけてください。';
  const placeholderEN = 'Tap the microphone to start speaking...';
  const curr = els.transcript.textContent;
  const base = (curr.includes(placeholderJP) || curr.includes(placeholderEN)) ? '' : curr;
  els.transcript.textContent = base + text;
  try { els.transcript.parentElement.scrollTop = els.transcript.parentElement.scrollHeight; } catch {}
}

function flushAiSubtitle(prefix = 'AI: ') {
  const text = aiBuffer.trim();
  if (text) appendTranscript(`${prefix}${text}\n`);
  aiBuffer = '';
}

function updateUI(state) {
  const setMicEnabled = (on) => {
    try { if (micStream) micStream.getAudioTracks().forEach(t => t.enabled = !!on); } catch {}
  };
  switch (state) {
    case 'idle':
      if (els.micButton) els.micButton.classList.remove('recording');
      if (els.waveform) els.waveform.classList.remove('active');
      if (els.liveIndicator) els.liveIndicator.classList.remove('active');
      isRecording = false;
      setMicEnabled(false);
      break;
    case 'recording':
      if (els.micButton) els.micButton.classList.add('recording');
      if (els.waveform) els.waveform.classList.add('active');
      if (els.liveIndicator) els.liveIndicator.classList.add('active');
      isRecording = true;
      isConnected = true;
      setMicEnabled(true);
      break;
    case 'connected':
      isConnected = true;
      setStatus('Connected - Tap mic to speak');
      setMicEnabled(false);
      break;
    case 'connecting':
      setStatus('Connecting...');
      setMicEnabled(false);
      break;
    case 'error':
      setStatus('Connection failed');
      updateUI('idle');
      break;
  }
}

async function connect() {
  console.log('connect() function called');
  if (pc) {
    console.log('Already has pc connection, returning');
    return;
  }

  console.log('Updating UI to connecting state');
  updateUI('connecting');

  console.log('Requesting microphone access...');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    console.log('Microphone access granted with enhanced settings');
  } catch (err1) {
    console.warn('Mic constraints failed, retrying with audio:true', err1);
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('Microphone access granted with basic settings');
    } catch (err2) {
      console.error('Mic error:', err2);
      setStatus('Microphone permission denied');
      updateUI('error');
      return;
    }
  }
  // Keep mic tracks disabled until user taps to record
  try { micStream.getAudioTracks().forEach(t => t.enabled = false); } catch {}

  // Fetch ephemeral session after mic is granted
  setStatus('fetching session…');
  let sess;
  try {
    const body = { modalities: ['text', 'audio'], voice: (els.voice?.value || 'alloy').trim() };
    if (els.instructions && els.instructions.value.trim()) {
      body.instructions = els.instructions.value.trim();
    }
    const r = await fetch('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      setStatus(`/session ${r.status}: ${t?.slice(0,120) || 'error'}`);
      cleanup();
      throw new Error(`Session request failed: ${r.status}`);
    }
    sess = await r.json();
  } catch (err) {
    console.error('Session fetch error:', err);
    setStatus('failed to reach /session');
    cleanup();
    throw err;
  }
  if (!sess?.client_secret) {
    setStatus('invalid session response');
    cleanup();
    throw new Error('Invalid session response');
  }

  const model = sess.model;
  const clientSecret = sess.client_secret;

  // Create RTCPeerConnection with public STUN and no-trickle ICE
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  // Send mic track to the model (kept disabled until promptApplied).
  // Allow bidirectional audio so we can receive OpenAI audio responses.
  micStream.getAudioTracks().forEach(t => {
    const sender = pc.addTrack(t, micStream);
    try {
      const trx = pc.getTransceivers().find(tr => tr.sender === sender);
      if (trx) trx.direction = 'sendrecv';
    } catch {}
  });

  // Ensure we can receive AI audio even if no track arrives immediately
  try { pc.addTransceiver('audio', { direction: 'recvonly' }); } catch {}

  // Attach remote audio from OpenAI to the audio element
  pc.ontrack = (event) => {
    const streamsLen = (event.streams && event.streams.length) || 0;
    console.log('pc.ontrack: received remote track', { streams: streamsLen, kind: event.track?.kind });
    try {
      const stream = streamsLen ? event.streams[0] : new MediaStream([event.track]);
      els.audio.srcObject = stream;
      try {
        const t = stream.getAudioTracks && stream.getAudioTracks()[0];
        if (t) {
          console.log('remote audio track:', { enabled: t.enabled, muted: t.muted, readyState: t.readyState });
          t.onunmute = () => { console.log('remote audio track: unmuted'); ensureAudioPlayback(); };
          t.onended = () => console.log('remote audio track: ended');
        }
      } catch {}
      ensureAudioPlayback();
    } catch {}
  };

  // Data channel for events (subtitles)
  const handleEventMessage = (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg?.type === 'response.created') {
        aiBuffer = '';
      } else if (msg?.type === 'input_audio_buffer.committed') {
        // When VAD commits a user turn, ask the model to respond with audio
        if (dc && dc.readyState === 'open') {
          try {
            dc.send(JSON.stringify({ type: 'response.create', response: { conversation: 'auto', modalities: ['audio','text'] } }));
            console.debug('sent: response.create (on committed)');
          } catch (e) { console.warn('failed to send response.create', e); }
        }
      } else if (msg?.type === 'response.output_text.delta') {
        aiBuffer += (msg.delta || '');
      } else if (msg?.type === 'response.audio_transcript.delta') {
        // For gpt-realtime: use audio transcript text as the model's reply text
        aiBuffer += (msg.delta || '');
      } else if (msg?.type === 'response.output_text.done' || msg?.type === 'response.completed') {
        flushAiSubtitle('AI: ');
      } else if (msg?.type === 'response.audio_transcript.done' || msg?.type === 'response.done') {
        // Flush when audio transcript or overall response completes
        flushAiSubtitle('AI: ');
      } else if (msg?.type === 'session.updated') {
        // Acknowledge prompt update if server emits it
        promptApplied = true;
        setStatus('Prompt applied');
      } else if (msg?.type === 'error' || msg?.type === 'response.error') {
        try { console.error('Realtime error event:', JSON.stringify(msg)); } catch { console.error('Realtime error event:', msg); }
      } else if (msg?.type === 'output_audio_buffer.started') {
        ensureAudioPlayback();
      } else {
        // Minimal debug for unknown realtime events to help diagnose STT
        if (msg?.type) console.log('oai event:', msg.type);
      }
    } catch {
      // ignore non-JSON
    }
  };
  // Create the OpenAI events data channel proactively
  const attachChannel = (ch) => {
    dc = ch;
    ch.onopen = () => {
      console.log('dc.onopen readyState=', ch.readyState);
      const text = (els.instructions?.value || '').trim();
      const voice = (els.voice?.value || 'alloy').trim();
      if (text) {
        try {
          ch.send(JSON.stringify({ type: 'session.update', session: { instructions: text, voice } }));
          console.debug('sent: session.update');
        } catch {}
      } else if (voice) {
        try {
          ch.send(JSON.stringify({ type: 'session.update', session: { voice } }));
          console.debug('sent: session.update (voice)');
        } catch {}
      }
      updateUI('recording');
      setStatus('Listening...');
    };
    ch.onmessage = (ev) => handleEventMessage(ev.data);
    ch.onclose = () => console.debug('dc.onclose');
    ch.onerror = (e) => console.warn('dc.onerror', e);
  };

  try {
    attachChannel(pc.createDataChannel('oai-events'));
  } catch {}

  pc.ondatachannel = (event) => attachChannel(event.channel);

  // Removed legacy data channel block that re-enabled OpenAI audio

  pc.onconnectionstatechange = () => {
    console.log('pc.connectionState:', pc.connectionState);
    setStatus(pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      cleanup();
    } else if (pc.connectionState === 'disconnected') {
      // 'disconnected' is temporary, don't cleanup immediately
      setStatus('Connection temporarily lost, attempting to reconnect...');
    }
  };
  pc.onsignalingstatechange = () => console.log('pc.signalingState:', pc.signalingState);
  pc.oniceconnectionstatechange = () => console.log('pc.iceConnectionState:', pc.iceConnectionState);
  pc.onicegatheringstatechange = () => console.log('pc.iceGatheringState:', pc.iceGatheringState);
  pc.onicecandidate = (e) => { if (!e.candidate) console.log('pc.onicecandidate: all candidates gathered'); };

  // Create SDP offer
  setStatus('creating offer…');
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // Wait for ICE gathering to complete since we use non-trickle HTTP exchange
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    // Fallback timeout (2s)
    setTimeout(() => { pc.removeEventListener('icegatheringstatechange', check); resolve(); }, 2000);
  });

  // Exchange SDP directly with OpenAI Realtime endpoint using ephemeral key
  setStatus('exchanging SDP…');
  let answer;
  try {
    const sdpResponse = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${clientSecret}`,
        'Content-Type': 'application/sdp',
        'Accept': 'application/sdp',
        'OpenAI-Beta': 'realtime=v1'
      },
      body: pc.localDescription.sdp
    });
    if (!sdpResponse.ok) {
      const errText = await sdpResponse.text().catch(() => '');
      setStatus('SDP exchange failed');
      console.error('SDP exchange error:', errText);
      cleanup();
      throw new Error(`SDP exchange failed: ${sdpResponse.status}`);
    }
    answer = await sdpResponse.text();
  } catch (err) {
    console.error('SDP exchange network error:', err);
    setStatus('SDP exchange network error');
    cleanup();
    throw err;
  }
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  console.debug('Remote SDP applied');

  // Mark connected state will be handled on data channel open
}

function stopTracks(stream) {
  if (!stream) return;
  stream.getTracks().forEach(t => t.stop());
}

function cleanup() {
  try { if (dc) dc.close(); } catch {}
  dc = null;
  try { if (pc) pc.close(); } catch {}
  pc = null;
  stopTracks(micStream);
  micStream = null;
  isConnected = false;
  updateUI('idle');
  setStatus('Ready to connect');
  setTranscript('Tap the microphone to start speaking...');
}

async function disconnect() {
  cleanup();
}

els.micButton.addEventListener('click', (event) => {
  console.log('Microphone button clicked!', { isConnected, isRecording });

  if (!isConnected) {
    console.log('Starting connection process...');

    // Try to play audio without await first
    els.audio.play().catch(e => {
      console.log('Audio play failed (expected):', e.message);
    });

    console.log('Setting transcript...');
    setTranscript('Connecting...');

    console.log('About to call connect()');

    // Call connect function
    const connectPromise = connect();
    console.log('Connect function called, promise:', connectPromise);

    connectPromise.then(() => {
      console.log('Connect completed successfully');
    }).catch(err => {
      console.error('Connection failed:', err);
      updateUI('error');
      cleanup();
    });

    console.log('Event handler completing...');
  } else {
    console.log('Already connected, toggling recording state');
    if (isRecording) {
      updateUI('idle');
      setStatus('Connected - Tap mic to speak');
    } else {
      updateUI('recording');
      setStatus('Listening...');
    }
  }
});

els.endButton.addEventListener('click', () => {
  disconnect();
});

els.holdButton.addEventListener('click', () => {
  if (isConnected && isRecording) {
    updateUI('idle');
    setStatus('Paused - Tap mic to resume');
  }
});

els.volume.addEventListener('input', () => {
  els.audio.volume = parseFloat(els.volume.value);
});

// Allow live prompt updates from UI
if (els.applyPrompt) {
  els.applyPrompt.addEventListener('click', () => {
    const text = (els.instructions?.value || '').trim();
    if (!text) {
      setStatus('プロンプトが空です');
      return;
    }
    if (dc && dc.readyState === 'open') {
      try {
        const payload = { type: 'session.update', session: { instructions: text } };
        dc.send(JSON.stringify(payload));
        setStatus('システムプロンプトを適用しました');
      } catch (e) {
        console.error('Failed to send prompt update', e);
        setStatus('プロンプト適用に失敗しました');
      }
    } else {
      setStatus('接続後に適用できます');
    }
  });
}

// No external TTS functions
