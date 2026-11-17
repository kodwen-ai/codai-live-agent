import { describe, expect, it } from 'vitest';

import { triage, type TriageInput, type TriagePolicy } from './triage.js';
import { ev } from './test-helpers.js';

const policy = (patch: Partial<TriagePolicy> = {}): TriagePolicy => ({
  aiReplies: true,
  minAiScore: 2,
  thankGifts: true,
  greetReturning: true,
  greetMinVisits: 1,
  readAloud: null,
  skipDuplicates: true,
  ...patch,
});

const input = (patch: Partial<TriageInput> = {}): TriageInput => ({
  event: ev({ text: 'what game is this?' }),
  verdict: { blocked: false, alert: false },
  score: { score: 4, reasons: ['question'] },
  firstThisSession: false,
  previousVisits: 0,
  duplicate: false,
  recentlyThanked: false,
  recentlyGreeted: false,
  ...patch,
});

describe('triage', () => {
  it('drops moderated events and nothing else happens', () => {
    expect(
      triage(input({ verdict: { blocked: true, reason: 'word', alert: false } }), policy()),
    ).toEqual({
      routes: ['drop'],
      why: ['moderation:word'],
    });
  });

  it('routes a good chat line to the AI responder', () => {
    expect(triage(input(), policy()).routes).toEqual(['ai']);
  });

  it('does not answer low-score, excluded or AI-off chat, and says why', () => {
    expect(triage(input({ score: { score: 1, reasons: [] } }), policy()).why).toContain(
      'ai:low-score',
    );
    expect(
      triage(input({ score: { score: 0, reasons: [], excluded: 'duplicate' } }), policy()).why,
    ).toContain('ai:duplicate');
    expect(triage(input(), policy({ aiReplies: false })).why).toContain('ai:off');
  });

  it('thanks gifts once per window and not when the gift is already read aloud', () => {
    const gift = ev({ kind: 'gift', gift: { name: 'Rose', value: 1, count: 1 } });
    expect(triage(input({ event: gift }), policy()).routes).toEqual(['thanks']);
    expect(triage(input({ event: gift, recentlyThanked: true }), policy()).why).toContain(
      'thanks:dedupe',
    );
    const readAll = policy({
      readAloud: { enabled: true, kinds: { gift: true }, minGiftValue: 0, readNames: true },
    });
    expect(triage(input({ event: gift }), readAll).routes).toEqual(['read']);
  });

  it('greets a returning viewer on their first event of the session, in addition to answering', () => {
    const d = triage(input({ firstThisSession: true, previousVisits: 3 }), policy());
    expect(d.routes).toEqual(['greeting', 'ai']);
    expect(triage(input({ firstThisSession: true, previousVisits: 0 }), policy()).routes).toEqual([
      'ai',
    ]);
  });

  it('read-aloud respects kind filters, min gift value and duplicate skipping', () => {
    const read = policy({
      readAloud: {
        enabled: true,
        kinds: { chat: true, gift: true },
        minGiftValue: 10,
        readNames: true,
      },
    });
    expect(triage(input(), read).routes).toEqual(['read', 'ai']);
    expect(triage(input({ duplicate: true }), read).routes).toEqual(['ai']);
    const cheap = ev({ kind: 'gift', gift: { name: 'Rose', value: 1, count: 1 } });
    expect(triage(input({ event: cheap }), read).routes).toEqual(['thanks']);
    expect(triage(input({ event: ev({ kind: 'join' }) }), read).routes).toEqual([]);
  });
});
