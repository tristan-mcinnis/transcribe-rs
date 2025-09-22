const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SIZE = TARGET_SAMPLE_RATE;

const { downsampleBuffer, formatTimestamp } = window.rendererUtils || {};
if (typeof downsampleBuffer !== 'function' || typeof formatTimestamp !== 'function') {
  throw new Error('Renderer utilities failed to load.');
}

const PANE_CONFIG_STORAGE_KEY = 'transcribeRS.panes.v1';
const PANE_LAYOUT_STORAGE_KEY = 'transcribeRS.layout.v1';
const DEFAULT_TRANSCRIPT_POSITION = { x: 24, y: 24 };

const modelInput = document.getElementById('modelPath');
const engineSelect = document.getElementById('engine');
const languageInput = document.getElementById('language');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusLine = document.getElementById('status');
const paneTemplateSelect = document.getElementById('paneTemplate');
const addPaneButton = document.getElementById('addPaneButton');
const customPaneButton = document.getElementById('customPaneButton');
const paneHint = document.getElementById('paneHint');
const paneCanvas = document.getElementById('paneCanvas');
const transcriptContainer = document.getElementById('transcript');
const transcriptStatus = document.getElementById('transcriptStatus');
const transcriptPaneElement = paneCanvas.querySelector('[data-pane-id="transcript"]');

let audioContext = null;
let mediaStream = null;
let processorNode = null;
let bufferQueue = [];
let capturing = false;
let llmAvailable = false;
let paneTemplates = [];
let paneTemplateLookup = new Map();
let zCounter = 20;

const paneState = new Map();
const paneElements = new Map();
const paneLayout = loadPaneLayout();
let activePaneConfigs = loadActivePaneConfigs();

initializeTranscriptPane();
bootstrapTemplates();

window.electronAPI.onStatus((message) => {
  statusLine.textContent = message;
});

window.electronAPI.onTranscript((payload) => {
  renderTranscript(payload);
});

window.electronAPI.onPaneUpdate((payload) => {
  if (!payload || !payload.id) {
    return;
  }
  const normalized = normalizePaneUpdate(payload);
  paneState.set(normalized.id, normalized);
  const entry = ensurePaneElement(normalized.id, normalized);
  renderPane(entry, normalized);
  ensurePanePosition(normalized.id);
  refreshPaneHint();
});

window.electronAPI.onPaneRemoved((paneId) => {
  if (!paneId || paneId === 'transcript') {
    return;
  }
  paneState.delete(paneId);
  removePaneElement(paneId);
  delete paneLayout[paneId];
  savePaneLayout();
  refreshPaneHint();
});

window.electronAPI.oncePaneAvailability((available) => {
  llmAvailable = Boolean(available);
  refreshPaneHint();
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
      return;
    }

    if (typeof response.llmAvailable === 'boolean') {
      llmAvailable = response.llmAvailable;
    }

    await startCapture();
    capturing = true;
    startButton.disabled = true;
    stopButton.disabled = false;
    refreshPaneHint();
    statusLine.textContent = 'Listening…';
    transcriptStatus.textContent = 'Streaming transcript…';
  } catch (error) {
    console.error(error);
    statusLine.textContent = `Start failed: ${error.message}`;
    startButton.disabled = false;
    refreshPaneHint();
  }
});

stopButton.addEventListener('click', async () => {
  if (!capturing) {
    return;
  }
  stopButton.disabled = true;
  try {
    await stopCapture();
    await window.electronAPI.stopSession();
  } finally {
    capturing = false;
    startButton.disabled = false;
    refreshPaneHint();
    statusLine.textContent = 'Capture stopped.';
    transcriptStatus.textContent = 'Capture paused.';
  }
});

addPaneButton.addEventListener('click', () => {
  const templateId = paneTemplateSelect.value;
  if (!templateId) {
    statusLine.textContent = 'Select a pane template to add.';
    return;
  }
  addPaneFromTemplate(templateId);
});

customPaneButton.addEventListener('click', () => {
  createCustomPane();
});

paneCanvas.addEventListener('click', (event) => {
  const pane = event.target.closest('.floating-pane');
  if (!pane) {
    return;
  }
  elevatePane(pane);
});

window.addEventListener('resize', () => {
  for (const paneId of Object.keys(paneLayout)) {
    updatePanePosition(paneId, paneLayout[paneId]?.x, paneLayout[paneId]?.y, {
      clamp: true,
      persist: true,
    });
  }
});

