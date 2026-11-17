import { eventValue, type LiveEvent } from './events.js';
import { escapeRegExp, foldText, normaliseForMatch } from './text.js';

/**
 * Deterministic reply priority. Pure and allocation-light: it runs on every
 * event during a gift storm, so it must stay well under a millisecond.
 */

export interface ScoreContext {
  /** Co-host persona name; a mention of it is a strong signal. */
  personaName: string;
  /** Streamer handle without `@`. */
  streamerHandle: string;
  /** First event from this viewer in the current session. */
  firstThisSession: boolean;
  /** Viewer never seen in any previous session. */
  firstEver: boolean;
  /** Same normalised text already seen recently (any user). */
  duplicate: boolean;
  /** Compiled blocked-word list (`compileWordList`). */
  blocked: RegExp | null;
}

export type ScoreExclusion = 'duplicate' | 'blocked' | 'empty' | 'kind';

export interface ScoreResult {
  score: number;
  reasons: string[];
  /** Set when the event must never become a reply candidate. */
  excluded?: ScoreExclusion;
}

export interface ScoreWeights {
  chatBase: number;
  giftBase: number;
  giftLog: number;
  follow: number;
  question: number;
  firstThisSession: number;
  firstEver: number;
  mention: number;
  follower: number;
  subscriber: number;
  moderator: number;
  lowContent: number;
}

export const SCORE_WEIGHTS: Readonly<ScoreWeights> = Object.freeze({
  chatBase: 1,
  giftBase: 3,
  giftLog: 2,
  follow: 1.5,
  question: 3,
  firstThisSession: 1,
  firstEver: 2,
  mention: 4,
  follower: 0.5,
  subscriber: 1,
  moderator: 0.5,
  lowContent: -1,
});

/** Half-life of a candidate's priority; an old question is worth less than a fresh one. */
export const RECENCY_HALF_LIFE_MS = 30_000;

/** Romanian and English question openers, matched on diacritic-folded text. */
const QUESTION_WORDS =
  /^(ce|cum|de ce|cine|cand|unde|cat|cata|cati|cate|care|oare|poti|pot|ai|esti|stii|what|how|why|who|when|where|which|can|could|do|does|did|is|are|will|would|should)\b/;

export function isQuestion(text: string): boolean {
  const folded = foldText(text);
  return folded.includes('?') || QUESTION_WORDS.test(folded);
}

export function mentions(text: string, personaName: string, streamerHandle: string): boolean {
  const lower = foldText(text);
  const persona = foldText(personaName);
  if (
    persona !== '' &&
    new RegExp(`(^|[^\\p{L}\\p{N}])@?${escapeRegExp(persona)}([^\\p{L}\\p{N}]|$)`, 'u').test(lower)
  ) {
    return true;
  }
  const handle = foldText(streamerHandle).replace(/^@/, '');
  return handle !== '' && lower.includes(`@${handle}`);
}

/** Base score at the moment the event arrived (no decay). */
export function scoreEvent(
  event: LiveEvent,
  context: ScoreContext,
  weights: Readonly<ScoreWeights> = SCORE_WEIGHTS,
): ScoreResult {
  if (event.kind !== 'chat' && event.kind !== 'gift' && event.kind !== 'follow') {
    return { score: 0, reasons: [], excluded: 'kind' };
  }
  const text = event.text.trim();
  if (event.kind === 'chat') {
    if (text === '') return { score: 0, reasons: [], excluded: 'empty' };
    if (context.blocked?.test(normaliseForMatch(text)))
      return { score: 0, reasons: [], excluded: 'blocked' };
    if (context.duplicate) return { score: 0, reasons: [], excluded: 'duplicate' };
  }

  const reasons: string[] = [];
  let score = 0;

  if (event.kind === 'gift') {
    score += weights.giftBase + weights.giftLog * Math.log10(1 + eventValue(event));
    reasons.push('gift');
  } else if (event.kind === 'follow') {
    score += weights.follow;
    reasons.push('follow');
  } else {
    score += weights.chatBase;
    if (isQuestion(text)) {
      score += weights.question;
      reasons.push('question');
    }
    if (mentions(text, context.personaName, context.streamerHandle)) {
      score += weights.mention;
      reasons.push('mention');
    }
    // Emoji-only or one-word noise is rarely worth a spoken reply.
    if (text.replace(/[^\p{L}\p{N}]/gu, '').length < 3) score += weights.lowContent;
  }

  if (context.firstEver) {
    score += weights.firstEver;
    reasons.push('first-time');
  } else if (context.firstThisSession) {
    score += weights.firstThisSession;
    reasons.push('first-today');
  }
  if (event.user.isModerator) {
    score += weights.moderator;
    reasons.push('moderator');
  }
  if (event.user.isSubscriber) {
    score += weights.subscriber;
    reasons.push('subscriber');
  } else if (event.user.isFollower) {
    score += weights.follower;
    reasons.push('follower');
  }

  return { score: Math.max(0, Math.round(score * 100) / 100), reasons };
}

/** Exponential recency decay applied when ranking. */
export function decayed(
  score: number,
  at: number,
  now: number,
  halfLifeMs = RECENCY_HALF_LIFE_MS,
): number {
  const age = Math.max(0, now - at);
  return score * 0.5 ** (age / halfLifeMs);
}

/**
 * Remembers recently seen normalised texts so copy-paste waves ("first",
 * "❤❤❤") count once. Bounded and time-windowed.
 */
export class DuplicateTracker {
  #seen = new Map<string, number>();
  #windowMs: number;
  #max: number;

  constructor(windowMs = 60_000, max = 2048) {
    this.#windowMs = windowMs;
    this.#max = max;
  }

  /** True when this text was already seen inside the window; records it either way. */
  check(text: string, now: number): boolean {
    const key = normaliseForMatch(text).replace(/\s+/g, ' ').trim();
    if (key === '') return false;
    const last = this.#seen.get(key);
    this.#seen.set(key, now);
    if (this.#seen.size > this.#max) {
      for (const [k, at] of this.#seen) if (now - at > this.#windowMs) this.#seen.delete(k);
    }
    return last !== undefined && now - last < this.#windowMs;
  }
}
