# Realtime Meeting Assistant Pane Architecture

## Vision

Deliver a Mac-first realtime meeting copilot where transcription is the anchor pane and users can fan out new floating panes that reason over the live conversation. Each pane is a focused AI worker with its own prompt, memory window, and output format, giving the facilitator a cockpit-like workspace for capturing notes, driving follow-ups, and exploring insights while the meeting is still in flight.

## Experience Pillars

1. **Transcript as the source of truth**
   - Always-on "Transcript" pane shows a fully scrolling live feed with turn detection and speaker labeling.
   - Users can pin/highlight segments. Highlights become structured events other panes can consume.

2. **Composable floating panes**
   - Users spawn panes from a tray of templates (Notes, Follow-ups, Decisions, Risks, Timer, Whiteboard, Custom prompt).
   - Panes float above the canvas with magnetic snapping, resizable edges, and multi-monitor awareness on macOS Mission Control.
   - Pane layout is persisted per meeting and can be saved/loaded as "workspaces" (e.g., Standup, Client Call).

3. **Realtime intelligence**
   - Every pane subscribes to the streaming transcript bus, runs its own incremental reasoning loop, and renders updates in near realtime.
   - Panes can emit structured events (e.g., new action item) that feed back to other panes or external integrations.

4. **Keyboard-first control**
   - Global hotkeys (macOS `⌥` + `Space`) to summon the pane palette, cycle panes, and drop highlights.
   - Command palette for spawning panes, toggling prompts, exporting notes.

5. **Assistive automation**
   - Built-in automations chain panes: e.g., when the Follow-ups pane logs an item, the Calendar pane suggests scheduling, and the Email Draft pane prepares outreach.

## Pane Types & Default Prompts

| Pane | Purpose | Prompt Characteristics |
|------|---------|------------------------|
| Transcript (mandatory) | Show live transcript with speaker diarization, timestamps, highlight markers. | No prompt; raw stream with inline analytics (confidence, filler word detection). |
| Note Taker | Rolling bullet summary aligned to timestamps, grouping by topic. | Prompt focuses on succinct bullets, highlight decisions, questions, blockers. |
| Follow-up Questions | Capture questions raised or implied during the meeting. | Prompt scans for interrogative phrases and context gaps; suggests clarifying questions. |
| Action Items | Extract tasks with owner, due date hints, dependencies. | Prompt enforces schema `{summary, owner?, due?, priority}`; asks follow-up if data missing. |
| Decisions | Track agreed outcomes, rationale, dissent. | Prompt flags decision language, ties back to transcript snippet IDs. |
| Sentiment Pulse | Chart tone shifts across speakers in real time. | Prompt quantifies sentiment/emotion per minute, surfaces tension or excitement. |
| Knowledge Lookup | Surfaces relevant documents or previous meeting notes via embeddings. | Prompt uses conversation context + retrieval to recommend artifacts. |
| Custom Pane | User-defined prompt with optional schema and visualization template. | Advanced settings: temperature, model, context window size. |

## Interaction Model

- **Pane Palette:** Accessible via toolbar button or shortcut; shows grid of templates and recently used custom prompts.
- **Pane Config Drawer:** Each pane has a settings drawer for prompt editing, memory controls (buffer size, summary frequency), export toggles.
- **Data Pins:** Drag text from transcript into a pane to anchor reasoning. Panes treat pins as high-priority context.
- **Insight Feed:** Unified activity stream that logs events emitted by panes (new task, follow-up, decision) for quick review/export.

## System Architecture

### High-Level Flow

```
Audio Input → Streaming Engine (Rust) → Transcript Event Bus (Electron preload) → Pane Workers (Renderer threads) → UI Panes
```

1. **Rust Streaming Engine** (`realtime_cli` embedded via Neon or IPC): captures audio, performs on-device ASR (Whisper/Parakeet), emits JSON chunks with tokens, timestamps, and speaker labels.
2. **Transcript Event Bus** (Electron preload using `contextBridge`): normalizes ASR output, maintains rolling buffer (configurable 5–10 minutes), publishes events via RxJS observables to renderer panes.
3. **Pane Workers**
   - Each pane instantiates a lightweight worker (Web Worker or node `worker_threads`) responsible for prompt orchestration.
   - Worker receives transcript delta events, maintains a local context window, triggers incremental LLM calls (OpenAI Realtime API or `responses` streaming) using function/tool outputs where needed.
   - For on-device summarization, leverage Whisper's token-level confidence to gate updates.
