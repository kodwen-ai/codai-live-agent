import { z } from 'zod';

import type { LiveEvent } from './events.js';
import { decayed } from './scorer.js';
import { splitSentences } from './text.js';

export const REPLY_STATUSES = [
  'pending',
  'drafting',
  'ready',
  'speaking',
  'done',
  'skipped',
  'failed',
] as const;
export type ReplyStatus = (typeof REPLY_STATUSES)[number];

/** What produced an entry; decides whether it needs approval and costs a reply token. */
export type EntryKind = 'ai' | 'thanks' | 'greeting' | 'read' | 'manual';

/**
 * `auto`: AI drafts are spoken as soon as they are ready.
 * `approve`: AI drafts wait for `approve()` (optionally with edited text).
 * Template lines (thanks, greeting, read, manual) never need approval.
 */
export const ReplyModeSchema = z.enum(['auto', 'approve']);
export type ReplyMode = z.infer<typeof ReplyModeSchema>;

export interface QueueEntry {
  id: string;
  kind: EntryKind;
  userId: string;
  userName: string;
  /** The viewer message (or the instruction for an AI-initiated line). */
  message: string;
  score: number;
  reasons: string[];
  /** Epoch ms the entry was created; drives recency decay. */
  at: number;
  status: ReplyStatus;
  /** Full text drafted so far. */
  draft?: string;
  /** Sentences waiting to be spoken, in order. */
  parts: string[];
  /** Cleared to speak (auto mode, template, or the streamer approved). */
  approved: boolean;
  /** The LLM stream is still producing sentences. */
  streaming: boolean;
  /** Unspoken entries are skipped after this epoch ms. */
  expiresAt?: number;
  event?: LiveEvent;
}

export interface NewEntry {
  kind: EntryKind;
  userId?: string;
  userName?: string;
  message: string;
  score: number;
  reasons?: string[];
  /** Pre-written text (templates, manual): entry starts `ready`. */
  text?: string;
  ttlMs?: number;
  event?: LiveEvent;
}

const ACTIVE: ReadonlySet<ReplyStatus> = new Set(['pending', 'drafting', 'ready', 'speaking']);

export function isActive(status: ReplyStatus): boolean {
  return ACTIVE.has(status);
}

export interface ReplyQueueOptions {
  /** Max active (pending/drafting/ready/speaking) entries. Default 8. */
  maxActive?: number;
  mode?: ReplyMode;
  /** Finished entries kept for a history strip. Default 10. */
  keepFinished?: number;
  /** Called synchronously after every change with a newest-first snapshot. */
  onChange?: (entries: readonly QueueEntry[]) => void;
  now?: () => number;
}

/**
 * Ordered store of reply candidates and their lifecycle. Ranks with recency
 * decay, caps the active set (a full queue evicts its lowest pending entry only
 * when the newcomer outranks it), expires stale entries and implements the
 * streamer controls: approve / skip / edit / auto.
 */
export class ReplyQueue {
  #entries = new Map<string, QueueEntry>();
  #maxActive: number;
  #mode: ReplyMode;
  #keepFinished: number;
  #onChange: ((entries: readonly QueueEntry[]) => void) | undefined;
  #now: () => number;
  #seq = 0;

  constructor(options: ReplyQueueOptions = {}) {
    this.#maxActive = options.maxActive ?? 8;
    this.#mode = options.mode ?? 'approve';
    this.#keepFinished = options.keepFinished ?? 10;
    this.#onChange = options.onChange;
    this.#now = options.now ?? Date.now;
  }

  get mode(): ReplyMode {
    return this.#mode;
  }

  /** Switching to `auto` clears every waiting AI draft to speak. */
  setMode(mode: ReplyMode): void {
    this.#mode = mode;
    if (mode === 'auto') {
      for (const entry of this.#entries.values()) if (isActive(entry.status)) entry.approved = true;
    }
    this.#changed();
  }

  setMaxActive(max: number): void {
    this.#maxActive = Math.max(1, max);
  }

  get(id: string): QueueEntry | undefined {
    return this.#entries.get(id);
  }

  entries(): QueueEntry[] {
    return [...this.#entries.values()];
  }

  activeCount(): number {
    let n = 0;
    for (const entry of this.#entries.values()) if (isActive(entry.status)) n += 1;
    return n;
  }

  /** Add a candidate. Returns the entry, or `null` when the queue is full of better ones. */
  add(input: NewEntry): QueueEntry | null {
    const now = this.#now();
    if (this.activeCount() >= this.#maxActive) {
      const victim = this.#lowestPending(now);
      if (!victim || decayed(victim.score, victim.at, now) >= input.score) return null;
      victim.status = 'skipped';
    }
    this.#seq += 1;
    const text = input.text?.trim();
    const entry: QueueEntry = {
      id: `r-${now.toString(36)}-${this.#seq.toString(36)}`,
      kind: input.kind,
      userId: input.userId ?? '',
      userName: input.userName ?? '',
      message: input.message,
      score: input.score,
      reasons: input.reasons ?? [],
      at: now,
      status: text ? 'ready' : 'pending',
      parts: text ? splitSentences(text) : [],
      approved: input.kind !== 'ai' || this.#mode === 'auto',
      streaming: false,
      ...(text ? { draft: text } : {}),
      ...(input.ttlMs !== undefined ? { expiresAt: now + input.ttlMs } : {}),
      ...(input.event ? { event: input.event } : {}),
    };
    this.#entries.set(entry.id, entry);
    this.#trim();
    this.#changed();
    return entry;
  }

  /** Streamer approves; with `text` the draft is replaced (edit + approve) and any stream is ignored. */
  approve(id: string, text?: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry || !['pending', 'drafting', 'ready'].includes(entry.status)) return false;
    entry.approved = true;
    const edited = text?.trim();
    if (edited) this.#replaceText(entry, edited);
    this.#changed();
    return true;
  }

  /** Replace the draft text WITHOUT approving it (approve mode keeps it waiting). */
  edit(id: string, text: string): boolean {
    const entry = this.#entries.get(id);
    const edited = text.trim();
    if (!entry || edited === '' || !['pending', 'drafting', 'ready'].includes(entry.status))
      return false;
    this.#replaceText(entry, edited);
    this.#changed();
    return true;
  }

  skip(id: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry || !isActive(entry.status)) return false;
    this.#finish(entry, 'skipped');
    return true;
  }

  /** Move to a lifecycle status (drafting, done, failed...). */
  setStatus(id: string, status: ReplyStatus): QueueEntry | undefined {
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    if (!isActive(status)) {
      this.#finish(entry, status);
      return entry;
    }
    entry.status = status;
    this.#changed();
    return entry;
  }

  /** Streaming draft: append one sentence; the first one turns a `drafting` entry `ready`. */
  appendPart(id: string, sentence: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry || !isActive(entry.status)) return false;
    entry.parts.push(sentence);
    entry.draft = `${entry.draft ?? ''} ${sentence}`.trim();
    if (entry.status === 'drafting' || entry.status === 'pending') entry.status = 'ready';
    this.#changed();
    return true;
  }