function initializeTranscriptPane() {
  if (!paneLayout.transcript) {
    paneLayout.transcript = { ...DEFAULT_TRANSCRIPT_POSITION };
  }
  const entry = {
    element: transcriptPaneElement,
    statusEl: transcriptStatus,
    contentEl: transcriptContainer,
    titleEl: transcriptPaneElement.querySelector('.pane-title'),
    actions: {},
  };
  paneElements.set('transcript', entry);
  makePaneDraggable(transcriptPaneElement, 'transcript');
  ensurePanePosition('transcript');
  refreshPaneHint();
}

async function bootstrapTemplates() {
  try {
    const templates = await window.electronAPI.getPaneTemplates();
    paneTemplates = Array.isArray(templates) ? templates : [];
  } catch (error) {
    console.warn('Failed to load pane templates', error);
    paneTemplates = [];
  }

  paneTemplateLookup = new Map(
    paneTemplates.map((template, index) => [
      template.templateId || `template-${index}`,
      template,
    ])
  );

  populateTemplateSelect();

  if (!Array.isArray(activePaneConfigs) || !activePaneConfigs.length) {
    const noteTemplate = paneTemplates.find((tpl) => tpl.templateId === 'note-taker') || paneTemplates[0];
    if (noteTemplate) {
      const config = createPaneConfigFromTemplate(noteTemplate);
      activePaneConfigs = [config];
      ensurePanePosition(config.id);
      createPanePlaceholder(config);
    }
  } else {
    for (const pane of activePaneConfigs) {
      ensurePanePosition(pane.id);
      createPanePlaceholder(pane);
    }
  }

  syncPaneConfigs();
  refreshPaneHint();
}

function populateTemplateSelect() {
  paneTemplateSelect.innerHTML = '';
  if (!paneTemplates.length) {
    const option = document.createElement('option');
    option.textContent = 'No templates available';
    option.disabled = true;
    paneTemplateSelect.appendChild(option);
    return;
  }

  for (const template of paneTemplates) {
    const option = document.createElement('option');
    option.value = template.templateId || template.title;
    option.textContent = template.title || template.templateId || 'Pane';
    paneTemplateSelect.appendChild(option);
  }
}

function startCapture() {
  if (audioContext) {
    return Promise.resolve();
  }

  return navigator.mediaDevices
    .getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
      video: false,
    })
    .then(async (stream) => {
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
    });
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
    transcriptStatus.textContent = capturing ? 'Listening for audio…' : 'No audio yet.';
    const placeholder = document.createElement('div');
    placeholder.className = 'pane-placeholder';
    placeholder.textContent = 'Start capture to stream the transcript.';
    transcriptContainer.appendChild(placeholder);
    return;
  }

  transcriptStatus.textContent = capturing ? 'Streaming transcript…' : 'Transcript paused.';

  const recentSegments = segments.slice(-60);
  for (const segment of recentSegments) {
    const row = document.createElement('div');
    row.className = 'transcript-segment';

    const ts = document.createElement('span');
    ts.className = 'transcript-timestamp';
    ts.textContent = formatTimestamp(segment.start, segment.end);

    const text = document.createElement('span');
    text.className = 'transcript-text';
    text.textContent = (segment.text || '').trim();

    row.appendChild(ts);
    row.appendChild(text);
    transcriptContainer.appendChild(row);
  }

  transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
}

function normalizePaneUpdate(payload) {
  return {
    id: String(payload.id),
    title: payload.title ? String(payload.title) : 'AI Pane',
    variant: payload.variant === 'text' ? 'text' : 'list',
    status: String(payload.status || 'idle'),
    items: Array.isArray(payload.items) ? payload.items.map((item) => String(item)) : [],
    text: typeof payload.text === 'string' ? payload.text : '',
    error: typeof payload.error === 'string' ? payload.error : '',
    raw: typeof payload.raw === 'string' ? payload.raw : '',
    structured: Array.isArray(payload.structured) ? payload.structured : [],
    lastUpdated: Number.isFinite(payload.lastUpdated) ? payload.lastUpdated : null,
    allowPromptEdit: payload.allowPromptEdit !== false,
    model: typeof payload.model === 'string' ? payload.model : undefined,
  };
}

