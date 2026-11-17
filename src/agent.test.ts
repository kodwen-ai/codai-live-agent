import { describe, expect, it, vi } from 'vitest';

import { LiveAgent } from './agent.js';
import { InMemoryStore } from './memory.js';
import { sseFetch } from './test-helpers.js';

const KEY = 'sk-agent-test-key';

function event(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'chat',
    at: 1000,
    user: { id: 'ana', name: 'Ana' },
    text: 'codai, what game is this?',
    ...patch,
  };
}

describe('LiveAgent', () => {
  it('auto mode: chat question -> streamed AI reply spoken sentence by sentence', async () => {
    const spoken: string[] = [];
    const agent = new LiveAgent(
      { llm: { model: 'codai-fast' }, replyMode: 'auto', extractFacts: false, coach: false },
      {
        apiKey: KEY,
        fetch: sseFetch(['It is Minecraft. ', 'Enjoy!']),
        now: () => 1000,
        speak: async (s) => {
          spoken.push(s);
        },
      },
    );
    agent.startSession('s1');
    const decision = await agent.handle(event('e1'));
    expect(decision.routes).toEqual(['ai']);
    await agent.idle();
    expect(spoken).toEqual(['It is Minecraft.', 'Enjoy!']);
    expect(agent.queue.snapshot()[0]?.status).toBe('done');
    await agent.dispose();
  });

  it('approve mode: draft waits, approve(id, edited) speaks the edited text', async () => {
    const spoken: string[] = [];
    const agent = new LiveAgent(
      { llm: { model: 'codai-fast' }, extractFacts: false, coach: false },
      {
        apiKey: KEY,
        fetch: sseFetch(['Model text.']),
        now: () => 1000,
        speak: async (s) => void spoken.push(s),
      },
    );
    agent.startSession('s1');
    await agent.handle(event('e1'));
    await agent.idle();
    const entry = agent.queue.snapshot()[0]!;
    expect(entry).toMatchObject({ status: 'ready', approved: false, draft: 'Model text.' });
    expect(spoken).toEqual([]);
    agent.approve(entry.id, 'Edited by the streamer.');
    await agent.idle();
    expect(spoken).toEqual(['Edited by the streamer.']);
  });

  it('moderation hook drops events before memory and scoring; alerts are surfaced', async () => {
    const store = new InMemoryStore();
    const onAlert = vi.fn();
    const agent = new LiveAgent(
      {
        llm: { model: 'm' },
        moderation: { blockedWords: ['scam'], alertKeywords: ['urgent'] },
        coach: false,
      },
      { apiKey: KEY, fetch: sseFetch([]), store, onAlert },
    );
    agent.startSession('s1');
    expect((await agent.handle(event('e1', { text: 'free scam here' }))).routes).toEqual(['drop']);
    expect(store.size).toBe(0);
    await agent.handle(event('e2', { text: 'urgent question?' }));
    expect(onAlert).toHaveBeenCalledTimes(1);
    agent.pause();
    await agent.dispose();
  });

  it('a throwing custom moderation hook fails closed', async () => {
    const onError = vi.fn();
    const agent = new LiveAgent(
      { llm: { model: 'm' }, coach: false },
      {
        apiKey: KEY,
        fetch: sseFetch([]),
        moderation: () => {
          throw new Error('classifier down');
        },
        onError,
      },
    );
    expect((await agent.handle(event('e1'))).routes).toEqual(['drop']);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'moderation');
  });

  it('gifts become thanks lines (no LLM) and returning viewers are greeted', async () => {
    const spoken: string[] = [];
    const store = new InMemoryStore();
    store.putViewer({
      id: 'ana',
      name: 'Ana',
      firstSeen: 0,
      lastSeen: 0,
      visits: 2,
      messages: 3,
      totalValue: 0,
      follower: false,
    });
    const fetchSpy = vi.fn(sseFetch(['ok.']));
    const agent = new LiveAgent(
      { llm: { model: 'm' }, aiReplies: false, coach: false },
      {
        apiKey: KEY,
        fetch: fetchSpy,
        store,
        now: () => 1000,
        speak: async (s) => void spoken.push(s),
      },
    );
    agent.startSession('s2');
    await agent.handle(event('e1', { text: 'hello again' }));
    await agent.handle(
      event('e2', { kind: 'gift', text: '', gift: { name: 'Rose', value: 1, count: 3 } }),
    );
    await agent.idle();
    expect(spoken).toEqual(['Welcome back, Ana!', 'Thank you so much, Ana, for the 3 Rose!']);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.getViewer('ana')?.visits).toBe(3);
  });

  it('rejects invalid events with a Zod error and requires a key or an llm', async () => {
    const agent = new LiveAgent({ llm: { model: 'm' } }, { apiKey: KEY, fetch: sseFetch([]) });
    await expect(agent.handle({ id: 'x', kind: 'raid' })).rejects.toThrow();
    expect(() => new LiveAgent({ llm: { model: 'm' } })).toThrow(/apiKey/);
  });

  it('token bucket limits AI drafts; skip refunds', async () => {
    let calls = 0;
    const base = sseFetch(['Answer.']);
    const counting = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      return base(...args);
    }) as typeof fetch;
    const agent = new LiveAgent(
      { llm: { model: 'm' }, repliesPerMinute: 0, burst: 1, extractFacts: false, coach: false },
      { apiKey: KEY, fetch: counting, now: () => 1000 },
    );
    agent.startSession('s1');
    await agent.handle(event('e1', { user: { id: 'a', name: 'A' } }));
    await agent.idle();
    await agent.handle(event('e2', { user: { id: 'b', name: 'B' }, text: 'codai, how are you?' }));
    await agent.idle();
    expect(calls).toBe(1);
    const drafted = agent.queue.snapshot().find((e) => e.userId === 'a')!;
    agent.skip(drafted.id);
    await agent.idle();
    expect(calls).toBe(2);
  });
});
