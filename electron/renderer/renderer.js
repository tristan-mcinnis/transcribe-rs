const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SIZE = TARGET_SAMPLE_RATE; // 1 second of mono audio

const { downsampleBuffer, formatTimestamp } = window.rendererUtils || {};
if (typeof downsampleBuffer !== 'function' || typeof formatTimestamp !== 'function') {
  throw new Error('Renderer utilities failed to load.');
}

const modelInput = document.getElementById('modelPath');
const engineSelect = document.getElementById('engine');
const languageInput = document.getElementById('language');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusLine = document.getElementById('status');
const transcriptContainer = document.getElementById('transcript');
const notesList = document.getElementById('notes');
const notesStatus = document.getElementById('notesStatus');
const sessionPathValue = document.getElementById('sessionPath');
const openFolderButton = document.getElementById('openFolderButton');

let audioContext = null;
let mediaStream = null;
let processorNode = null;
let bufferQueue = [];
let capturing = false;
let notesEnabled = false;
let sessionFolder = null;
let lastSessionFolder = null;
let revealBusy = false;

window.electronAPI.onceNotesAvailability((available) => {
  notesEnabled = available;
  refreshNotesStatus();
});

window.electronAPI.onStatus((message) => {
  statusLine.textContent = message;
});

window.electronAPI.onTranscript((payload) => {
  renderTranscript(payload);
});

window.electronAPI.onNotes((payload) => {
  renderNotes(payload);
});

window.electronAPI.onNotesStatus((state) => {
  switch (state) {
    case 'generating':
      notesStatus.textContent = 'Generating notes…';
      break;
    case 'error':
      notesStatus.textContent = 'Note generation error';
      break;
    default:
      refreshNotesStatus();
      break;
  }
});

window.electronAPI.onSessionFolder((payload) => {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const nextActive =
    typeof payload.active === 'string' && payload.active.trim()
      ? payload.active.trim()
      : null;
  const nextLast =
    typeof payload.last === 'string' && payload.last.trim()
      ? payload.last.trim()
      : null;

  sessionFolder = nextActive;
  if (nextLast !== null) {
    lastSessionFolder = nextLast;
  } else if (!sessionFolder) {
    lastSessionFolder = null;
  }

  updateSessionFolderDisplay();
});

startButton.addEventListener('click', async () => {
  if (capturing) {
    return;
  }

  const modelPath = modelInput.value.trim();
  if (!modelPath) {
    statusLine.textContent = 'Model path is required.';
    return;
  }

  startButton.disabled = true;
  statusLine.textContent = 'Starting transcription…';

  try {
    const sessionConfig = {
      engine: engineSelect.value,
      modelPath,
      language: languageInput.value.trim() || undefined,
    };
    const response = await window.electronAPI.startSession(sessionConfig);
    if (!response?.success) {
      statusLine.textContent = response?.error || 'Failed to start session.';
      startButton.disabled = false;
      sessionFolder = null;
      if (typeof response?.previousFolder === 'string' && response.previousFolder.trim()) {
        lastSessionFolder = response.previousFolder.trim();
      }
      updateSessionFolderDisplay();
      return;
    }

    notesEnabled = Boolean(response.notesEnabled);
    if (typeof response.sessionFolder === 'string' && response.sessionFolder.trim()) {
      sessionFolder = response.sessionFolder.trim();
    }
    if (typeof response.previousFolder === 'string' && response.previousFolder.trim()) {
      lastSessionFolder = response.previousFolder.trim();
    }
    updateSessionFolderDisplay();
    await startCapture();
    capturing = true;
    startButton.disabled = true;
    stopButton.disabled = false;
    refreshNotesStatus();
    statusLine.textContent = 'Listening…';
  } catch (error) {
    console.error(error);
    statusLine.textContent = `Start failed: ${error.message}`;
    startButton.disabled = false;
    refreshNotesStatus();
    sessionFolder = null;
    updateSessionFolderDisplay();
  }
});

stopButton.addEventListener('click', async () => {
  if (!capturing) {
    return;
  }
  stopButton.disabled = true;
  try {
    await stopCapture();
    const response = await window.electronAPI.stopSession();
    sessionFolder = null;
    if (typeof response?.sessionFolder === 'string' && response.sessionFolder.trim()) {
      lastSessionFolder = response.sessionFolder.trim();
    }
    updateSessionFolderDisplay();
  } finally {
    capturing = false;
    startButton.disabled = false;
    refreshNotesStatus();
    statusLine.textContent = 'Capture stopped.';
  }
});

