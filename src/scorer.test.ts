import { describe, expect, it } from 'vitest';

import {
  DuplicateTracker,
  decayed,
  isQuestion,
  mentions,
  scoreEvent,
  type ScoreContext,
} from './scorer.js';
import { compileWordList } from './text.js';
import { ev } from './test-helpers.js';

const ctx = (patch: Partial<ScoreContext> = {}): ScoreContext => ({
  personaName: 'codai',
  streamerHandle: 'dragos',
  firstThisSession: false,
  firstEver: false,
  duplicate: false,
  blocked: null,
  ...patch,
});

describe('isQuestion', () => {
  it('detects question marks and RO/EN openers, diacritic-insensitive', () => {
    expect(isQuestion('is this live?')).toBe(true);
    expect(isQuestion('Câți ani ai')).toBe(true);
    expect(isQuestion('how are you')).toBe(true);
    expect(isQuestion('nice stream')).toBe(false);
  });
});

describe('mentions', () => {
  it('matches the persona as a whole word and the streamer handle with @', () => {
    expect(mentions('hey Codai, salut', 'codai', 'dragos')).toBe(true);
    expect(mentions('codaimania', 'codai', 'dragos')).toBe(false);
    expect(mentions('@dragos hi', 'codai', 'dragos')).toBe(true);
  });
});

describe('scoreEvent', () => {
  it('ranks a question that mentions the persona above plain chat', () => {
    const plain = scoreEvent(ev({ text: 'nice stream today' }), ctx());
    const asked = scoreEvent(ev({ text: 'codai, what game is this?' }), ctx());
    expect(asked.score).toBeGreaterThan(plain.score);
    expect(asked.reasons).toEqual(expect.arrayContaining(['question', 'mention']));
  });

  it('excludes empty, blocked, duplicate chat and non-scored kinds', () => {
    expect(scoreEvent(ev({ text: '   ' }), ctx()).excluded).toBe('empty');
    expect(
      scoreEvent(ev({ text: 'buy cheap sp4m' }), ctx({ blocked: compileWordList(['spam']) }))
        .excluded,
    ).toBe('blocked');
    expect(scoreEvent(ev({ text: 'first' }), ctx({ duplicate: true })).excluded).toBe('duplicate');
    expect(scoreEvent(ev({ kind: 'like' }), ctx()).excluded).toBe('kind');
  });

  it('scores gifts logarithmically by total value', () => {
    const small = scoreEvent(
      ev({ kind: 'gift', gift: { name: 'Rose', value: 1, count: 1 } }),
      ctx(),
    );
    const big = scoreEvent(
      ev({ kind: 'gift', gift: { name: 'Lion', value: 100, count: 10 } }),
      ctx(),
    );
    expect(big.score).toBeGreaterThan(small.score);
    expect(big.score).toBeCloseTo(3 + 2 * Math.log10(1001), 1);
  });

  it('adds first-time and role bonuses', () => {
    const base = scoreEvent(ev({ text: 'hello there' }), ctx()).score;
    const first = scoreEvent(ev({ text: 'hello there' }), ctx({ firstEver: true })).score;
    const sub = scoreEvent(
      ev({ text: 'hello there', user: { id: 'x', name: 'X', isSubscriber: true } }),
      ctx(),
    ).score;
    expect(first - base).toBe(2);
    expect(sub - base).toBe(1);
  });
});

describe('decayed', () => {
  it('halves every half-life', () => {
    expect(decayed(8, 0, 30_000)).toBeCloseTo(4);
    expect(decayed(8, 0, 60_000)).toBeCloseTo(2);
    expect(decayed(8, 100, 50)).toBe(8);
  });
});

describe('DuplicateTracker', () => {
  it('flags repeats inside the window only, normalised', () => {
    const t = new DuplicateTracker(1000);
    expect(t.check('FIRST', 0)).toBe(false);
    expect(t.check('first ', 500)).toBe(true);
    expect(t.check('first', 2000)).toBe(false);
  });
});
