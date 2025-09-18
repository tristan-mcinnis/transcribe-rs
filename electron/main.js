const { app, BrowserWindow, ipcMain } = require('electron');
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

let mainWindow;
let cliProcess = null;
let cliReady = false;
let stdoutBuffer = '';
let transcriptState = { text: '', segments: [] };
let notesState = { bullets: [], raw: '' };
let noteUpdateScheduled = false;

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
});

ipcMain.handle('start-session', async (_event, config) => {
  try {
    await startCliProcess(config);
    return { success: true, notesEnabled: notesAvailable };
  } catch (error) {
    console.error('Failed to start session', error);
    sendStatus(`Failed to start: ${error.message}`);
    stopCliProcess();
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-session', async () => {
  stopCliProcess();
  resetState();
  pushTranscript();
  pushNotes();
  return { success: true };
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
}

function pushNotes() {
  mainWindow?.webContents.send('notes-update', notesState);
}

function sendStatus(message) {
  mainWindow?.webContents.send('status-update', message);
}