function ensurePaneElement(paneId, paneUpdate) {
  if (paneElements.has(paneId)) {
    return paneElements.get(paneId);
  }

  const element = document.createElement('article');
  element.className = 'floating-pane';
  element.dataset.paneId = paneId;

  const header = document.createElement('div');
  header.className = 'pane-header';

  const title = document.createElement('div');
  title.className = 'pane-title';
  header.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'pane-actions';

  const refreshButton = document.createElement('button');
  refreshButton.className = 'pane-action';
  refreshButton.title = 'Refresh now';
  refreshButton.dataset.action = 'refresh';
  refreshButton.textContent = '↻';

  const editButton = document.createElement('button');
  editButton.className = 'pane-action';
  editButton.title = 'Edit pane';
  editButton.dataset.action = 'edit';
  editButton.textContent = '✎';

  const closeButton = document.createElement('button');
  closeButton.className = 'pane-action';
  closeButton.title = 'Close pane';
  closeButton.dataset.action = 'close';
  closeButton.textContent = '✕';

  actions.append(refreshButton, editButton, closeButton);
  header.appendChild(actions);

  const body = document.createElement('div');
  body.className = 'pane-body';

  const status = document.createElement('div');
  status.className = 'pane-status';
  body.appendChild(status);

  const content = document.createElement('div');
  content.className = 'pane-content';
  body.appendChild(content);

  element.appendChild(header);
  element.appendChild(body);
  paneCanvas.appendChild(element);

  const entry = {
    element,
    header,
    titleEl: title,
    statusEl: status,
    contentEl: content,
    actions: {
      refreshButton,
      editButton,
      closeButton,
    },
  };

  paneElements.set(paneId, entry);
  attachPaneActionHandlers(entry, paneId);
  makePaneDraggable(element, paneId);
  ensurePanePosition(paneId);
  if (paneUpdate) {
    renderPane(entry, paneUpdate);
  }
  return entry;
}

function renderPane(entry, state) {
  const config = getPaneConfig(state.id);
  entry.titleEl.textContent = state.title;

  const statusText = resolvePaneStatus(state);
  entry.statusEl.textContent = statusText.text;
  entry.statusEl.classList.toggle('error', statusText.isError);

  if (entry.actions?.refreshButton) {
    entry.actions.refreshButton.disabled = !llmAvailable || state.status === 'generating';
  }
  if (entry.actions?.editButton) {
    const editable = (config?.allowPromptEdit ?? state.allowPromptEdit) !== false;
    entry.actions.editButton.disabled = !editable;
  }

  entry.contentEl.innerHTML = '';
  if (state.variant === 'text') {
    if (state.text.trim()) {
      const block = document.createElement('div');
      block.className = 'pane-text-block';
      block.textContent = state.text.trim();
      entry.contentEl.appendChild(block);
    } else {
      entry.contentEl.appendChild(createPanePlaceholder(state));
    }
  } else {
    if (Array.isArray(state.items) && state.items.length) {
      const list = document.createElement('ul');
      list.className = 'pane-list';
      state.items.forEach((item) => {
        const li = document.createElement('li');
        li.textContent = item;
        list.appendChild(li);
      });
      entry.contentEl.appendChild(list);
    } else {
      entry.contentEl.appendChild(createPanePlaceholder(state));
    }
  }
}

function createPanePlaceholder(state) {
  const placeholder = document.createElement('div');
  placeholder.className = 'pane-placeholder';
  if (state.status === 'llm-unavailable') {
    placeholder.textContent = 'Provide an OPENAI_API_KEY to activate this pane.';
  } else if (!capturing) {
    placeholder.textContent = 'Start capture to feed this pane with live transcript.';
  } else if (state.status === 'generating') {
    placeholder.textContent = 'Synthesizing…';
  } else {
    placeholder.textContent = 'Listening… awaiting new insight.';
  }
  return placeholder;
}

function resolvePaneStatus(state) {
  const result = { text: '', isError: false };
  switch (state.status) {
    case 'llm-unavailable':
      result.text = 'AI disabled — add OPENAI_API_KEY to stream updates.';
      break;
    case 'waiting':
      result.text = capturing ? 'Waiting for fresh transcript…' : 'Idle until capture starts.';
      break;
    case 'generating':
      result.text = 'Synthesizing update…';
      break;
    case 'error':
      result.text = state.error ? `Error: ${state.error}` : 'Pane error';
      result.isError = true;
      break;
    case 'ready':
      result.text = state.lastUpdated ? `Updated ${formatRelativeTime(state.lastUpdated)}` : 'Up to date.';
      break;
    default:
      result.text = 'Idle.';
  }
  return result;
}

