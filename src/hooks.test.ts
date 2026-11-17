import { describe, expect, it, vi } from 'vitest';

import { Coach } from './coach.js';
import { FactCollector, parseFacts } from './facts.js';
import { WordListModerator } from './moderation.js';
import { ev } from './test-helpers.js';
import { ok } from './result.js';

describe('WordListModerator', () => {
  it('blocks words (leetspeak-folded), users and per-user spam; flags alerts', () => {
    const m = new WordListModerator({
      blockedWords: ['scam'],
      blockedUsers: ['@troll'],
      alertKeywords: ['help'],
      spamWindowMs: 1000,
    });
    expect(m.evaluate(ev({ text: 'this is a sc4m' }))).toMatchObject({
      blocked: true,
      reason: 'word',
    });
    expect(m.evaluate(ev({ text: 'hi', userId: 'Troll' }))).toMatchObject({
      blocked: true,
      reason: 'user',
    });
    expect(m.evaluate(ev({ text: 'need help', at: 0 }))).toEqual({ blocked: false, alert: true });
    expect(m.evaluate(ev({ text: 'need help', at: 500 }))).toMatchObject({
      blocked: true,
      reason: 'spam',
    });
    expect(m.outputHook('a scam')).toBe(false);
    expect(m.outputHook('all good')).toBe(true);
  });
});

describe('Coach', () => {
  it('suggests answering an unanswered question after a minute, once, and respects the gap', () => {
    const emit = vi.fn();
    const coach = new Coach(emit, { language: 'en' });
    coach.start(0);
    coach.onEvent(ev({ text: 'what game?', at: 0, name: 'Ana' }), true);
    expect(coach.tick(30_000)).toBeNull();
    expect(coach.tick(60_000)).toMatchObject({ kind: 'unanswered', userId: 'ana' });
    expect(coach.tick(70_000)).toBeNull();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('suggests thanking gifts and nudges when chat goes quiet', () => {
    const coach = new Coach(() => undefined, { language: 'ro' });
    coach.start(0);
    coach.onEvent(
      ev({ kind: 'gift', at: 0, name: 'Ion', gift: { name: 'Rose', value: 1, count: 1 } }),
      false,
    );
    expect(coach.tick(20_000)?.text).toContain('Ion');
    expect(coach.tick(100_000)).toMatchObject({ kind: 'quiet' });
  });

  it('answered() clears the open question', () => {
    const coach = new Coach(() => undefined);
    coach.start(0);
    coach.onEvent(ev({ text: 'why?', at: 0 }), true);
    coach.answered('ana');
    expect(coach.tick(60_000)).toBeNull();
  });
});

describe('FactCollector', () => {
  it('parses only allowed ids and stores facts from one batched call', async () => {
    expect(
      parseFacts('noise {"ana":["lives in Cluj","x"],"eve":["hacker"]} tail', new Set(['ana'])),
    ).toEqual(new Map([['ana', ['lives in Cluj']]]));
    const complete = vi.fn(async () => ok('{"ana":["has a dog named Rex"]}'));
    const store = vi.fn();
    const fc = new FactCollector({ llm: { complete }, store, model: 'codai-fast' });
    fc.add({ userId: 'ana', userName: 'Ana', text: 'my dog Rex says hi to everyone' });
    fc.add({ userId: 'bob', userName: 'Bob', text: 'lol' });
    expect(fc.pending).toBe(1);
    expect(await fc.flush()).toBe(1);
    expect(store).toHaveBeenCalledWith('ana', ['has a dog named Rex']);
    expect(complete).toHaveBeenCalledTimes(1);
    fc.dispose();
  });
});
