const { PaneManager } = require('../pane-manager');

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('PaneManager', () => {
  test('emits structured list updates when LLM is available', async () => {
    const updates = [];
    const openaiClient = {
      responses: {
        create: jest.fn(() =>
          Promise.resolve({
            output_text: JSON.stringify({ bullets: ['First', 'Second'] }),
          })
        ),
      },
    };

    const manager = new PaneManager({
      openaiClient,
      onUpdate: (payload) => updates.push(payload),
    });

    manager.setPanes([
      {
        id: 'notes',
        title: 'Notes',
        variant: 'list',
        systemPrompt: 'system',
        promptTemplate: 'Transcript\n{{transcript}}',
        response: { type: 'json_list', field: 'bullets' },
        throttleMs: 800,
      },
    ]);

    manager.setTranscript({
      text: 'hello world',
      segments: [{ start: 0, end: 2, text: 'hello world' }],
    });

    manager.forceRefresh('notes');
    await flushAsync();
    await flushAsync();

    expect(openaiClient.responses.create).toHaveBeenCalled();
    const readyUpdate = updates.find((update) => update.status === 'ready');
    expect(readyUpdate).toBeTruthy();
    expect(readyUpdate.items).toEqual(['First', 'Second']);
  });

  test('reports unavailable status when no LLM client is configured', () => {
    const updates = [];
    const manager = new PaneManager({
      openaiClient: null,
      onUpdate: (payload) => updates.push(payload),
    });

    manager.setPanes([
      {
        id: 'actions',
        title: 'Action Items',
        variant: 'list',
        systemPrompt: 'system',
        promptTemplate: 'Transcript\n{{transcript}}',
        response: { type: 'json_list', field: 'items' },
      },
    ]);

    manager.setTranscript({ text: '', segments: [] });

    const finalUpdate = updates[updates.length - 1];
    expect(finalUpdate.status).toBe('llm-unavailable');
  });
});
