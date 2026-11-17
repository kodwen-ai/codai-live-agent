import type { LiveEvent } from './events.js';
import type { Language } from './persona.js';

/**
 * Teleprompter: watches the chat and nudges the streamer with one short line
 * at a time (unanswered question, gifts to thank, quiet chat, activity spike).
 * Time is injected; `tick` is driven by a timer in production.
 */

export type SuggestionKind = 'unanswered' | 'thanks' | 'quiet' | 'spike';

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  text: string;
  at: number;
  /** Viewer the suggestion is about, when there is one. */
  userId?: string;
}

export interface CoachOptions {
  language?: Language;
  minGapMs?: number;
  unansweredAfterMs?: number;
  quietAfterMs?: number;
  thanksAfterMs?: number;
  /** Spike = current minute > factor x average of previous minutes. */
  spikeFactor?: number;
  spikeMinMessages?: number;
}

export const COACH_DEFAULTS = {
  minGapMs: 20_000,
  unansweredAfterMs: 60_000,
  quietAfterMs: 90_000,
  thanksAfterMs: 15_000,
  spikeFactor: 3,
  spikeMinMessages: 15,
} as const;

const HISTORY_MINUTES = 10;

interface OpenQuestion {
  userId: string;
  name: string;
  text: string;
  at: number;
  suggested: boolean;
}

export class Coach {
  #emit: (suggestion: Suggestion) => void;
  #o: Required<CoachOptions>;
  #lastEmit = Number.NEGATIVE_INFINITY;
  #lastChat = 0;
  #quietSuggested = false;
  #questions: OpenQuestion[] = [];
  #pendingThanks = new Map<string, { name: string; gifts: number; at: number }>();
  #minuteStart = 0;
  #minuteCount = 0;
  #history: number[] = [];
  #spikeSuggestedAt = Number.NEGATIVE_INFINITY;
  #active = false;
  #seq = 0;

  constructor(emit: (suggestion: Suggestion) => void, options: CoachOptions = {}) {
    this.#emit = emit;
    this.#o = { language: 'en', ...COACH_DEFAULTS, ...options };
  }

  get active(): boolean {
    return this.#active;
  }

  start(now: number): void {
    this.#active = true;
    this.#lastChat = now;
    this.#minuteStart = now;
  }

  stop(): void {
    this.#active = false;
    this.#questions = [];
    this.#pendingThanks.clear();
    this.#history = [];
    this.#minuteCount = 0;
  }

  onEvent(event: LiveEvent, question: boolean): void {
    if (!this.#active) this.start(event.at);
    if (event.kind === 'chat') {
      this.#lastChat = event.at;
      this.#quietSuggested = false;
      this.#rollMinute(event.at);
      this.#minuteCount += 1;
      if (question) {
        this.#questions.push({
          userId: event.user.id,
          name: event.user.name,
          text: event.text,
          at: event.at,
          suggested: false,
        });
        if (this.#questions.length > 50) this.#questions.shift();
      }
    } else if (event.kind === 'gift') {
      const entry = this.#pendingThanks.get(event.user.id) ?? {
        name: event.user.name,
        gifts: 0,
        at: event.at,
      };
      entry.gifts += event.gift?.count ?? 1;
      this.#pendingThanks.set(event.user.id, entry);
    }
  }

  /** The co-host or the streamer answered this viewer; clear their open items. */
  answered(userId: string): void {
    this.#questions = this.#questions.filter((q) => q.userId !== userId);
    this.#pendingThanks.delete(userId);
  }

  /** The streamer spoke (STT); pushes the quiet timer back. */
  streamerSpoke(at: number): void {
    this.#lastChat = Math.max(this.#lastChat, at - this.#o.quietAfterMs / 2);
  }

  tick(now: number): Suggestion | null {
    if (!this.#active || now - this.#lastEmit < this.#o.minGapMs) return null;
    this.#rollMinute(now);
    const suggestion =
      this.#spike(now) ?? this.#unanswered(now) ?? this.#thanks(now) ?? this.#quiet(now);
    if (suggestion) {
      this.#lastEmit = now;
      this.#emit(suggestion);
    }
    return suggestion;
  }

  #make(kind: SuggestionKind, text: string, at: number, userId?: string): Suggestion {
    this.#seq += 1;
    return {
      id: `s-${at.toString(36)}-${this.#seq}`,
      kind,
      text,
      at,
      ...(userId ? { userId } : {}),
    };
  }

  #unanswered(now: number): Suggestion | null {
    const open = this.#questions.find(
      (q) => !q.suggested && now - q.at >= this.#o.unansweredAfterMs,
    );
    if (!open) return null;
    open.suggested = true;
    const excerpt = open.text.length > 80 ? `${open.text.slice(0, 77)}…` : open.text;
    const text =
      this.#o.language === 'ro'
        ? `${open.name} a întrebat acum un minut: „${excerpt}”`
        : `${open.name} asked a minute ago: "${excerpt}"`;
    return this.#make('unanswered', text, now, open.userId);
  }

  #thanks(now: number): Suggestion | null {
    const due = [...this.#pendingThanks.entries()].filter(
      ([, v]) => now - v.at >= this.#o.thanksAfterMs,
    );
    if (due.length === 0) return null;
    for (const [key] of due) this.#pendingThanks.delete(key);
    const names = due.slice(0, 3).map(([, v]) => v.name);
    const extra = due.length - 3;
    const text =
      this.#o.language === 'ro'
        ? `Mulțumește pentru cadouri: ${names.join(', ')}${extra > 0 ? ` și încă ${extra}` : ''}.`
        : `Thank them for the gifts: ${names.join(', ')}${extra > 0 ? ` and ${extra} more` : ''}.`;
    return this.#make('thanks', text, now);
  }

  #quiet(now: number): Suggestion | null {
    if (this.#quietSuggested || now - this.#lastChat < this.#o.quietAfterMs) return null;
    this.#quietSuggested = true;
    const text =
      this.#o.language === 'ro'
        ? 'Chatul e liniștit. Pune o întrebare publicului sau pornește o provocare.'
        : 'Chat is quiet. Ask the audience a question or start a challenge.';
    return this.#make('quiet', text, now);
  }

  #spike(now: number): Suggestion | null {
    if (this.#history.length < 3 || now - this.#spikeSuggestedAt < 5 * 60_000) return null;
    const average = this.#history.reduce((a, b) => a + b, 0) / this.#history.length;
    const current = this.#minuteCount;
    if (current < this.#o.spikeMinMessages || current <= this.#o.spikeFactor * Math.max(1, average))
      return null;
    this.#spikeSuggestedAt = now;
    const text =
      this.#o.language === 'ro'
        ? 'Chatul explodează acum! Profită: salută-i pe toți și cere un follow.'
        : 'Chat is blowing up! Greet everyone and ask for a follow.';
    return this.#make('spike', text, now);
  }

  #rollMinute(now: number): void {
    while (now - this.#minuteStart >= 60_000) {
      this.#history.push(this.#minuteCount);
      if (this.#history.length > HISTORY_MINUTES) this.#history.shift();
      this.#minuteCount = 0;
      this.#minuteStart += 60_000;
    }
  }
}
