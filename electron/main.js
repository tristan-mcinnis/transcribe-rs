const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const dotenv = require('dotenv');
const {
  buildSpawnCommand,
  formatTimestamp,
  extractResponseText,
  parseNotesOutput,
  createCliLineHandler,
} = require('./session-utils');

const repoRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(repoRoot, '.env') });

const SESSION_DIR_NAME = 'TranscribeRS Sessions';
const TRANSCRIPT_WRITE_DELAY_MS = 900;
const NOTES_WRITE_DELAY_MS = 1200;

let mainWindow;
let cliProcess = null;
let cliReady = false;
let stdoutBuffer = '';
let transcriptState = { text: '', segments: [] };
let notesState = { bullets: [], raw: '' };
let noteUpdateScheduled = false;

let sessionFolderPath = null;
let lastSessionFolderPath = null;
let transcriptSnapshotPath = null;
let transcriptLogPath = null;
let notesSnapshotPath = null;
let notesLogPath = null;
let metadataPath = null;
let transcriptSaveTimer = null;
let notesSaveTimer = null;
let lastPersistedTranscriptJson = null;
let lastPersistedNotesJson = null;
let sessionMetadata = null;

let openaiClient = null;
let notesAvailable = false;
try {
  const { OpenAI } = require('openai');
  if (process.env.OPENAI_API_KEY) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    notesAvailable = true;
  }
} catch (err) {
  console.warn('OpenAI client unavailable:', err.message);
}

const handleCliLine = createCliLineHandler({
  onReady: (payload) => {
    cliReady = true;
    const engine = typeof payload?.engine === 'string' ? payload.engine : 'unknown';
    sendStatus(`engine ready (${engine})`);
  },
  onStatus: (message) => {
    sendStatus(message);
  },
  onError: (message) => {
    sendStatus(`engine error: ${message}`);
  },
  onTranscript: ({ text, segments }) => {
    transcriptState = {
      text: typeof text === 'string' ? text : '',
      segments: Array.isArray(segments) ? segments : [],
    };
    pushTranscript();
    if (notesAvailable) {
      scheduleNotesUpdate();
    }
  },
});

