const { extractResponseText, formatTimestamp } = require('./session-utils');

const DEFAULT_MODEL = 'gpt-5-nano';
const MIN_THROTTLE_MS = 600;
const MAX_TRANSCRIPT_CHARS = 6000;
const DEFAULT_SYSTEM_PROMPT =
  'You are a realtime meeting copilot pane. You listen to the conversation, stay focused on your specialty, and respond with concise updates that are safe to render live in front of participants.';

function clampNumber(value, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }
  return value;
}

function safeString(value, fallback = '') {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value);
}

function sanitizePromptTemplate(template) {
  const trimmed = safeString(template).trim();
  if (!trimmed) {
    return 'Live transcript so far:\n{{transcript}}\n\nSummarize the most recent moments.';
  }
  return trimmed;
}

function ensureTranscriptPlaceholder(template) {
  if (template.includes('{{transcript}}')) {
    return template;
  }
  return `${template}\n\nTranscript:\n{{transcript}}`;
}

function sliceTranscriptSegments(segments, { maxSegments }) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return [];
  }
  const limit = Math.max(1, Math.min(segments.length, maxSegments || 40));
  return segments.slice(-limit);
}

function buildSegmentLines(segments) {
  return segments
    .map((segment) => {
      const text = safeString(segment?.text).trim();
      if (!text) {
        return null;
      }
      const timestamp = formatTimestamp(segment?.start, segment?.end);
      return `${timestamp} ${text}`.trim();
    })
    .filter(Boolean);
}

function trimTranscriptText(lines) {
  if (!Array.isArray(lines) || !lines.length) {
    return '';
  }
  let joined = lines.join('\n');
  if (joined.length <= MAX_TRANSCRIPT_CHARS) {
    return joined;
  }
  const copy = [...lines];
  while (joined.length > MAX_TRANSCRIPT_CHARS && copy.length > 1) {
    copy.shift();
    joined = copy.join('\n');
  }
  return joined;
}

