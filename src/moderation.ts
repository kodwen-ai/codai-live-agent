import { z } from 'zod';

import type { LiveEvent } from './events.js';
import { compileWordList, normaliseForMatch } from './text.js';

export interface ModerationVerdict {
  /** Drop the event: no reply, no read-aloud, no memory write. */
  blocked: boolean;
  reason?: 'word' | 'user' | 'spam' | 'custom';
  /** The event matched an alert keyword (surface it to the streamer). */
  alert: boolean;
}

/**
 * Input moderation hook. Runs before scoring; return `blocked: true` to drop
 * the event. May be async (e.g. a remote classifier) — the agent awaits it.
 */
export type ModerationHook = (event: LiveEvent) => ModerationVerdict | Promise<ModerationVerdict>;

/**
 * Output moderation hook, applied to every drafted sentence before it can be
 * spoken. Return `false` to block the whole draft.
 */
export type OutputModerationHook = (sentence: string) => boolean;

export const ModerationRulesSchema = z.object({
  blockedWords: z.array(z.string()).default([]),
  blockedUsers: z.array(z.string()).default([]),
  alertKeywords: z.array(z.string()).default([]),
  hideSpam: z.boolean().default(true),
  spamWindowMs: z.number().int().positive().default(30_000),
});
export type ModerationRules = z.infer<typeof ModerationRulesSchema>;
export type ModerationRulesInput = z.input<typeof ModerationRulesSchema>;

/**
 * Word-list / user-list / per-user spam moderator. Stateful (spam needs memory
 * of recent messages); compiled regexes are cached until the rules change.
 */
export class WordListModerator {
  #rules: ModerationRules;
  #blockedRe: RegExp | null = null;
  #alertRe: RegExp | null = null;
  #blockedUsers = new Set<string>();
  #recent = new Map<string, number>();

  constructor(rules: ModerationRulesInput = {}) {
    this.#rules = ModerationRulesSchema.parse(rules);
    this.#compile();
  }

  setRules(rules: ModerationRulesInput): void {
    this.#rules = ModerationRulesSchema.parse(rules);
    this.#compile();
  }

  /** Use as a `ModerationHook`: `hook: moderator.hook`. */
  readonly hook: ModerationHook = (event) => this.evaluate(event);

  /** Use as an `OutputModerationHook` (blocked words only). */
  readonly outputHook: OutputModerationHook = (sentence) =>
    !this.#blockedRe?.test(normaliseForMatch(sentence));

  evaluate(event: LiveEvent): ModerationVerdict {
    const handle = event.user.id.toLowerCase();
    if (this.#blockedUsers.has(handle)) return { blocked: true, reason: 'user', alert: false };
    const normalised = normaliseForMatch(event.text);
    if (this.#blockedRe?.test(normalised)) return { blocked: true, reason: 'word', alert: false };
    // Only chat can be spam; a viewer legitimately sends the same gift twice.
    if (this.#rules.hideSpam && event.kind === 'chat' && normalised.length > 0) {
      const key = `${handle}\u0000${normalised}`;
      const last = this.#recent.get(key);
      this.#recent.set(key, event.at);
      if (this.#recent.size >= 512) {
        for (const [k, at] of this.#recent)
          if (event.at - at > this.#rules.spamWindowMs) this.#recent.delete(k);
      }
      if (last !== undefined && event.at - last < this.#rules.spamWindowMs) {
        return { blocked: true, reason: 'spam', alert: false };
      }
    }
    return { blocked: false, alert: this.#alertRe?.test(normalised) ?? false };
  }

  reset(): void {
    this.#recent.clear();
  }

  #compile(): void {
    this.#blockedRe = compileWordList(this.#rules.blockedWords);
    this.#alertRe = compileWordList(this.#rules.alertKeywords);
    this.#blockedUsers = new Set(
      this.#rules.blockedUsers.map((u) => u.trim().replace(/^@/, '').toLowerCase()),
    );
  }
}
