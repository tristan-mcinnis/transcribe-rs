const fs = require('fs');
const path = require('path');

function buildSpawnCommand(repoRoot, modelPath, engine, language, existsSync = fs.existsSync) {
  const binaryName = process.platform === 'win32' ? 'realtime_cli.exe' : 'realtime_cli';
  const candidates = [
    path.join(repoRoot, 'target', 'debug', binaryName),
    path.join(repoRoot, 'target', 'release', binaryName),
  ];

  const normalizedEngine = (engine || 'whisper').toLowerCase();
  const args = ['--engine', normalizedEngine, '--model-path', modelPath];
  if (language) {
    args.push('--language', language);
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { command: candidate, args };
    }
  }

  const cargoArgs = ['run', '--quiet', '--bin', 'realtime_cli', '--', ...args];
  return { command: 'cargo', args: cargoArgs };
}

function formatTimestamp(start, end) {
  const clamp = (value) => (Number.isFinite(value) ? Math.max(0, value) : 0);
  const midpoint = (clamp(start) + clamp(end)) / 2;
  const minutes = Math.floor(midpoint / 60);
  const seconds = Math.floor(midpoint % 60)
    .toString()
    .padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function extractResponseText(response) {
  if (!response || typeof response !== 'object') {
    return '';
  }
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text;
  }
  if (Array.isArray(response.output)) {
    const text = response.output
      .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
      .flatMap((entry) => (typeof entry?.text === 'string' ? [entry.text] : []))
      .join('');
    if (text.trim()) {
      return text;
    }
  }
  return '';
}

function parseNotesOutput(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string') {
    return [];
  }
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed.bullets)) {
      return parsed.bullets.map((entry) => String(entry)).filter(Boolean);
    }
    if (Array.isArray(parsed.notes)) {
      return parsed.notes.map((entry) => String(entry)).filter(Boolean);
    }
  } catch (error) {
    // fall through to plaintext parsing
  }

  return trimmed
    .split(/\n+/)
    .map((line) => line.replace(/^[-•\s]+/, '').trim())
    .filter(Boolean);
}

function createCliLineHandler({ onReady, onStatus, onError, onTranscript } = {}) {
  return function handleCliLine(line) {
    if (!line || !line.trim()) {
      return null;
    }

    let payload;
    try {
      payload = JSON.parse(line);
    } catch (error) {
      return null;
    }

    switch (payload.type) {
      case 'ready': {
        onReady?.(payload);
        return 'ready';
      }
      case 'status': {
        onStatus?.(String(payload.message ?? ''));
        return 'status';
      }
      case 'error': {
        onError?.(String(payload.message ?? ''));
        return 'error';
      }
      case 'transcript': {
        const text = typeof payload.text === 'string' ? payload.text : '';
        const segments = Array.isArray(payload.segments) ? payload.segments : [];
        onTranscript?.({ text, segments });
        return 'transcript';
      }
      default:
        return typeof payload.type === 'string' ? payload.type : null;
    }
  };
}

module.exports = {
  buildSpawnCommand,
  formatTimestamp,
  extractResponseText,
  parseNotesOutput,
  createCliLineHandler,
};
