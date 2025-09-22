const NOTE_TAKER_PROMPT = `Live transcript so far:\n{{transcript}}\n\nSummarize the conversation into concise, chronological bullets. Each bullet should capture a single idea and mention owners, blockers, decisions, or metrics when present. Return JSON with a \\"bullets\\" array ordered chronologically.`;

const FOLLOW_UP_PROMPT = `Here is the live transcript:\n{{transcript}}\n\nIdentify clarifying or follow-up questions the team should ask. Prioritize questions that unblock decisions or surface missing context. Return JSON with a \\"questions\\" array.`;

const ACTION_ITEMS_PROMPT = `Transcript excerpt:\n{{transcript}}\n\nExtract clear action items. Each task should have a short summary plus optional owner, due date, and priority. When information is missing but strongly implied, include it with a trailing "(?)". Return JSON with an \\"items\\" array of objects { summary, owner?, due?, priority? }.`;

const DECISIONS_PROMPT = `Meeting transcript:\n{{transcript}}\n\nCapture decisions or agreements that were reached. Include the rationale or supporting context when it is available. Return JSON with a \\"decisions\\" array of objects { decision, rationale?, next_step? }.`;

const DEFAULT_PANE_TEMPLATES = [
  {
    templateId: 'note-taker',
    title: 'Note Taker',
    description: 'Chronological meeting notes generated in real time.',
    variant: 'list',
    systemPrompt:
      'You are a meticulous real-time meeting note taker. Produce chronological, high-signal bullets that help someone recall the conversation minutes later. Keep language short and specific.',
    promptTemplate: NOTE_TAKER_PROMPT,
    response: {
      type: 'json_list',
      schemaName: 'chronological_notes',
      field: 'bullets',
      fallbackFields: ['notes'],
    },
    throttleMs: 1400,
    maxSegments: 36,
    maxOutputTokens: 400,
    allowPromptEdit: true,
  },
  {
    templateId: 'follow-ups',
    title: 'Follow-up Questions',
    description: 'Suggest clarifying questions to keep the meeting moving.',
    variant: 'list',
    systemPrompt:
      'You monitor live meetings and surface clarifying questions that should be asked before moving on. Focus on actionable gaps.',
    promptTemplate: FOLLOW_UP_PROMPT,
    response: {
      type: 'json_list',
      schemaName: 'follow_up_questions',
      field: 'questions',
    },
    throttleMs: 1800,
    maxSegments: 32,
    maxOutputTokens: 320,
    allowPromptEdit: true,
  },
  {
    templateId: 'action-items',
    title: 'Action Items',
    description: 'Track commitments with owners and due dates.',
    variant: 'list',
    systemPrompt:
      'You listen to meetings and capture concrete follow-up tasks. When the team agrees to do something, you record it as an action item with owner and due date when possible.',
    promptTemplate: ACTION_ITEMS_PROMPT,
    response: {
      type: 'json_objects',
      schemaName: 'action_items',
      field: 'items',
      properties: {
        summary: { type: 'string', description: 'Concise description of the task.' },
        owner: { type: 'string', description: 'Person responsible for the task.', optional: true },
        due: { type: 'string', description: 'Due date or time expectation.', optional: true },
        priority: { type: 'string', description: 'Priority or urgency indicator.', optional: true },
      },
      requiredFields: ['summary'],
      displayFields: ['owner', 'due', 'priority'],
    },
    throttleMs: 2200,
    maxSegments: 40,
    maxOutputTokens: 420,
    allowPromptEdit: true,
  },
  {
    templateId: 'decisions',
    title: 'Decisions & Outcomes',
    description: 'Log the choices that were made and why.',
    variant: 'list',
    systemPrompt:
      'You capture decisions in real time so the team remembers what they agreed to. Highlight supporting rationale and resulting next steps.',
    promptTemplate: DECISIONS_PROMPT,
    response: {
      type: 'json_objects',
      schemaName: 'decision_log',
      field: 'decisions',
      properties: {
        decision: { type: 'string', description: 'Statement of the decision that was made.' },
        rationale: { type: 'string', description: 'Brief reason or evidence cited.', optional: true },
        next_step: { type: 'string', description: 'Follow-up step triggered by the decision.', optional: true },
      },
      requiredFields: ['decision'],
      displayFields: ['rationale', 'next_step'],
    },
    throttleMs: 2200,
    maxSegments: 40,
    maxOutputTokens: 420,
    allowPromptEdit: true,
  },
];

module.exports = {
  DEFAULT_PANE_TEMPLATES,
};