function buildJsonListSchema(responseConfig) {
  const field = responseConfig.field || 'items';
  return {
    type: 'json_schema',
    json_schema: {
      name: responseConfig.schemaName || 'pane_output',
      schema: {
        type: 'object',
        properties: {
          [field]: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: [field],
      },
    },
  };
}

function buildJsonObjectSchema(responseConfig) {
  const field = responseConfig.field || 'items';
  const propertyEntries = Object.entries(responseConfig.properties || {}).reduce(
    (acc, [key, value]) => {
      acc[key] = {
        type: value?.type === 'string' ? 'string' : 'string',
        description: safeString(value?.description).trim() || undefined,
      };
      return acc;
    },
    {}
  );

  const required = Array.isArray(responseConfig.requiredFields)
    ? responseConfig.requiredFields.filter((entry) => typeof entry === 'string' && entry.trim())
    : [];

  return {
    type: 'json_schema',
    json_schema: {
      name: responseConfig.schemaName || 'pane_output',
      schema: {
        type: 'object',
        properties: {
          [field]: {
            type: 'array',
            items: {
              type: 'object',
              properties: propertyEntries,
              required,
            },
          },
        },
        required: [field],
      },
    },
  };
}

class PaneManager {
  constructor({ openaiClient, onUpdate, onRemove } = {}) {
    this.openaiClient = openaiClient || null;
    this.onUpdate = typeof onUpdate === 'function' ? onUpdate : null;
    this.onRemove = typeof onRemove === 'function' ? onRemove : null;
    this.panes = new Map();
    this.transcript = { text: '', segments: [] };
  }

  setOpenAIClient(client) {
    this.openaiClient = client || null;
    for (const pane of this.panes.values()) {
      if (!this.openaiClient) {
        pane.status = 'llm-unavailable';
      } else if (!this.transcript.text?.trim()) {
        pane.status = 'waiting';
      }
      this.emitUpdate(pane);
    }
  }

  setPanes(configs) {
    const normalizedConfigs = Array.isArray(configs) ? configs : [];
    const nextIds = new Set();

    for (const config of normalizedConfigs) {
      const normalized = this.normalizeConfig(config);
      if (!normalized) {
        // eslint-disable-next-line no-continue
        continue;
      }
      nextIds.add(normalized.id);
      this.upsertPane(normalized);
    }

    for (const existingId of this.panes.keys()) {
      if (!nextIds.has(existingId)) {
        this.removePane(existingId);
      }
    }
  }

  setTranscript(transcript) {
    const text = safeString(transcript?.text);
    const segments = Array.isArray(transcript?.segments) ? transcript.segments : [];
    this.transcript = { text, segments };

    for (const pane of this.panes.values()) {
      this.schedulePane(pane);
    }
  }

  resetOutputs() {
    for (const pane of this.panes.values()) {
      pane.items = [];
      pane.text = '';
      pane.raw = '';
      pane.structured = [];
      pane.error = null;
      pane.lastRunAt = 0;
      if (!this.openaiClient) {
        pane.status = 'llm-unavailable';
      } else {
        pane.status = 'waiting';
      }
      this.clearTimer(pane);
      this.emitUpdate(pane);
    }
  }

  removePane(id) {
    const pane = this.panes.get(id);
    if (!pane) {
      return;
    }
    this.clearTimer(pane);
    this.panes.delete(id);
    if (this.onRemove) {
      this.onRemove(id);
    }
  }

  reset() {
    for (const pane of this.panes.values()) {
      this.clearTimer(pane);
    }
    this.panes.clear();
  }

  forceRefresh(paneId) {
    const pane = this.panes.get(paneId);
    if (!pane) {
      return;
    }
    this.clearTimer(pane);
    pane.pending = false;
    this.runPane(pane, { immediate: true });
  }

  normalizeConfig(config) {
    if (!config || typeof config !== 'object') {
      return null;
    }

    const id = safeString(config.id).trim();
    if (!id) {
      return null;
    }

    const title = safeString(config.title, 'AI Pane').trim() || 'AI Pane';
    const variant = config.variant === 'text' ? 'text' : 'list';
    const systemPrompt = safeString(config.systemPrompt).trim() || DEFAULT_SYSTEM_PROMPT;
    const promptTemplate = ensureTranscriptPlaceholder(sanitizePromptTemplate(config.promptTemplate));
    const throttleMsRaw = clampNumber(config.throttleMs, NaN);
    const throttleMs = Number.isFinite(throttleMsRaw)
      ? Math.max(MIN_THROTTLE_MS, Math.floor(throttleMsRaw))
      : 1500;
    const model = safeString(config.model, DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const maxSegments = Number.isFinite(config.maxSegments) ? Math.max(6, Math.floor(config.maxSegments)) : 36;
    const maxOutputTokens = Number.isFinite(config.maxOutputTokens)
      ? Math.max(100, Math.floor(config.maxOutputTokens))
      : 400;

    const response = this.normalizeResponseConfig(config.response, variant);

    return {
      id,
      title,
      variant,
      systemPrompt,
      promptTemplate,
      throttleMs,
      model,
      maxSegments,
      maxOutputTokens,
      response,
      templateId: config.templateId ? safeString(config.templateId).trim() : undefined,
      allowPromptEdit: config.allowPromptEdit !== false,
    };
  }

  normalizeResponseConfig(responseConfig, variant) {
    const safeConfig = responseConfig && typeof responseConfig === 'object' ? responseConfig : {};

    if (safeConfig.type === 'json_objects') {
      return {
        type: 'json_objects',
        field: safeString(safeConfig.field, 'items'),
        schemaName: safeString(safeConfig.schemaName, 'pane_output'),
        properties: safeConfig.properties && typeof safeConfig.properties === 'object' ? safeConfig.properties : {},
        requiredFields: Array.isArray(safeConfig.requiredFields)
          ? safeConfig.requiredFields.filter((entry) => typeof entry === 'string' && entry.trim())
          : [],
        displayFields: Array.isArray(safeConfig.displayFields)
          ? safeConfig.displayFields.filter((entry) => typeof entry === 'string' && entry.trim())
          : undefined,
        fallbackFields: Array.isArray(safeConfig.fallbackFields)
          ? safeConfig.fallbackFields.filter((entry) => typeof entry === 'string' && entry.trim())
          : undefined,
      };
    }

    if (safeConfig.type === 'json_list') {
      return {
        type: 'json_list',
        field: safeString(safeConfig.field, 'items'),
        schemaName: safeString(safeConfig.schemaName, 'pane_output'),
        fallbackFields: Array.isArray(safeConfig.fallbackFields)
          ? safeConfig.fallbackFields.filter((entry) => typeof entry === 'string' && entry.trim())
          : undefined,
      };
    }

    if (safeConfig.type === 'text_list') {
      return { type: 'text_list' };
    }

    if (variant === 'text') {
      return { type: 'text' };
    }

    return { type: 'text_list' };
  }

  upsertPane(config) {
    let pane = this.panes.get(config.id);
    if (!pane) {
      pane = {
        id: config.id,
        config,
        status: this.openaiClient ? 'waiting' : 'llm-unavailable',
        items: [],
        text: '',
        raw: '',
        structured: [],
        timer: null,
        pending: false,
        running: false,
        lastRunAt: 0,
        error: null,
      };
      this.panes.set(config.id, pane);
    } else {
      this.clearTimer(pane);
      pane.config = config;
      pane.error = null;
      if (!this.openaiClient) {
        pane.status = 'llm-unavailable';
      }
    }

    this.emitUpdate(pane);
    this.schedulePane(pane, { immediate: true });
  }

  clearTimer(pane) {
    if (pane.timer) {
      clearTimeout(pane.timer);
      pane.timer = null;
    }
  }

  schedulePane(pane, { immediate = false } = {}) {
    if (!pane || pane.running) {
      if (pane) {
        pane.pending = true;
      }
      return;
    }

    if (!this.openaiClient) {
      pane.status = 'llm-unavailable';
      this.emitUpdate(pane);
      return;
    }

    if (!this.transcript.text.trim()) {
      pane.status = 'waiting';
      this.emitUpdate(pane);
      return;
    }

    const now = Date.now();
    const elapsed = now - (pane.lastRunAt || 0);
    const waitTime = Math.max(0, pane.config.throttleMs - elapsed);

    if (immediate || waitTime === 0) {
      this.runPane(pane);
      return;
    }

    if (pane.timer) {
      return;
    }

    pane.timer = setTimeout(() => {
      pane.timer = null;
      this.runPane(pane);
    }, waitTime);
  }

  async runPane(pane) {
    if (!pane || pane.running) {
      return;
    }

    if (!this.openaiClient) {
      pane.status = 'llm-unavailable';
      this.emitUpdate(pane);
      return;
    }

    const transcriptExcerpt = this.buildTranscriptExcerpt(pane.config);
    if (!transcriptExcerpt.trim()) {
      pane.status = 'waiting';
      this.emitUpdate(pane);
      return;
    }

    pane.running = true;
    pane.pending = false;
    pane.status = 'generating';
    pane.error = null;
    this.emitUpdate(pane);

    try {
      const messages = this.buildMessages(pane.config, transcriptExcerpt);
      const request = {
        model: pane.config.model || DEFAULT_MODEL,
        input: messages,
        max_output_tokens: pane.config.maxOutputTokens,
      };

      const responseFormat = this.buildResponseFormat(pane.config.response);
      if (responseFormat) {
        request.response_format = responseFormat;
      }

      const response = await this.openaiClient.responses.create(request);
      const parsed = this.parseResponse(response, pane.config.response);

      pane.items = Array.isArray(parsed.items) ? parsed.items : [];
      pane.text = safeString(parsed.text).trim();
      pane.raw = safeString(parsed.raw).trim();
      pane.structured = Array.isArray(parsed.structured) ? parsed.structured : [];
      pane.status = 'ready';
      pane.lastRunAt = Date.now();
    } catch (error) {
      pane.error = safeString(error?.message, 'Unknown error');
      pane.status = 'error';
    } finally {
      pane.running = false;
      this.emitUpdate(pane);
      if (pane.pending) {
        pane.pending = false;
        this.schedulePane(pane);
      }
    }
  }

  buildMessages(config, transcriptExcerpt) {
    const promptWithTranscript = config.promptTemplate.replace('{{transcript}}', transcriptExcerpt);
    return [
      { role: 'system', content: config.systemPrompt || DEFAULT_SYSTEM_PROMPT },
      { role: 'user', content: promptWithTranscript },
    ];
  }

  buildTranscriptExcerpt(config) {
    const segments = sliceTranscriptSegments(this.transcript.segments, {
      maxSegments: config.maxSegments,
    });
    if (!segments.length) {
      return safeString(this.transcript.text);
    }
    const lines = buildSegmentLines(segments);
    return trimTranscriptText(lines);
  }

  buildResponseFormat(responseConfig) {
    if (!responseConfig || typeof responseConfig !== 'object') {
      return null;
    }
    if (responseConfig.type === 'json_list') {
      return buildJsonListSchema(responseConfig);
    }
    if (responseConfig.type === 'json_objects') {
      return buildJsonObjectSchema(responseConfig);
    }
    return null;
  }

  parseResponse(response, responseConfig) {
    const rawOutput = extractResponseText(response);

    if (!responseConfig || typeof responseConfig !== 'object') {
      return { text: rawOutput, raw: rawOutput };
    }

    if (responseConfig.type === 'json_list') {
      const items = this.parseListOutput(rawOutput, {
        primary: responseConfig.field,
        fallback: responseConfig.fallbackFields,
      });
      return { items, raw: rawOutput };
    }

    if (responseConfig.type === 'json_objects') {
      const parsed = this.parseObjectListOutput(rawOutput, responseConfig);
      return parsed;
    }

    if (responseConfig.type === 'text_list') {
      const items = this.parsePlaintextList(rawOutput);
      return { items, raw: rawOutput };
    }

    return { text: rawOutput, raw: rawOutput };
  }

  parsePlaintextList(rawOutput) {
    return safeString(rawOutput)
      .split(/\n+/)
      .map((line) => line.replace(/^[-•\s]+/, '').trim())
      .filter(Boolean);
  }

  parseListOutput(rawOutput, options = {}) {
    const text = safeString(rawOutput).trim();
    if (!text) {
      return [];
    }

    try {
      const parsed = JSON.parse(text);
      const keys = [options.primary, ...(options.fallback || [])].filter(Boolean);
      for (const key of keys) {
        if (Array.isArray(parsed?.[key])) {
          return parsed[key].map((entry) => safeString(entry).trim()).filter(Boolean);
        }
      }
    } catch (error) {
      // fall back to plaintext parsing
    }

    return this.parsePlaintextList(text);
  }

  parseObjectListOutput(rawOutput, responseConfig) {
    const text = safeString(rawOutput).trim();
    if (!text) {
      return { items: [], structured: [], raw: rawOutput };
    }

    let structured = [];
    const field = responseConfig.field || 'items';

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed?.[field])) {
        structured = parsed[field]
          .map((entry) => {
            if (!entry || typeof entry !== 'object') {
              return null;
            }
            const normalized = {};
            for (const [key, value] of Object.entries(responseConfig.properties || {})) {
              const val = entry[key];
              if (val === undefined || val === null) {
                // eslint-disable-next-line no-continue
                continue;
              }
              normalized[key] = safeString(val).trim();
            }
            for (const key of Object.keys(entry)) {
              if (!(key in normalized) && typeof entry[key] === 'string') {
                normalized[key] = safeString(entry[key]).trim();
              }
            }
            return normalized;
          })
          .filter(Boolean);
      }
    } catch (error) {
      structured = [];
    }

    if (!structured.length) {
      const fallbackItems = this.parsePlaintextList(text);
      return { items: fallbackItems, structured: [], raw: rawOutput };
    }

    const displayFields = Array.isArray(responseConfig.displayFields)
      ? responseConfig.displayFields
      : Object.keys(responseConfig.properties || {});

    const items = structured.map((entry) => {
      const primaryKey = responseConfig.requiredFields?.[0] || displayFields?.[0] || 'summary';
      const primary = safeString(entry[primaryKey]).trim();
      const details = [];
      for (const fieldKey of displayFields) {
        if (fieldKey === primaryKey) {
          // eslint-disable-next-line no-continue
          continue;
        }
        const value = safeString(entry[fieldKey]).trim();
        if (value) {
          const label = fieldKey.replace(/_/g, ' ');
          details.push(`${label}: ${value}`);
        }
      }
      if (!primary && details.length) {
        return details.join(' • ');
      }
      if (!primary) {
        return '';
      }
      if (!details.length) {
        return primary;
      }
      return `${primary} (${details.join(' • ')})`;
    });

    return {
      items: items.filter(Boolean),
      structured,
      raw: rawOutput,
    };
  }

  emitUpdate(pane) {
    if (!this.onUpdate) {
      return;
    }
    this.onUpdate({
      id: pane.id,
      title: pane.config.title,
      variant: pane.config.variant,
      status: pane.status,
      items: Array.isArray(pane.items) ? pane.items : [],
      text: safeString(pane.text),
      error: pane.error || null,
      raw: safeString(pane.raw),
      structured: Array.isArray(pane.structured) ? pane.structured : [],
      lastUpdated: pane.lastRunAt || null,
      templateId: pane.config.templateId,
      allowPromptEdit: pane.config.allowPromptEdit,
      model: pane.config.model,
    });
  }
}

module.exports = {
  PaneManager,
};
