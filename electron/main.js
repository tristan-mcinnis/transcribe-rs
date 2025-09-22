const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const dotenv = require('dotenv');
const {
  buildSpawnCommand,
  createCliLineHandler,
} = require('./session-utils');
const { PaneManager } = require('./pane-manager');
const { DEFAULT_PANE_TEMPLATES } = require('./pane-templates');

const repoRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(repoRoot, '.env') });

let mainWindow;
let cliProcess = null;
let cliReady = false;
let stdoutBuffer = '';
let transcriptState = { text: '', segments: [] };
let openaiClient = null;
let llmAvailable = false;
try {
  const { OpenAI } = require('openai');
  if (process.env.OPENAI_API_KEY) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    llmAvailable = true;
  }
} catch (err) {
  console.warn('OpenAI client unavailable:', err.message);
}

const paneManager = new PaneManager({
  openaiClient,
  onUpdate: (payload) => {
    mainWindow?.webContents.send('pane-update', payload);
  },
  onRemove: (paneId) => {
    mainWindow?.webContents.send('pane-removed', paneId);
  },
});
paneManager.setOpenAIClient(openaiClient);

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
    paneManager.setTranscript(transcriptState);
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
    mainWindow?.webContents.send('pane-llm-availability', llmAvailable);
    pushTranscript();
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
    return { success: true, llmAvailable };
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
  return { success: true };
});

ipcMain.handle('pane:get-templates', async () =>
  DEFAULT_PANE_TEMPLATES.map((template) => ({ ...template }))
);

ipcMain.handle('pane:set-configs', async (_event, configs) => {
  try {
    paneManager.setPanes(Array.isArray(configs) ? configs : []);
    return { success: true };
  } catch (error) {
    console.error('Failed to configure panes', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('pane:refresh', async (_event, paneId) => {
  try {
    paneManager.forceRefresh(String(paneId || ''));
    return { success: true };
  } catch (error) {
    console.error('Failed to refresh pane', error);
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
    resetState();
    pushTranscript();

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
}

function resetState() {
  transcriptState = { text: '', segments: [] };
  paneManager.resetOutputs();
  paneManager.setTranscript(transcriptState);
}

function pushTranscript() {
  mainWindow?.webContents.send('transcript-update', transcriptState);
}

function sendStatus(message) {
  mainWindow?.webContents.send('status-update', message);
}
