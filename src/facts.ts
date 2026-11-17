import type { LlmClient } from './llm.js';

/**
 * Durable-fact extraction for viewer memory. Messages are buffered and sent to
 * the model in ONE call per interval; the model returns
 * `{ "<userId>": ["fact", ...] }` with only stable self-statements (city, job,
 * pet, hobby, birthday) — never moods or opinions.
 */

export const FACTS_INTERVAL_MS = 30_000;
const MAX_BATCH = 30;

const SYSTEM = [
  'You extract durable facts that live-stream viewers state ABOUT THEMSELVES in chat.',
  'Examples: city, job, pet, hobby, birthday, language spoken.',
  'Ignore momentary moods, opinions, questions, jokes and statements about other people.',
  'Reply ONLY with JSON: {"<userId>": ["short third-person fact", ...]}. No facts => {}.',
].join('\n');

export interface FactMessage {
  userId: string;
  userName: string;
  text: string;
}

/** Find and parse the first JSON object in a model reply; only `allowed` ids are kept. */
export function parseFacts(raw: string, allowed: ReadonlySet<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowed.has(id) || !Array.isArray(value)) continue;
    const facts = value
      .filter((f): f is string => typeof f === 'string' && f.trim().length > 2)
      .map((f) => f.trim().slice(0, 200));
    if (facts.length > 0) out.set(id, facts.slice(0, 5));
  }
  return out;
}

export interface FactCollectorOptions {
  llm: Pick<LlmClient, 'complete'>;
  store: (userId: string, facts: string[]) => void | Promise<void>;
  model?: string;
  intervalMs?: number;
}

export class FactCollector {
  #o: FactCollectorOptions;
  #buffer: FactMessage[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #busy = false;

  constructor(options: FactCollectorOptions) {
    this.#o = options;
  }

  get pending(): number {
    return this.#buffer.length;
  }

  add(message: FactMessage): void {
    if (message.text.trim().length < 8) return;
    this.#buffer.push(message);
    if (this.#buffer.length > MAX_BATCH) this.#buffer.splice(0, this.#buffer.length - MAX_BATCH);
    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        void this.flush();
      }, this.#o.intervalMs ?? FACTS_INTERVAL_MS);
      const timer: unknown = this.#timer;
      (timer as { unref?: () => void }).unref?.();
    }
  }

  /** Send the buffer now. Returns how many viewers got new facts. */
  async flush(): Promise<number> {
    if (this.#busy || this.#buffer.length === 0) return 0;
    this.#busy = true;
    const batch = this.#buffer;
    this.#buffer = [];
    try {
      const lines = batch.map(
        (m) => `${m.userId} (${m.userName}): ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`,
      );
      const result = await this.#o.llm.complete({
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: lines.join('\n') },
        ],
        ...(this.#o.model ? { model: this.#o.model } : {}),
        timeoutMs: 10_000,
        maxTokens: 400,
        temperature: 0.2,
      });
      if (!result.ok) return 0;
      const facts = parseFacts(result.value, new Set(batch.map((m) => m.userId)));
      for (const [id, list] of facts) await this.#o.store(id, list);
      return facts.size;
    } finally {
      this.#busy = false;
    }
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