function formatSessionFolderName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  const seconds = pad(now.getSeconds());
  return `session-${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function clearPersistenceTimers() {
  if (transcriptSaveTimer) {
    clearTimeout(transcriptSaveTimer);
    transcriptSaveTimer = null;
  }
  if (notesSaveTimer) {
    clearTimeout(notesSaveTimer);
    notesSaveTimer = null;
  }
}

function resetPersistenceState() {
  transcriptSnapshotPath = null;
  transcriptLogPath = null;
  notesSnapshotPath = null;
  notesLogPath = null;
  metadataPath = null;
  sessionFolderPath = null;
  sessionMetadata = null;
  transcriptSaveTimer = null;
  notesSaveTimer = null;
  lastPersistedTranscriptJson = null;
  lastPersistedNotesJson = null;
}

function touchMetadata(extra = {}) {
  if (!metadataPath || !sessionMetadata) {
    return;
  }
  const timestamp = new Date().toISOString();
  sessionMetadata = {
    ...sessionMetadata,
    ...extra,
    updatedAt: timestamp,
  };
  try {
    fs.writeFileSync(metadataPath, JSON.stringify(sessionMetadata, null, 2), 'utf8');
  } catch (error) {
    console.warn('Failed to persist session metadata', error);
  }
}

function persistTranscriptSnapshot(force = false) {
  if (!sessionFolderPath || !transcriptSnapshotPath) {
    return;
  }
  const basePayload = {
    text: typeof transcriptState.text === 'string' ? transcriptState.text : '',
    segments: Array.isArray(transcriptState.segments) ? transcriptState.segments : [],
  };
  const serialized = JSON.stringify(basePayload);
  if (!force && serialized === lastPersistedTranscriptJson) {
    return;
  }

  lastPersistedTranscriptJson = serialized;
  const payload = {
    ...basePayload,
    updatedAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(transcriptSnapshotPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.appendFileSync(transcriptLogPath, `${JSON.stringify(payload)}\n`, 'utf8');
    touchMetadata();
  } catch (error) {
    console.warn('Failed to persist transcript snapshot', error);
  }
}

function persistNotesSnapshot(force = false) {
  if (!sessionFolderPath || !notesSnapshotPath) {
    return;
  }

  const basePayload = {
    bullets: Array.isArray(notesState.bullets) ? notesState.bullets : [],
    raw: typeof notesState.raw === 'string' ? notesState.raw : '',
  };
  const serialized = JSON.stringify(basePayload);
  if (!force && serialized === lastPersistedNotesJson) {
    return;
  }

  lastPersistedNotesJson = serialized;
  const payload = {
    ...basePayload,
    updatedAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(notesSnapshotPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.appendFileSync(notesLogPath, `${JSON.stringify(payload)}\n`, 'utf8');
    touchMetadata();
  } catch (error) {
    console.warn('Failed to persist notes snapshot', error);
  }
}

function scheduleTranscriptPersist() {
  if (!sessionFolderPath) {
    return;
  }
  if (transcriptSaveTimer) {
    clearTimeout(transcriptSaveTimer);
  }
  transcriptSaveTimer = setTimeout(() => {
    transcriptSaveTimer = null;
    persistTranscriptSnapshot();
  }, TRANSCRIPT_WRITE_DELAY_MS);
}

function scheduleNotesPersist() {
  if (!sessionFolderPath) {
    return;
  }
  if (notesSaveTimer) {
    clearTimeout(notesSaveTimer);
  }
  notesSaveTimer = setTimeout(() => {
    notesSaveTimer = null;
    persistNotesSnapshot();
  }, NOTES_WRITE_DELAY_MS);
}

function pushSessionFolder() {
  mainWindow?.webContents.send('session-folder', {
    active: sessionFolderPath,
    last: lastSessionFolderPath,
  });
}

function prepareSessionStorage({ engine, language, modelPath }) {
  clearPersistenceTimers();
  resetPersistenceState();

  try {
    const documentsDir = app.getPath('documents');
    const baseDir = path.join(documentsDir, SESSION_DIR_NAME);
    fs.mkdirSync(baseDir, { recursive: true });

    const folderName = formatSessionFolderName();
    const folderPath = path.join(baseDir, folderName);
    fs.mkdirSync(folderPath, { recursive: true });

    sessionFolderPath = folderPath;
    lastSessionFolderPath = folderPath;
    transcriptSnapshotPath = path.join(folderPath, 'transcript.json');
    transcriptLogPath = path.join(folderPath, 'transcript.log.jsonl');
    notesSnapshotPath = path.join(folderPath, 'notes.json');
    notesLogPath = path.join(folderPath, 'notes.log.jsonl');
    metadataPath = path.join(folderPath, 'session.json');

    const startedAt = new Date().toISOString();
    sessionMetadata = {
      startedAt,
      updatedAt: startedAt,
      engine,
      language: language || null,
      modelPath,
      platform: process.platform,
    };
    fs.writeFileSync(metadataPath, JSON.stringify(sessionMetadata, null, 2), 'utf8');

    persistTranscriptSnapshot(true);
    persistNotesSnapshot(true);
    pushSessionFolder();
    sendStatus(`saving session to ${folderPath}`);
  } catch (error) {
    console.warn('Failed to prepare session storage', error);
    resetPersistenceState();
    pushSessionFolder();
    sendStatus(`warning: unable to prepare session storage (${error.message})`);
  }
}

function finalizeSessionStorage({ markEnded = true } = {}) {
  if (!sessionFolderPath) {
    return;
  }

  clearPersistenceTimers();
  persistTranscriptSnapshot(true);
  persistNotesSnapshot(true);

  if (markEnded) {
    touchMetadata({ endedAt: new Date().toISOString() });
  } else {
    touchMetadata();
  }

  lastSessionFolderPath = sessionFolderPath || lastSessionFolderPath;
  resetPersistenceState();
  pushSessionFolder();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow?.webContents.send('notes-availability', notesAvailable);
    pushTranscript();
    pushNotes();
    pushSessionFolder();
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopCliProcess();
  finalizeSessionStorage();
});

ipcMain.handle('start-session', async (_event, config) => {
  try {
    await startCliProcess(config);
    return {
      success: true,
      notesEnabled: notesAvailable,
      sessionFolder: sessionFolderPath,
      previousFolder: lastSessionFolderPath,
    };
  } catch (error) {
    console.error('Failed to start session', error);
    sendStatus(`Failed to start: ${error.message}`);
    stopCliProcess();
    finalizeSessionStorage({ markEnded: false });
    resetState();
    pushTranscript();
    pushNotes();
    return {
      success: false,
      error: error.message,
      sessionFolder: sessionFolderPath,
      previousFolder: lastSessionFolderPath,
    };
  }
});

ipcMain.handle('stop-session', async () => {
  stopCliProcess();
  finalizeSessionStorage();
  resetState();
  pushTranscript();
  pushNotes();
  return { success: true, sessionFolder: lastSessionFolderPath };
});

ipcMain.handle('reveal-session-folder', async () => {
  const target = sessionFolderPath || lastSessionFolderPath;
  if (!target) {
    return { success: false, error: 'No session folder available yet.' };
  }

  try {
    if (!fs.existsSync(target)) {
      return { success: false, error: 'Session folder is no longer available on disk.' };
    }
    const result = await shell.openPath(target);
    if (typeof result === 'string' && result.trim()) {
      return { success: false, error: result.trim() };
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.on('audio-chunk', (_event, payload) => {
  if (!cliProcess || !cliReady) {
    return;
  }

  try {
    let dataArray;
    if (ArrayBuffer.isView(payload)) {
      dataArray = Array.from(payload);
    } else if (Array.isArray(payload)) {
      dataArray = payload;
    } else {
      dataArray = Array.from(payload || []);
    }

    if (!dataArray.length) {
      return;
    }

    const message = JSON.stringify({ type: 'chunk', samples: dataArray });
    cliProcess.stdin.write(message + '\n');
  } catch (error) {
    console.error('Failed to forward chunk', error);
    sendStatus(`audio chunk error: ${error.message}`);
  }
});

function startCliProcess(config) {
  return new Promise((resolve, reject) => {
    if (!config || !config.modelPath) {
      reject(new Error('Model path is required'));
      return;
    }

    stopCliProcess();
    finalizeSessionStorage();
    resetState();
    pushTranscript();
    pushNotes();

    const resolvedModelPath = path.isAbsolute(config.modelPath)
      ? config.modelPath
      : path.join(repoRoot, config.modelPath);

    if (!fs.existsSync(resolvedModelPath)) {
      reject(new Error(`Model path not found: ${resolvedModelPath}`));
      return;
    }

    const engine = (config.engine || 'whisper').toLowerCase();
    const language = config.language ? String(config.language).trim() : '';

    prepareSessionStorage({
      engine,
      language: language || undefined,
      modelPath: resolvedModelPath,
    });

    const spawnConfig = buildSpawnCommand(
      repoRoot,
      resolvedModelPath,
      engine,
      language || undefined,
    );
    try {
      cliProcess = spawn(spawnConfig.command, spawnConfig.args, {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (spawnErr) {
      reject(spawnErr);
      return;
    }

    cliReady = false;
    stdoutBuffer = '';

    let settled = false;
    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Timed out waiting for transcription engine to start'));
      }
    }, 15000);

    const handleStdout = (data) => {
      stdoutBuffer += data;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const messageType = handleCliLine(line);
        if (!settled && messageType === 'ready') {
          settled = true;
          clearTimeout(timeoutId);
          resolve();
        }
      }
    };

    cliProcess.stdout.setEncoding('utf8');
    cliProcess.stdout.on('data', handleStdout);

    cliProcess.stderr.setEncoding('utf8');
    cliProcess.stderr.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        sendStatus(`[engine] ${message}`);
      }
    });

    cliProcess.once('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        reject(err);
      }
    });

    cliProcess.once('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      sendStatus(`transcription process exited (${reason})`);
      cliProcess = null;
      cliReady = false;
      finalizeSessionStorage();
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        reject(new Error(`transcription process exited early (${reason})`));
      }
    });
  });
}

function scheduleNotesUpdate() {
  if (!notesAvailable || !openaiClient) {
    return;
  }
  if (!transcriptState.text || !transcriptState.text.trim()) {
    return;
  }
  if (noteUpdateScheduled) {
    return;
  }
  noteUpdateScheduled = true;
  setTimeout(async () => {
    noteUpdateScheduled = false;
    await updateNotes();
  }, 1200);
}

async function updateNotes() {
  if (!openaiClient || !notesAvailable) {
    return;
  }
  const transcript = transcriptState;
  if (!transcript.text?.trim()) {
    notesState = { bullets: [], raw: '' };
    pushNotes();
    return;
  }

  mainWindow?.webContents.send('notes-status', 'generating');

  const segmentLines = transcript.segments
    .map((segment) => {
      const time = formatTimestamp(segment.start, segment.end);
      return `${time} ${segment.text}`.trim();
    })
    .join('\n');

  const prompt = [
    {
      role: 'system',
      content:
        'You are a focused real-time note taker. Convert live transcript snippets into concise, chronological bullet notes that capture context, needs, comparisons, blockers, and next steps. Keep bullets short but information-rich.',
    },
    {
      role: 'user',
      content: `Live transcript so far:\n${segmentLines}\n\nReturn JSON with a \"bullets\" array ordered chronologically. Each bullet should be a standalone insight summarizing the preceding lines.`,
    },
  ];

  try {
    const response = await openaiClient.responses.create({
      model: 'gpt-5-nano',
      input: prompt,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'chronological_notes',
          schema: {
            type: 'object',
            properties: {
              bullets: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
            },
            required: ['bullets'],
          },
        },
      },
      max_output_tokens: 400,
    });

    const rawOutput = extractResponseText(response);
    const bullets = parseNotesOutput(rawOutput);

    notesState = { bullets, raw: rawOutput };
    pushNotes();
    mainWindow?.webContents.send('notes-status', 'ready');
  } catch (error) {
    console.error('Note generation failed', error);
    mainWindow?.webContents.send('notes-status', 'error');
    sendStatus(`note generation error: ${error.message}`);
  }
}

function stopCliProcess() {
  if (cliProcess) {
    try {
      cliProcess.kill();
    } catch (error) {
      console.warn('Failed to kill CLI process', error);
    }
    cliProcess = null;
  }
  cliReady = false;
  stdoutBuffer = '';
  noteUpdateScheduled = false;
}

function resetState() {
  transcriptState = { text: '', segments: [] };
  notesState = { bullets: [], raw: '' };
}

function pushTranscript() {
  mainWindow?.webContents.send('transcript-update', transcriptState);
  scheduleTranscriptPersist();
}

function pushNotes() {
  mainWindow?.webContents.send('notes-update', notesState);
  scheduleNotesPersist();
}

function sendStatus(message) {
  mainWindow?.webContents.send('status-update', message);
}
