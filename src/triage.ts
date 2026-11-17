import type { LiveEvent } from './events.js';
import type { ModerationVerdict } from './moderation.js';
import type { ScoreResult } from './scorer.js';
import { passesReadFilters, type ReadAloudFilters } from './templates.js';

/**
 * Where an event goes. One event can take several routes (a gift is read
 * aloud AND scored; a chat question from a returning viewer is greeted AND
 * answered). Pure: the agent computes the inputs, triage only decides.
 */
export type Route = 'drop' | 'read' | 'thanks' | 'greeting' | 'ai';

export interface TriagePolicy {
  aiReplies: boolean;
  /** Below this a chat line is not worth an AI reply. */
  minAiScore: number;
  thankGifts: boolean;
  greetReturning: boolean;
  /** Greet viewers with at least this many previous visits. */
  greetMinVisits: number;
  readAloud: (ReadAloudFilters & { enabled: boolean }) | null;
  /** Do not read copy-paste duplicates aloud. */
  skipDuplicates: boolean;
}

export interface TriageInput {
  event: LiveEvent;
  verdict: ModerationVerdict;
  score: ScoreResult;
  /** First event from this viewer in the session. */
  firstThisSession: boolean;
  /** Visits BEFORE this session (0 for a new viewer). */
  previousVisits: number;
  duplicate: boolean;
  /** Template de-duplication windows, computed by the caller. */
  recentlyThanked: boolean;
  recentlyGreeted: boolean;
}

export interface TriageDecision {
  routes: Route[];
  /** Why the event was dropped or not answered, for logs/UI. */
  why: string[];
}

export function triage(input: TriageInput, policy: TriagePolicy): TriageDecision {
  const { event, verdict, score } = input;
  if (verdict.blocked)
    return { routes: ['drop'], why: [`moderation:${verdict.reason ?? 'blocked'}`] };

  const routes: Route[] = [];
  const why: string[] = [];

  const read = policy.readAloud;
  if (
    read?.enabled &&
    passesReadFilters(event, read) &&
    !(input.duplicate && policy.skipDuplicates)
  ) {
    routes.push('read');
  }

  // A gift that is already read aloud is thanked by that line; do not say it twice.
  if (event.kind === 'gift' && policy.thankGifts && !routes.includes('read')) {
    if (input.recentlyThanked) why.push('thanks:dedupe');
    else routes.push('thanks');
  }

  if (
    policy.greetReturning &&
    input.firstThisSession &&
    input.previousVisits >= policy.greetMinVisits &&
    event.kind !== 'gift'
  ) {
    if (input.recentlyGreeted) why.push('greeting:dedupe');
    else routes.push('greeting');
  }

  if (event.kind === 'chat') {
    if (!policy.aiReplies) why.push('ai:off');
    else if (score.excluded) why.push(`ai:${score.excluded}`);
    else if (score.score < policy.minAiScore) why.push('ai:low-score');
    else routes.push('ai');
  }

  return { routes, why };
}
