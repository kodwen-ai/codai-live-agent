import { describe, expect, it, vi } from 'vitest';

import { createMemoryHooks, InMemoryStore, type MemoryStore } from './memory.js';
import { ev } from './test-helpers.js';

describe('memory hooks', () => {
  it('counts a visit once per viewer per session and accumulates messages and gift value', async () => {
    const store = new InMemoryStore();
    const hooks = createMemoryHooks(store);
    hooks.startSession('s1');
    const first = await hooks.observe(ev({ text: 'hi' }), 's1');
    expect(first).toEqual({ before: null, firstThisSession: true });
    const second = await hooks.observe(
      ev({ kind: 'gift', gift: { name: 'Rose', value: 5, count: 2 } }),
      's1',
    );
    expect(second.firstThisSession).toBe(false);
    expect(second.before?.visits).toBe(1);
    expect(store.getViewer('ana')).toMatchObject({ visits: 1, messages: 1, totalValue: 10 });

    hooks.startSession('s2');
    const back = await hooks.observe(ev({ text: 'back again', at: 2_000_000 }), 's2');
    expect(back.firstThisSession).toBe(true);
    expect(store.getViewer('ana')).toMatchObject({ visits: 2, messages: 2, lastSeen: 2_000_000 });
  });

  it('replays and events outside a session write nothing', async () => {
    const store = new InMemoryStore();
    const hooks = createMemoryHooks(store);
    await hooks.observe(ev({ text: 'replayed', replay: true }), 's1');
    await hooks.observe(ev({ text: 'adhoc' }), null);
    expect(store.size).toBe(0);
  });

  it('remembers facts newest-first, de-duplicated and capped', async () => {
    const store = new InMemoryStore({ maxFactsPerViewer: 3 });
    const hooks = createMemoryHooks(store);
    await hooks.observe(ev({ text: 'hi' }), 's1');
    await hooks.remember('ana', ['lives in Cluj', 'has a cat'], 10);
    await hooks.remember('ana', ['plays guitar', 'lives in Cluj', 'works as a nurse'], 20);
    expect(store.getFacts('ana')).toHaveLength(3);
    expect(store.getFacts('ana')[0]).toBe('works as a nurse');
    expect(store.getFacts('ana')).not.toContain('has a cat');
    expect(await hooks.context('ana')).toMatchObject({ visits: 1, totalValue: 0 });
    expect(await hooks.context('nobody')).toBeNull();
  });

  it('fails open: a broken store reports the error and the event still flows', async () => {
    const onError = vi.fn();
    const broken: MemoryStore = {
      getViewer: () => Promise.reject(new Error('db down')),
      putViewer: () => undefined,
      getFacts: () => [],
      addFacts: () => Promise.reject(new Error('db down')),
    };
    const hooks = createMemoryHooks(broken, { onError });
    await expect(hooks.observe(ev({ text: 'hi' }), 's1')).resolves.toEqual({
      before: null,
      firstThisSession: true,
    });
    await expect(hooks.context('ana')).resolves.toBeNull();
    await expect(hooks.remember('ana', ['x y z'])).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(3);
  });
});