  setStreaming(id: string, streaming: boolean): void {
    const entry = this.#entries.get(id);
    if (entry) entry.streaming = streaming;
  }

  /** Highest-ranked pending entry of the given kinds. */
  topPending(kinds: ReadonlySet<EntryKind>): QueueEntry | undefined {
    const now = this.#now();
    let best: QueueEntry | undefined;
    let bestScore = -Infinity;
    for (const entry of this.#entries.values()) {
      if (entry.status !== 'pending' || !kinds.has(entry.kind)) continue;
      const score = decayed(entry.score, entry.at, now);
      if (score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }
    return best;
  }

  /** Highest-ranked approved `ready` entry with parts; ties go to the oldest. */
  nextSpeakable(eligible: (entry: QueueEntry) => boolean = () => true): QueueEntry | undefined {
    const now = this.#now();
    let best: QueueEntry | undefined;
    let bestScore = -Infinity;
    for (const entry of this.#entries.values()) {
      if (
        entry.status !== 'ready' ||
        !entry.approved ||
        entry.parts.length === 0 ||
        !eligible(entry)
      )
        continue;
      const score = decayed(entry.score, entry.at, now);
      if (score > bestScore || (score === bestScore && best && entry.at < best.at)) {
        best = entry;
        bestScore = score;
      }
    }
    return best;
  }

  /** Pop the next sentence of an entry and mark it `speaking`. */
  takePart(id: string): string | undefined {
    const entry = this.#entries.get(id);
    if (!entry || !entry.approved) return undefined;
    const part = entry.parts.shift();
    if (part === undefined) return undefined;
    entry.status = 'speaking';
    this.#changed();
    return part;
  }

  /** A spoken part ended: `done` when nothing is left, else back to `ready`. */
  partSpoken(id: string): QueueEntry | undefined {
    const entry = this.#entries.get(id);
    if (!entry || entry.status !== 'speaking') return entry;
    if (entry.parts.length === 0 && !entry.streaming) this.#finish(entry, 'done');
    else {
      entry.status = 'ready';
      this.#changed();
    }
    return entry;
  }

  /** Skip unspoken entries past their deadline. Returns how many expired. */
  expire(): number {
    const now = this.#now();
    let n = 0;
    for (const entry of this.#entries.values()) {
      if (
        entry.expiresAt !== undefined &&
        now > entry.expiresAt &&
        (entry.status === 'pending' || entry.status === 'ready')
      ) {
        entry.status = 'skipped';
        entry.parts = [];
        n += 1;
      }
    }
    if (n > 0) {
      this.#trim();
      this.#changed();
    }
    return n;
  }

  /** Newest first. */
  snapshot(): QueueEntry[] {
    return [...this.#entries.values()]
      .map((entry) => ({ ...entry, parts: [...entry.parts] }))
      .sort((a, b) => b.at - a.at);
  }

  #replaceText(entry: QueueEntry, text: string): void {
    entry.parts = splitSentences(text);
    entry.draft = text;
    entry.streaming = false;
    entry.status = 'ready';
  }

  #finish(entry: QueueEntry, status: ReplyStatus): void {
    entry.status = status;
    entry.parts = [];
    entry.streaming = false;
    this.#trim();
    this.#changed();
  }

  #lowestPending(now: number): QueueEntry | undefined {
    let worst: QueueEntry | undefined;
    let worstScore = Infinity;
    for (const entry of this.#entries.values()) {
      if (entry.status !== 'pending') continue;
      const score = decayed(entry.score, entry.at, now);
      if (score < worstScore) {
        worst = entry;
        worstScore = score;
      }
    }
    return worst;
  }

  #trim(): void {
    const finished = [...this.#entries.values()]
      .filter((entry) => !isActive(entry.status))
      .sort((a, b) => b.at - a.at);
    for (const entry of finished.slice(this.#keepFinished)) this.#entries.delete(entry.id);
  }

  #changed(): void {
    this.#onChange?.(this.snapshot());
  }
}
