import { z } from 'zod';

import { TokenBucket } from './bucket.js';
import { Coach, type Suggestion } from './coach.js';
import { LiveEventSchema, eventValue, type LiveEvent, type LiveEventKind } from './events.js';
import { FactCollector } from './facts.js';
import { CodaiLlmClient, LlmConfigSchema, type ApiKeySource, type LlmClient } from './llm.js';
import { createMemoryHooks, InMemoryStore, type MemoryHooks, type MemoryStore } from './memory.js';
import {
  ModerationRulesSchema,
  WordListModerator,
  type ModerationHook,
  type ModerationVerdict,
  type OutputModerationHook,
} from './moderation.js';
import { PersonaSchema } from './persona.js';
import {
  ReplyModeSchema,
  ReplyQueue,
  type EntryKind,
  type QueueEntry,
  type ReplyMode,
} from './queue.js';
import { draftReply } from './responder.js';
import { DuplicateTracker, isQuestion, scoreEvent } from './scorer.js';
import { greetingLine, readAloudLine, thanksLine } from './templates.js';
import { triage, type TriageDecision, type TriageInput, type TriagePolicy } from './triage.js';
import { compileWordList } from './text.js';

const KindFlagsSchema = z
  .object({
    chat: z.boolean().default(false),
    gift: z.boolean().default(false),
    join: z.boolean().default(false),
    like: z.boolean().default(false),
    follow: z.boolean().default(false),
    share: z.boolean().default(false),
  })
  .default({ chat: false, gift: false, join: false, like: false, follow: false, share: false });

export const LiveAgentConfigSchema = z.object({
  persona: PersonaSchema.default(PersonaSchema.parse({})),
  /** Model alias is required; the API key is passed separately (never in config). */
  llm: LlmConfigSchema,
  /** Optional cheaper model for background fact extraction (defaults to `llm.model`). */
  factsModel: z.string().optional(),
  streamerHandle: z.string().default(''),
  replyMode: ReplyModeSchema.default('approve'),
  aiReplies: z.boolean().default(true),
  repliesPerMinute: z.number().min(0).default(4),
  burst: z.number().int().min(1).default(2),
  maxQueue: z.number().int().min(1).default(8),
  minAiScore: z.number().default(2),
  thankGifts: z.boolean().default(true),
  greetReturning: z.boolean().default(true),
  greetMinVisits: z.number().int().min(1).default(1),
  /** Thanks/greeting once per viewer per window. */
  templateDedupeMs: z
    .number()
    .int()
    .nonnegative()
    .default(5 * 60_000),
  aiTtlMs: z.number().int().positive().default(90_000),
  approveTtlMs: z.number().int().positive().default(180_000),
  templateTtlMs: z.number().int().positive().default(60_000),
  readAloud: z
    .object({
      enabled: z.boolean().default(false),
      kinds: KindFlagsSchema,
      minGiftValue: z.number().nonnegative().default(0),
      readNames: z.boolean().default(true),
    })
    .default({
      enabled: false,
      kinds: { chat: false, gift: false, join: false, like: false, follow: false, share: false },
      minGiftValue: 0,
      readNames: true,
    }),
  skipDuplicates: z.boolean().default(true),
  /** Used by the built-in moderator when no `moderation` hook is passed. */
  moderation: ModerationRulesSchema.default(ModerationRulesSchema.parse({})),
  extractFacts: z.boolean().default(true),
  coach: z.boolean().default(true),
});
export type LiveAgentConfig = z.output<typeof LiveAgentConfigSchema>;
export type LiveAgentConfigInput = z.input<typeof LiveAgentConfigSchema>;

export interface LiveAgentDeps {
  /** Required unless `llm` is given. Used only in the Authorization header; never logged. */
  apiKey?: ApiKeySource;
  /** Bring your own backend instead of the codai gateway client. */
  llm?: LlmClient;
  fetch?: typeof fetch;
  /** Viewer memory; defaults to `InMemoryStore`. */
  store?: MemoryStore;
  /** Input moderation; defaults to `WordListModerator` built from `config.moderation`. */
  moderation?: ModerationHook;
  /** Output moderation for drafted sentences; defaults to the blocked-word list. */
  outputModeration?: OutputModerationHook;
  /**
   * Speak one sentence; resolve when the utterance has finished (TTS done).
   * Without it, ready entries stay in the queue for the host to read.
   */
  speak?: (sentence: string, entry: QueueEntry) => Promise<void>;
  onQueue?: (entries: readonly QueueEntry[]) => void;
  onSuggestion?: (suggestion: Suggestion) => void;
  /** Moderation alert keyword matched. */
  onAlert?: (event: LiveEvent, verdict: ModerationVerdict) => void;
  /** Non-fatal failures (LLM, store, speak). Messages never contain the API key. */
  onError?: (error: unknown, where: string) => void;
  now?: () => number;
}

