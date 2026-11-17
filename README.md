# codai-live-agent

[![npm version](https://img.shields.io/npm/v/codai-live-agent.svg)](https://www.npmjs.com/package/codai-live-agent)
[![license](https://img.shields.io/npm/l/codai-live-agent.svg)](./LICENSE)

A live-stream **AI co-host runtime** for the [codai](https://codai.ro) gateway. Feed it chat,
gift, join, like, follow and share events from any platform; it moderates, remembers viewers,
scores and triages every event, drafts short spoken replies (streaming, one sentence at a time)
and hands them to your text-to-speech — never over itself, never faster than your rate limit,
and, in `approve` mode, never before you approve.

Extracted from [TikSee](https://codai.ro), where it runs the co-host on TikTok LIVE.

- **Platform-agnostic** — one Zod-validated `LiveEvent` shape; write a 20-line adapter per platform.
- **Pluggable** — memory store, moderation, LLM backend and speech output are interfaces.
- **One runtime dependency** (`zod`); uses the platform `fetch`. Node 20+ and edge runtimes.
- Every building block is exported on its own: use the whole `LiveAgent` or just the scorer.

```bash
npm install codai-live-agent
# or
pnpm add codai-live-agent
```

> You need a codai API key. Get one at **[codai.ro](https://codai.ro)**. The key is passed in by
> your code; the package never reads it from the environment and never logs it.

## Quickstart

```ts
import { LiveAgent } from 'codai-live-agent';

const agent = new LiveAgent(
  {
    llm: { model: 'codai-fast' }, // any codai model alias; baseUrl defaults to https://ai.codai.ro/v1
    persona: {
      name: 'Codai',
      platform: 'Twitch',
      language: 'en',
      aboutStreamer: 'Speedruns Celeste.',
    },
    replyMode: 'approve', // or 'auto'
    repliesPerMinute: 4,
    moderation: { blockedWords: ['scam', '*crypto*'], alertKeywords: ['help'] },
  },
  {
    apiKey: myKeyFromASecretStore, // string or () => Promise<string | null>
    speak: async (sentence) => tts.say(sentence), // resolve when the audio finished
    onQueue: (entries) => ui.renderQueue(entries),
    onSuggestion: (s) => ui.toast(s.text),
    onError: (error, where) => log.warn({ where, error }),
  },
);

agent.startSession('stream-2026-10-05');

// From your platform adapter:
await agent.handle({
  id: msg.id,
  kind: 'chat',
  at: Date.now(),
  user: { id: msg.userId, name: msg.displayName, isSubscriber: msg.sub },
  text: msg.text,
});

// Streamer controls (from your UI):
agent.approve(entryId); // speak the draft
agent.approve(entryId, 'My own words.'); // edit + approve
agent.edit(entryId, 'Fixed text.'); // edit, keep waiting
agent.skip(entryId); // drop it (an unspoken AI draft refunds its token)
agent.setMode('auto'); // speak drafts as soon as they are ready
agent.say('Back in five minutes!'); // manual announcement
agent.pause(); // mute; agent.resume()

// Optional: streamer speech-to-text gives replies context
agent.onTranscript('we are on the last level now');

await agent.dispose();
```

## AI disclosure (EU AI Act art. 50)

Viewers must be able to tell the co-host is an AI. The persona carries an `aiLabel`
(default `" (AI)"`, never empty): append it to the co-host's display name wherever you show it,
or show `disclosureLine(persona)` in your overlay or chat (`Codai (AI) — AI co-host`;
`co-gazdă AI` when `persona.language` is `'ro'`). The system prompt also tells the model it is an
AI, that it must never claim or imply to be human, and that it says it is the streamer's AI
co-host whenever asked or when a viewer seems to think it is human.

```ts
import { PersonaSchema, disclosureLine } from 'codai-live-agent';

const persona = PersonaSchema.parse({ name: 'Codai', language: 'en' });
overlay.setTitle(`${persona.name}${persona.aiLabel}`); // "Codai (AI)"
overlay.setSubtitle(disclosureLine(persona)); // "Codai (AI) — AI co-host"
```

## Events

```ts
type LiveEvent = {
  id: string;
  kind: 'chat' | 'gift' | 'join' | 'like' | 'follow' | 'share';
  at: number; // epoch ms
  user: { id: string; name: string; avatarUrl?; isModerator?; isSubscriber?; isFollower? };
  text: string; // chat text, '' otherwise
  gift?: { name: string; count: number; value: number }; // value of ONE gift, platform units
  replay?: boolean; // replays never write memory
};
```

`LiveEventSchema` / `parseLiveEvent` validate untrusted input; `agent.handle` validates too.

## Pipeline

```
event ─► moderation hook ─► memory.observe ─► scoreEvent ─► triage
                                                     ├─ read     (template, no LLM)
                                                     ├─ thanks   (template, no LLM)
                                                     ├─ greeting (template, no LLM)
                                                     └─ ai ─► ReplyQueue ─► TokenBucket ─► draftReply (stream)
                                                                   └─► approve / edit / skip / auto ─► speak()
```

## Building blocks

| Export                                              | What it does                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `scoreEvent`, `decayed`, `DuplicateTracker`         | Deterministic priority: questions, mentions, gifts (log value), first-time, roles; decay. |
| `TokenBucket`                                       | Replies per minute with burst and refund.                                                 |
| `ReplyQueue`                                        | Ranked, capped, expiring queue; `approve` / `edit` / `skip` / `setMode('auto')`.          |
| `triage`                                            | Pure routing decision with reasons (`ai:low-score`, `thanks:dedupe`...).                  |
| `CodaiLlmClient`, `draftReply`                      | Streaming responder on `/v1/chat/completions`, sentence callbacks, sentence cap.          |
| `WordListModerator`, `ModerationHook`               | Word / user / spam moderation (leetspeak-folded), alert keywords, output check.           |
| `MemoryStore`, `InMemoryStore`, `createMemoryHooks` | Viewer profiles, visits, gift totals, facts. Store failures fail open.                    |
| `FactCollector`                                     | Batched extraction of durable self-statements ("lives in Cluj") into memory.              |
| `Coach`                                             | Teleprompter: unanswered question, thank gifts, quiet chat, activity spike.               |
| `thanksLine`, `greetingLine`, `readAloudLine`       | Template lines in English or Romanian.                                                    |

### Custom memory store

```ts
import type { MemoryStore } from 'codai-live-agent';

const store: MemoryStore = {
  getViewer: (id) => db.viewer.find(id),
  putViewer: (p) => db.viewer.upsert(p),
  getFacts: (id) => db.facts.list(id),
  addFacts: (id, facts, at) => db.facts.add(id, facts, at),
};
new LiveAgent(config, { apiKey, store });
```

### Bring your own LLM

Implement `LlmClient` (`complete` + `stream`) and pass it as `deps.llm` instead of `apiKey`.

## Safety defaults

- Moderation hook errors **fail closed** (the event is dropped); memory errors **fail open**.
- The system prompt is stable per persona (gateway prompt cache hits) and forbids politics,
  medical/financial/legal advice, impersonating a human and promising prizes.
- Drafted sentences pass the output moderation hook before they can be spoken.

## License

MIT