openFolderButton.addEventListener('click', async () => {
  if (openFolderButton.disabled || revealBusy) {
    return;
  }

  revealBusy = true;
  const previousLabel = openFolderButton.textContent;
  openFolderButton.textContent = 'Opening…';
  openFolderButton.disabled = true;

  try {
    const result = await window.electronAPI.revealSessionFolder();
    if (!result?.success && result?.error) {
      statusLine.textContent = result.error;
    }
  } catch (error) {
    statusLine.textContent = `Reveal failed: ${error.message}`;
  } finally {
    revealBusy = false;
    openFolderButton.textContent = previousLabel;
    updateSessionFolderDisplay();
  }
});

async function startCapture() {
  if (audioContext) {
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    },
    video: false,
  });

  const context = new AudioContext();
  if (context.state === 'suspended') {
    await context.resume();
  }
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleBuffer(input, context.sampleRate, TARGET_SAMPLE_RATE);
    if (!downsampled || !downsampled.length) {
      return;
    }

    for (let i = 0; i < downsampled.length; i += 1) {
      bufferQueue.push(downsampled[i]);
    }

    while (bufferQueue.length >= CHUNK_SIZE) {
      const chunk = bufferQueue.splice(0, CHUNK_SIZE);
      window.electronAPI.sendAudioChunk(Float32Array.from(chunk));
    }
  };

  source.connect(processor);
  processor.connect(context.destination);

  audioContext = context;
  mediaStream = stream;
  processorNode = processor;
  bufferQueue = [];
}

async function stopCapture() {
  if (processorNode) {
    try {
      processorNode.disconnect();
    } catch (err) {
      console.warn('processor disconnect error', err);
    }
    processorNode.onaudioprocess = null;
    processorNode = null;
  }

  if (audioContext) {
    try {
      await audioContext.close();
    } catch (err) {
      console.warn('audio context close failed', err);
    }
    audioContext = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  bufferQueue = [];
}

function renderTranscript(payload) {
  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  transcriptContainer.innerHTML = '';

  if (!segments.length) {
    transcriptContainer.classList.add('placeholder');
    transcriptContainer.textContent = 'No audio yet.';
    return;
  }

  transcriptContainer.classList.remove('placeholder');

  segments.forEach((segment) => {
    const row = document.createElement('div');
    row.className = 'segment';

    const ts = document.createElement('span');
    ts.className = 'timestamp';
    ts.textContent = formatTimestamp(segment.start, segment.end);

    const text = document.createElement('span');
    text.className = 'segment-text';
    text.textContent = (segment.text || '').trim();

    row.appendChild(ts);
    row.appendChild(text);
    transcriptContainer.appendChild(row);
  });

  transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
}

function renderNotes(payload) {
  const bullets = Array.isArray(payload?.bullets) ? payload.bullets : [];
  notesList.innerHTML = '';

  if (!bullets.length) {
    const empty = document.createElement('div');
    empty.className = 'placeholder';
    empty.textContent = notesEnabled
      ? 'Notes will appear once we capture speech.'
      : 'Provide an OPENAI_API_KEY in .env to enable notes.';
    notesList.appendChild(empty);
    return;
  }

  bullets.forEach((bullet) => {
    const item = document.createElement('li');
    item.textContent = bullet;
    notesList.appendChild(item);
  });
}

function refreshNotesStatus() {
  if (!notesEnabled) {
    notesStatus.textContent = 'Notes disabled (missing OPENAI_API_KEY).';
    return;
  }
  notesStatus.textContent = capturing ? 'Notes ready.' : 'Notes idle.';
}

function updateSessionFolderDisplay() {
  if (!sessionPathValue || !openFolderButton) {
    return;
  }

  const active = sessionFolder;
  const fallback = lastSessionFolder;
  const displayPath = active || fallback;

  if (displayPath) {
    sessionPathValue.textContent = active ? displayPath : `${displayPath} (saved)`;
    sessionPathValue.classList.remove('placeholder');
    const label = active ? 'Reveal in Finder' : 'Open saved folder';
    openFolderButton.textContent = label;
    openFolderButton.disabled = revealBusy;
  } else {
    sessionPathValue.textContent = 'No capture yet.';
    sessionPathValue.classList.add('placeholder');
    openFolderButton.textContent = 'Reveal in Finder';
    openFolderButton.disabled = true;
  }
}

updateSessionFolderDisplay();