function formatRelativeTime(timestamp) {
  if (!timestamp) {
    return 'moments ago';
  }
  const delta = Date.now() - timestamp;
  if (delta < 2000) {
    return 'just now';
  }
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function attachPaneActionHandlers(entry, paneId) {
  if (entry.actions?.refreshButton) {
    entry.actions.refreshButton.addEventListener('click', () => {
      if (!llmAvailable) {
        statusLine.textContent = 'AI panes require an OPENAI_API_KEY.';
        return;
      }
      window.electronAPI.requestPaneRefresh(paneId);
    });
  }

  if (entry.actions?.editButton) {
    entry.actions.editButton.addEventListener('click', () => {
      editPane(paneId);
    });
  }

  if (entry.actions?.closeButton) {
    entry.actions.closeButton.addEventListener('click', () => {
      removePane(paneId);
    });
  }
}

function makePaneDraggable(element, paneId) {
  const header = element.querySelector('.pane-header');
  if (!header) {
    return;
  }

  const handlePointerDown = (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    elevatePane(element);

    const canvasRect = paneCanvas.getBoundingClientRect();
    const rect = element.getBoundingClientRect();

    const startX = event.clientX;
    const startY = event.clientY;
    const originX = rect.left - canvasRect.left;
    const originY = rect.top - canvasRect.top;
    const pointerId = event.pointerId;

    const move = (ev) => {
      if (ev.pointerId !== pointerId) {
        return;
      }
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      updatePanePosition(paneId, originX + dx, originY + dy, { clamp: true, persist: false });
    };

    const stop = (ev) => {
      if (ev.pointerId !== pointerId) {
        return;
      }
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', stop);
      header.removeEventListener('pointercancel', stop);
      try {
        header.releasePointerCapture(pointerId);
      } catch (err) {
        // ignore
      }
      element.classList.remove('dragging');
      updatePanePosition(paneId, undefined, undefined, { clamp: true, persist: true });
    };

    try {
      header.setPointerCapture(pointerId);
    } catch (err) {
      // ignore
    }
    element.classList.add('dragging');
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', stop);
    header.addEventListener('pointercancel', stop);
  };

  header.addEventListener('pointerdown', handlePointerDown);
}

function updatePanePosition(paneId, nextX, nextY, { clamp = true, persist = false } = {}) {
  const entry = paneElements.get(paneId);
  const element = entry?.element || (paneId === 'transcript' ? transcriptPaneElement : null);
  if (!element) {
    return;
  }

  const canvasRect = paneCanvas.getBoundingClientRect();
  const rect = element.getBoundingClientRect();

  let x = typeof nextX === 'number' && Number.isFinite(nextX) ? nextX : paneLayout[paneId]?.x ?? DEFAULT_TRANSCRIPT_POSITION.x;
  let y = typeof nextY === 'number' && Number.isFinite(nextY) ? nextY : paneLayout[paneId]?.y ?? DEFAULT_TRANSCRIPT_POSITION.y;

  if (clamp) {
    const maxX = Math.max(16, canvasRect.width - rect.width - 16);
    const maxY = Math.max(16, canvasRect.height - rect.height - 16);
    x = Math.min(Math.max(16, x), maxX);
    y = Math.min(Math.max(16, y), maxY);
  }

  paneLayout[paneId] = { x, y };
  element.style.left = `${Math.round(x)}px`;
  element.style.top = `${Math.round(y)}px`;

  if (persist) {
    savePaneLayout();
  }
}

function ensurePanePosition(paneId) {
  if (!paneLayout[paneId]) {
    paneLayout[paneId] = computeInitialPosition(paneId);
    savePaneLayout();
  }
  updatePanePosition(paneId, paneLayout[paneId].x, paneLayout[paneId].y, { clamp: true, persist: false });
}

function computeInitialPosition(paneId) {
  if (paneId === 'transcript') {
    return { ...DEFAULT_TRANSCRIPT_POSITION };
  }
  const index = activePaneConfigs.findIndex((pane) => pane.id === paneId);
  const column = index % 3;
  const row = Math.floor(index / 3);
  return {
    x: 220 + column * 260,
    y: 60 + row * 240,
  };
}

function elevatePane(element) {
  zCounter += 1;
  element.style.zIndex = zCounter;
}

function addPaneFromTemplate(templateId) {
  const template = paneTemplateLookup.get(templateId);
  if (!template) {
    statusLine.textContent = 'Unable to find selected template.';
    return;
  }
  const config = createPaneConfigFromTemplate(template);
  activePaneConfigs.push(config);
  ensurePanePosition(config.id);
  createPanePlaceholder(config);
  syncPaneConfigs();
  refreshPaneHint();
}

function createCustomPane() {
  const titleInput = window.prompt('Pane title', 'Custom pane');
  if (titleInput === null) {
    return;
  }
  const modeInput = window.prompt('Display as "list" or "text"?', 'list');
  if (modeInput === null) {
    return;
  }
  const instructionsInput = window.prompt(
    'Pane instructions (use {{transcript}} where the live transcript should appear).',
    'Summarize the discussion and highlight risks.'
  );
  if (instructionsInput === null) {
    return;
  }
  const systemInput = window.prompt('Optional system guidance (leave blank for default).', '') || '';
  const modelInputValue = window.prompt('Optional model (press Enter to keep default).', '') || '';

  const variant = modeInput.trim().toLowerCase() === 'text' ? 'text' : 'list';
  const config = {
    id: createPaneId('custom'),
    title: titleInput.trim() || 'Custom pane',
    variant,
    systemPrompt: systemInput.trim() || undefined,
    promptTemplate: ensureTranscriptPlaceholder(instructionsInput.trim() || 'Analyze the transcript:
{{transcript}}'),
    response: variant === 'text' ? { type: 'text' } : { type: 'text_list' },
    throttleMs: 1600,
    allowPromptEdit: true,
    templateId: 'custom',
  };

  if (modelInputValue.trim()) {
    config.model = modelInputValue.trim();
  }

  activePaneConfigs.push(config);
  ensurePanePosition(config.id);
  createPanePlaceholder(config);
  syncPaneConfigs();
  refreshPaneHint();
}

function editPane(paneId) {
  const index = activePaneConfigs.findIndex((pane) => pane.id === paneId);
  if (index === -1) {
    return;
  }
  const config = activePaneConfigs[index];
  if (config.allowPromptEdit === false) {
    statusLine.textContent = 'This pane template does not allow editing.';
    return;
  }

  const newTitle = window.prompt('Pane title', config.title || 'AI Pane');
  if (newTitle === null) {
    return;
  }
  const newInstructions = window.prompt(
    'Pane instructions (use {{transcript}} placeholder).',
    config.promptTemplate || ''
  );
  if (newInstructions === null) {
    return;
  }
  const newSystem = window.prompt('System guidance (optional).', config.systemPrompt || '') || '';
  const newModel = window.prompt('Model (optional).', config.model || '') || '';

  config.title = newTitle.trim() || config.title;
  config.promptTemplate = ensureTranscriptPlaceholder(newInstructions.trim() || config.promptTemplate);
  config.systemPrompt = newSystem.trim() || undefined;
  config.model = newModel.trim() || undefined;

  activePaneConfigs[index] = config;
  syncPaneConfigs();
  refreshPaneHint();
}

function removePane(paneId) {
  const index = activePaneConfigs.findIndex((pane) => pane.id === paneId);
  if (index === -1) {
    return;
  }
  activePaneConfigs.splice(index, 1);
  delete paneLayout[paneId];
  savePaneLayout();
  syncPaneConfigs();
  removePaneElement(paneId);
  paneState.delete(paneId);
  refreshPaneHint();
}

function removePaneElement(paneId) {
  const entry = paneElements.get(paneId);
  if (!entry) {
    return;
  }
  entry.element.remove();
  paneElements.delete(paneId);
}

function syncPaneConfigs() {
  saveActivePaneConfigs();
  window.electronAPI.setPaneConfigs(activePaneConfigs);
}

function createPanePlaceholder(config) {
  const placeholderState = {
    id: config.id,
    title: config.title,
    variant: config.variant,
    status: 'waiting',
    items: [],
    text: '',
    allowPromptEdit: config.allowPromptEdit !== false,
  };
  paneState.set(config.id, placeholderState);
  const entry = ensurePaneElement(config.id, placeholderState);
  renderPane(entry, placeholderState);
}

function loadActivePaneConfigs() {
  try {
    const raw = localStorage.getItem(PANE_CONFIG_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => sanitizePaneConfig(entry))
      .filter((entry) => entry !== null);
  } catch (error) {
    console.warn('Failed to load pane configs', error);
    return [];
  }
}

function saveActivePaneConfigs() {
  try {
    const payload = activePaneConfigs.map((config) => ({
      id: config.id,
      title: config.title,
      variant: config.variant,
      systemPrompt: config.systemPrompt,
      promptTemplate: config.promptTemplate,
      response: config.response,
      throttleMs: config.throttleMs,
      model: config.model,
      templateId: config.templateId,
      allowPromptEdit: config.allowPromptEdit !== false,
      maxSegments: config.maxSegments,
      maxOutputTokens: config.maxOutputTokens,
    }));
    localStorage.setItem(PANE_CONFIG_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('Failed to save pane configs', error);
  }
}

function loadPaneLayout() {
  try {
    const raw = localStorage.getItem(PANE_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    return parsed;
  } catch (error) {
    console.warn('Failed to load pane layout', error);
    return {};
  }
}

function savePaneLayout() {
  try {
    localStorage.setItem(PANE_LAYOUT_STORAGE_KEY, JSON.stringify(paneLayout));
  } catch (error) {
    console.warn('Failed to save pane layout', error);
  }
}

function sanitizePaneConfig(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  if (!entry.id) {
    return null;
  }
  return {
    id: String(entry.id),
    title: entry.title ? String(entry.title) : 'AI Pane',
    variant: entry.variant === 'text' ? 'text' : 'list',
    systemPrompt: entry.systemPrompt ? String(entry.systemPrompt) : undefined,
    promptTemplate: ensureTranscriptPlaceholder(
      entry.promptTemplate ? String(entry.promptTemplate) : 'Live transcript:
{{transcript}}'
    ),
    response: typeof entry.response === 'object' ? entry.response : undefined,
    throttleMs: Number.isFinite(entry.throttleMs) ? entry.throttleMs : 1600,
    model: entry.model ? String(entry.model) : undefined,
    templateId: entry.templateId ? String(entry.templateId) : undefined,
    allowPromptEdit: entry.allowPromptEdit !== false,
    maxSegments: Number.isFinite(entry.maxSegments) ? entry.maxSegments : undefined,
    maxOutputTokens: Number.isFinite(entry.maxOutputTokens) ? entry.maxOutputTokens : undefined,
  };
}

function createPaneConfigFromTemplate(template) {
  const id = createPaneId(template.templateId || 'pane');
  return {
    id,
    title: template.title || 'AI Pane',
    variant: template.variant === 'text' ? 'text' : 'list',
    systemPrompt: template.systemPrompt || undefined,
    promptTemplate: ensureTranscriptPlaceholder(template.promptTemplate || 'Live transcript:
{{transcript}}'),
    response: template.response,
    throttleMs: Number.isFinite(template.throttleMs) ? template.throttleMs : 1600,
    model: template.model || undefined,
    templateId: template.templateId,
    allowPromptEdit: template.allowPromptEdit !== false,
    maxSegments: Number.isFinite(template.maxSegments) ? template.maxSegments : undefined,
    maxOutputTokens: Number.isFinite(template.maxOutputTokens) ? template.maxOutputTokens : undefined,
  };
}

function ensureTranscriptPlaceholder(promptTemplate) {
  if (!promptTemplate || typeof promptTemplate !== 'string') {
    return 'Live transcript:
{{transcript}}';
  }
  if (promptTemplate.includes('{{transcript}}')) {
    return promptTemplate;
  }
  return `${promptTemplate}

Transcript:
{{transcript}}`;
}

function createPaneId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

function getPaneConfig(paneId) {
  return activePaneConfigs.find((pane) => pane.id === paneId) || null;
}

function refreshPaneHint() {
  if (!paneTemplates.length) {
    paneHint.textContent = 'Loading pane templates…';
    return;
  }
  if (!activePaneConfigs.length) {
    paneHint.textContent = llmAvailable
      ? 'Add a pane to start generating insights.'
      : 'Add an OPENAI_API_KEY to enable AI panes.';
    return;
  }
  if (!llmAvailable) {
    paneHint.textContent = 'Configure OPENAI_API_KEY to let panes process the transcript.';
    return;
  }
  paneHint.textContent = capturing
    ? 'Streaming transcript into your panes.'
    : 'Start capture to stream updates into panes.';
}