4. **State Store**
   - Use Zustand or Recoil for pane layout and shared state. Persist to disk via Electron Store (`~/Library/Application Support/TranscribeRS/state.json`).
   - Meeting timeline stored in SQLite (via `better-sqlite3`) enabling cross-pane queries.
5. **Rendering Layer**
   - React + Tailwind (or existing CSS) to render panes with GPU-accelerated transforms for smooth dragging.
   - Use `react-rnd` for resize/drag, enhanced with macOS-style rubber-banding.

### Streaming Context Management

- **Incremental Summaries:** Pane worker keeps a sliding window (e.g., last 90 seconds) plus distilled memory of previous segments using auto-summarization triggered by token thresholds.
- **Backpressure:** If multiple panes request LLM updates simultaneously, queue them via priority scheduler; transcript pane always real-time.
- **Model Selection:** Default to `gpt-4o-mini-transcribe` for speed; allow user to pin panes to faster or smarter models.
- **Failover:** If API latency spikes, panes fall back to local heuristics (e.g., regex for action items) until connection recovers.

## Advanced Capabilities

### Meeting Timeline & Replay

- Store transcript with pane-emitted events; allow scrubber to replay conversation and re-run panes retroactively.
- Generate time-aligned exports (Markdown, Notion, Apple Notes) preserving pane outputs.

### Collaboration

- AirDrop-style share: broadcast pane layouts to nearby Macs via `NSSharingService`.
- Shared sessions: host invites others, panes sync via WebRTC data channel, enabling collaborative note editing.

### Automations & Integrations

- **Calendar sync:** Action Items with due dates can create Calendar reminders via Apple EventKit.
- **Email drafts:** When Follow-up Questions pane flags open issues, auto-draft recap email in dedicated pane.
- **Task managers:** Push tasks to Things, OmniFocus, Asana using pane-specific connectors.

## Mac-Specific Optimizations

- Utilize `NSWindow` APIs for native-feel floating panes, including vibrancy/blur effects and snapping to screen edges.
- Support Mac trackpad gestures for pane management (three-finger swipe to switch workspaces, pinch to cluster panes).
- Enable system-wide shortcut registration through `electron-traywindow` for quick capture outside the main window.
- Leverage macOS dictation permissions prompts and store microphone consent states in the Keychain.

## Telemetry & Reliability

- Local analytics measure pane latency, LLM call volume, and transcription accuracy (confidence scores) to tune prompts.
- Offline cache ensures panes resume gracefully after temporary disconnects.
- Health dashboard pane monitors CPU/GPU usage and ASR backlog so users can react if performance dips during long meetings.

## Implementation Roadmap

1. **Foundations (Weeks 1–3)**
   - Refactor transcript handling into shared event bus.
   - Build pane manager with add/remove/reorder/persist capabilities.
   - Implement Transcript + Note Taker panes using worker model.

2. **Pane Expansion (Weeks 4–6)**
   - Add Follow-up Questions, Action Items, Decisions panes with schema outputs.
   - Integrate highlight pins and insight feed.
   - Introduce custom pane builder UI.

3. **Polish & Automations (Weeks 7–9)**
   - Keyboard shortcuts, workspace presets, export pipelines.
   - Calendar/email/task integrations for emitted events.
   - Performance tuning on Apple Silicon (Metal profiling, concurrency budgets).

4. **Collaboration & Advanced Features (Weeks 10+)**
   - Shared sessions, timeline replay, advanced sentiment/knowledge panes.
   - Deeper macOS-native window chrome and multi-display support.

## Success Metrics

- < 2s median latency from spoken word to pane update.
- 90% of meetings exported with complete action items and decisions captured.
- > 70% weekly active users leverage more than three panes per meeting.
- Positive NPS feedback emphasizing reduced post-meeting follow-up time.

## Open Questions

- How to price pane usage if different LLM tiers incur varying costs?
- Should panes be allowed to call each other (e.g., action item triggers follow-up) or only communicate via events?
- What governance controls are needed for sensitive meeting data when panes hit external APIs?

