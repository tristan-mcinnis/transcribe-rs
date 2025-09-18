const {
  buildSpawnCommand,
  formatTimestamp,
  extractResponseText,
  parseNotesOutput,
  createCliLineHandler,
} = require('../session-utils');

describe('buildSpawnCommand', () => {
  const repoRoot = '/repo';
  const modelPath = '/repo/models/model.bin';

  test('returns direct binary path when available', () => {
    const exists = jest.fn((candidate) => candidate.includes('target/debug'));
    const result = buildSpawnCommand(repoRoot, modelPath, 'whisper', undefined, exists);

    expect(result.command).toBe(`${repoRoot}/target/debug/realtime_cli`);
    expect(result.args).toEqual(['--engine', 'whisper', '--model-path', modelPath]);
    expect(exists).toHaveBeenCalled();
  });

  test('falls back to cargo when binaries are missing', () => {
    const exists = jest.fn(() => false);
    const result = buildSpawnCommand(repoRoot, modelPath, 'Parakeet', 'en', exists);

    expect(result.command).toBe('cargo');
    expect(result.args).toEqual([
      'run',
      '--quiet',
      '--bin',
      'realtime_cli',
      '--',
      '--engine',
      'parakeet',
      '--model-path',
      modelPath,
      '--language',
      'en',
    ]);
  });
});

describe('formatTimestamp', () => {
  test('produces minute:second strings with clamping', () => {
    expect(formatTimestamp(0, 0)).toBe('0:00');
    expect(formatTimestamp(5.2, 9.7)).toBe('0:07');
    expect(formatTimestamp(-10, 70)).toBe('0:35');
  });
});

describe('extractResponseText', () => {
  test('prefers output_text when available', () => {
    const response = { output_text: 'ready' };
    expect(extractResponseText(response)).toBe('ready');
  });

  test('flattens structured output arrays', () => {
    const response = {
      output: [
        {
          content: [
            { text: 'first ' },
            { text: 'second' },
            { notText: 'ignored' },
          ],
        },
        { content: [{ text: ' third' }] },
      ],
    };
    expect(extractResponseText(response)).toBe('first second third');
  });

  test('returns empty string for missing data', () => {
    expect(extractResponseText(null)).toBe('');
    expect(extractResponseText({})).toBe('');
  });
});

describe('parseNotesOutput', () => {
  test('reads bullets from JSON payloads', () => {
    const json = JSON.stringify({ bullets: ['One', 'Two'] });
    expect(parseNotesOutput(json)).toEqual(['One', 'Two']);
  });

  test('accepts alternate notes array', () => {
    const json = JSON.stringify({ notes: ['A', 2] });
    expect(parseNotesOutput(json)).toEqual(['A', '2']);
  });

  test('splits plaintext lines when JSON parsing fails', () => {
    const text = '• first\n- second\nthird';
    expect(parseNotesOutput(text)).toEqual(['first', 'second', 'third']);
  });
});

describe('createCliLineHandler', () => {
  test('invokes callbacks and returns message types', () => {
    const events = { ready: 0, status: [], error: [], transcript: [] };
    const handler = createCliLineHandler({
      onReady: (payload) => {
        events.ready += 1;
        expect(payload.engine).toBe('Whisper');
      },
      onStatus: (message) => events.status.push(message),
      onError: (message) => events.error.push(message),
      onTranscript: ({ text, segments }) => {
        events.transcript.push({ text, segments });
      },
    });

    expect(handler('')).toBeNull();
    expect(handler('{ invalid json')).toBeNull();
    expect(handler('{"type":"ready","engine":"Whisper"}')).toBe('ready');
    expect(handler('{"type":"status","message":"ok"}')).toBe('status');
    expect(handler('{"type":"error","message":"fail"}')).toBe('error');
    expect(
      handler(
        JSON.stringify({
          type: 'transcript',
          text: 'hello',
          segments: [{ start: 0, end: 1, text: 'hello' }],
        })
      )
    ).toBe('transcript');

    expect(events.ready).toBe(1);
    expect(events.status).toEqual(['ok']);
    expect(events.error).toEqual(['fail']);
    expect(events.transcript).toEqual([
      { text: 'hello', segments: [{ start: 0, end: 1, text: 'hello' }] },
    ]);
  });
});