const AI_KINDS: ReadonlySet<EntryKind> = new Set(['ai']);
const TRANSCRIPT_WINDOW_MS = 60_000;

/**
 * The co-host runtime: moderates → observes memory → scores → triages each
 * event into the reply queue, drafts AI replies (streaming, token-bucketed)
 * and speaks one sentence at a time through the host's `speak`. Never speaks
 * while paused, over itself, or before approval in `approve` mode.
 */
export class LiveAgent {
  readonly config: LiveAgentConfig;
  readonly queue: ReplyQueue;
  readonly memory: MemoryHooks;
  readonly coach: Coach;
  #deps: LiveAgentDeps;
  #now: () => number;
  #llm: LlmClient;
  #bucket: TokenBucket;
  #moderation: ModerationHook;
  #outputModeration: OutputModerationHook;
  #blocked: RegExp | null;
  #duplicates = new DuplicateTracker();
  #facts: FactCollector;
  #templateSeen = new Map<string, number>();
  #drafts = new Map<string, AbortController>();
  #transcript: Array<{ text: string; at: number }> = [];
  #speakingId: string | null = null;
  #paused = false;
  #session: string | null = null;
  #inflight = new Set<Promise<unknown>>();

  constructor(config: LiveAgentConfigInput, deps: LiveAgentDeps = {}) {
    this.config = LiveAgentConfigSchema.parse(config);
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    if (deps.llm) this.#llm = deps.llm;
    else if (deps.apiKey !== undefined) {
      this.#llm = new CodaiLlmClient({
        ...this.config.llm,
        apiKey: deps.apiKey,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
    } else throw new Error('LiveAgent needs either deps.apiKey (codai gateway) or deps.llm');

    const builtin = new WordListModerator(this.config.moderation);
    this.#moderation = deps.moderation ?? builtin.hook;
    this.#outputModeration = deps.outputModeration ?? builtin.outputHook;
    this.#blocked = compileWordList(this.config.moderation.blockedWords);
    this.queue = new ReplyQueue({
      maxActive: this.config.maxQueue,
      mode: this.config.replyMode,
      now: this.#now,
      ...(deps.onQueue ? { onChange: deps.onQueue } : {}),
    });
    this.#bucket = new TokenBucket(this.config.repliesPerMinute, this.config.burst, this.#now());
    this.memory = createMemoryHooks(deps.store ?? new InMemoryStore(), {
      now: this.#now,
      onError: (error) => this.#error(error, 'memory'),
    });
    this.coach = new Coach((s) => deps.onSuggestion?.(s), {
      language: this.config.persona.language,
    });
    this.#facts = new FactCollector({
      llm: this.#llm,
      store: (userId, facts) => this.memory.remember(userId, facts, this.#now()),
      model: this.config.factsModel ?? this.config.llm.model,
    });
  }

  get paused(): boolean {
    return this.#paused;
  }

  get session(): string | null {
    return this.#session;
  }

  startSession(sessionId: string): void {
    this.#session = sessionId;
    this.memory.startSession(sessionId);
    if (this.config.coach) this.coach.start(this.#now());
  }

  endSession(): void {
    if (this.#session) this.memory.endSession(this.#session);
    this.#session = null;
    this.coach.stop();
  }

  /** Validate, moderate, remember, score and route one event. */
  async handle(input: unknown): Promise<TriageDecision> {
    const event = LiveEventSchema.parse(input);
    const now = this.#now();
    const verdict = await this.#moderate(event);
    if (verdict.alert) this.#deps.onAlert?.(event, verdict);
    if (verdict.blocked)
      return triage(this.#triageInput(event, verdict, false, 0, false), this.#policy());

    const observation = await this.memory.observe(event, this.#session);
    const duplicate = event.kind === 'chat' && this.#duplicates.check(event.text, event.at);
    const question = event.kind === 'chat' && isQuestion(event.text);
    if (this.config.coach) this.coach.onEvent(event, question && !duplicate);

    const previousVisits = observation.before?.visits ?? 0;
    const input2 = this.#triageInput(
      event,
      verdict,
      observation.firstThisSession,
      previousVisits,
      duplicate,
    );
    input2.score = scoreEvent(event, {
      personaName: this.config.persona.name,
      streamerHandle: this.config.streamerHandle,
      firstThisSession: observation.firstThisSession,
      firstEver: observation.before === null && event.user.id !== '',
      duplicate,
      blocked: this.#blocked,
    });
    const decision = triage(input2, this.#policy());
    const lang = this.config.persona.language;

    for (const route of decision.routes) {
      if (route === 'read') {
        const line = readAloudLine(event, this.config.readAloud.readNames, lang);
        if (line !== '') this.#template('read', event, line, 1);
      } else if (route === 'thanks') {
        this.#templateSeen.set(`thanks\u0000${event.user.id}`, now);
        this.#template(
          'thanks',
          event,
          thanksLine(event, lang),
          5 + Math.log10(1 + eventValue(event)),
        );
      } else if (route === 'greeting') {
        this.#templateSeen.set(`greeting\u0000${event.user.id}`, now);
        this.#template('greeting', event, greetingLine(event.user.name, previousVisits, lang), 4);
      } else if (route === 'ai') {
        this.queue.add({
          kind: 'ai',
          userId: event.user.id,
          userName: event.user.name,
          message: event.text,
          score: input2.score.score,
          reasons: input2.score.reasons,
          ttlMs: this.queue.mode === 'approve' ? this.config.approveTtlMs : this.config.aiTtlMs,
          event,
        });
        if (this.config.extractFacts && !event.replay) {
          this.#facts.add({ userId: event.user.id, userName: event.user.name, text: event.text });
        }
      }
    }
    this.pump();
    return decision;
  }

  /** Streamer speech-to-text; gives the responder context and resets the coach's quiet timer. */
  onTranscript(text: string, at = this.#now()): void {
    const clean = text.trim();
    if (clean === '') return;
    this.#transcript.push({ text: clean, at });
    this.#transcript = this.#transcript.filter((t) => at - t.at <= TRANSCRIPT_WINDOW_MS);
    this.coach.streamerSpoke(at);
  }

  /* --------------------------- streamer controls --------------------------- */

  approve(id: string, text?: string): boolean {
    const okay = this.queue.approve(id, text);
    if (okay && text?.trim()) this.#abortDraft(id);
    this.pump();
    return okay;
  }

  edit(id: string, text: string): boolean {
    const okay = this.queue.edit(id, text);
    if (okay) this.#abortDraft(id);
    return okay;
  }

  skip(id: string): boolean {
    const entry = this.queue.get(id);
    if (!entry) return false;
    // A draft that never got spoken should not cost a reply slot.
    if (entry.kind === 'ai' && (entry.status === 'drafting' || entry.status === 'ready'))
      this.#bucket.refund(this.#now());
    this.#abortDraft(id);
    const okay = this.queue.skip(id);
    this.pump();
    return okay;
  }

  setMode(mode: ReplyMode): void {
    this.queue.setMode(mode);
    this.pump();
  }

  /** Manual announcement: bypasses the bucket and approval. */
  say(text: string): QueueEntry | null {
    const entry = this.queue.add({
      kind: 'manual',
      message: text,
      text,
      score: 100,
      reasons: ['manual'],
      ttlMs: this.config.templateTtlMs,
    });
    this.pump();
    return entry;
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
    this.pump();
  }

  /* --------------------------------- pump --------------------------------- */

  /** Advance expiry, coaching, drafting and speaking. Cheap and idempotent. */
  pump(): void {
    const now = this.#now();
    this.queue.expire();
    if (this.config.coach) this.coach.tick(now);
    this.#startDraft();
    this.#speakNext();
  }

  /** Resolves when no draft or utterance is in flight (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  async dispose(): Promise<void> {
    this.#paused = true;
    for (const controller of this.#drafts.values()) controller.abort();
    await this.idle();
    await this.#facts.flush().catch((error: unknown) => this.#error(error, 'facts'));
    this.#facts.dispose();
    this.endSession();
  }

  /* ------------------------------- internals ------------------------------- */

  #startDraft(): void {
    if (!this.config.aiReplies || this.#paused || this.#drafts.size > 0) return;
    const entry = this.queue.topPending(AI_KINDS);
    if (!entry || !this.#bucket.tryTake(this.#now())) return;
    this.#track(this.#draft(entry));
  }

  async #draft(entry: QueueEntry): Promise<void> {
    const id = entry.id;
    const controller = new AbortController();
    this.#drafts.set(id, controller);
    this.queue.setStreaming(id, true);
    this.queue.setStatus(id, 'drafting');
    const viewer = await this.memory.context(entry.userId);
    const now = this.#now();
    const transcript = this.#transcript
      .filter((t) => now - t.at <= TRANSCRIPT_WINDOW_MS)
      .map((t) => t.text)
      .join(' ')
      .slice(-600);

    const result = await draftReply(this.#llm, {
      persona: this.config.persona,
      moderate: this.#outputModeration,
      signal: controller.signal,
      context: {
        userName: entry.userName,
        userId: entry.userId,
        message: entry.message,
        reasons: entry.reasons,
        ...(viewer ? { visits: viewer.visits, facts: viewer.facts } : {}),
        ...(viewer && viewer.totalValue > 0
          ? { giftSummary: `${viewer.totalValue} in gifts so far` }
          : {}),
        ...(transcript !== '' ? { transcript } : {}),
      },
      onSentence: (sentence) => {
        // An approve-with-text / edit replaced the draft: ignore the rest of the stream.
        if (!this.queue.get(id)?.streaming) return;
        if (this.queue.appendPart(id, sentence)) this.pump();
      },
    });
    this.#drafts.delete(id);
    const wasStreaming = this.queue.get(id)?.streaming ?? false;
    this.queue.setStreaming(id, false);
    const live = this.queue.get(id);
    const edited = !wasStreaming && live !== undefined && live.status === 'ready';
    if (live && live.status !== 'skipped' && !result.ok && !edited) {
      this.#bucket.refund(this.#now());
      this.#error(result.error, 'draft');
      if (live.status !== 'speaking')
        this.queue.setStatus(id, result.error.kind === 'aborted' ? 'skipped' : 'failed');
    } else if (live?.status === 'ready' && live.parts.length === 0) {
      // Speaker finished every part while the stream was still open.
      this.queue.setStatus(id, 'done');
    }
    this.pump();
  }

  #speakNext(): void {
    const speak = this.#deps.speak;
    if (!speak || this.#paused || this.#speakingId !== null) return;
    const entry = this.queue.nextSpeakable();
    if (!entry) return;
    const part = this.queue.takePart(entry.id);
    if (part === undefined) return;
    this.#speakingId = entry.id;
    this.#track(
      speak(part, entry)
        .then(
          () => {
            const after = this.queue.partSpoken(entry.id);
            if (after?.status === 'done' && after.userId !== '') this.coach.answered(after.userId);
          },
          (error: unknown) => {
            this.#error(error, 'speak');
            this.#abortDraft(entry.id);
            this.queue.setStatus(entry.id, 'failed');
          },
        )
        .finally(() => {
          this.#speakingId = null;
          this.pump();
        }),
    );
  }

  #template(kind: EntryKind, event: LiveEvent, text: string, score: number): void {
    this.queue.add({
      kind,
      userId: event.user.id,
      userName: event.user.name,
      message: event.text,
      text,
      score,
      reasons: [kind],
      ttlMs: this.config.templateTtlMs,
      event,
    });
  }

  async #moderate(event: LiveEvent): Promise<ModerationVerdict> {
    try {
      return await this.#moderation(event);
    } catch (error) {
      this.#error(error, 'moderation');
      // Fail CLOSED for moderation: an unverified message is never spoken.
      return { blocked: true, reason: 'custom', alert: false };
    }
  }

  #recent(kind: string, userId: string): boolean {
    const at = this.#templateSeen.get(`${kind}\u0000${userId}`);
    return at !== undefined && this.#now() - at < this.config.templateDedupeMs;
  }

  #triageInput(
    event: LiveEvent,
    verdict: ModerationVerdict,
    firstThisSession: boolean,
    previousVisits: number,
    duplicate: boolean,
  ): TriageInput {
    return {
      event,
      verdict,
      score: { score: 0, reasons: [] },
      firstThisSession,
      previousVisits,
      duplicate,
      recentlyThanked: this.#recent('thanks', event.user.id),
      recentlyGreeted: this.#recent('greeting', event.user.id),
    };
  }

  #policy(): TriagePolicy {
    const read = this.config.readAloud;
    return {
      aiReplies: this.config.aiReplies,
      minAiScore: this.config.minAiScore,
      thankGifts: this.config.thankGifts,
      greetReturning: this.config.greetReturning,
      greetMinVisits: this.config.greetMinVisits,
      readAloud: {
        enabled: read.enabled,
        kinds: read.kinds satisfies Record<LiveEventKind, boolean>,
        minGiftValue: read.minGiftValue,
        readNames: read.readNames,
      },
      skipDuplicates: this.config.skipDuplicates,
    };
  }

  #abortDraft(id: string): void {
    this.#drafts.get(id)?.abort();
  }

  #track(promise: Promise<unknown>): void {
    this.#inflight.add(promise);
    void promise.finally(() => this.#inflight.delete(promise));
  }

  #error(error: unknown, where: string): void {
    this.#deps.onError?.(error, where);
  }
}
