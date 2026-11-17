import { describe, expect, it, vi } from 'vitest';

import { ReplyQueue } from './queue.js';

function clock(start = 0) {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

describe('ReplyQueue', () => {
  it('approve mode holds AI drafts until approved; templates are pre-approved', () => {
    const c = clock();
    const q = new ReplyQueue({ mode: 'approve', now: c.now });
    const ai = q.add({ kind: 'ai', message: 'hi?', score: 5 })!;
    q.setStatus(ai.id, 'drafting');
    q.appendPart(ai.id, 'Hello Ana.');
    const thanks = q.add({ kind: 'thanks', message: '', text: 'Thanks Ana!', score: 3 })!;
    expect(q.get(ai.id)?.status).toBe('ready');
    expect(q.nextSpeakable()?.id).toBe(thanks.id);
    expect(q.approve(ai.id)).toBe(true);
    expect(q.nextSpeakable()?.id).toBe(ai.id);
  });

  it('auto mode approves AI entries on add and setMode(auto) approves waiting ones', () => {
    const q = new ReplyQueue({ mode: 'approve', now: () => 0 });
    const waiting = q.add({ kind: 'ai', message: 'a', score: 1 })!;
    expect(waiting.approved).toBe(false);
    q.setMode('auto');
    expect(q.get(waiting.id)?.approved).toBe(true);
    expect(q.add({ kind: 'ai', message: 'b', score: 1 })!.approved).toBe(true);
  });

  it('approve with text replaces the draft (edit + approve); edit alone does not approve', () => {
    const q = new ReplyQueue({ now: () => 0 });
    const a = q.add({ kind: 'ai', message: 'q', score: 2 })!;
    expect(q.edit(a.id, 'First. Second.')).toBe(true);
    expect(q.get(a.id)).toMatchObject({
      status: 'ready',
      approved: false,
      parts: ['First.', 'Second.'],
    });
    expect(q.approve(a.id, 'Only this.')).toBe(true);
    expect(q.get(a.id)).toMatchObject({
      approved: true,
      draft: 'Only this.',
      parts: ['Only this.'],
    });
  });

  it('skip finishes an active entry and refuses finished ones', () => {
    const q = new ReplyQueue({ now: () => 0 });
    const a = q.add({ kind: 'ai', message: 'q', score: 2 })!;
    expect(q.skip(a.id)).toBe(true);
    expect(q.get(a.id)?.status).toBe('skipped');
    expect(q.skip(a.id)).toBe(false);
  });

  it('when full, evicts the lowest pending entry only for a better newcomer', () => {
    const q = new ReplyQueue({ maxActive: 2, now: () => 0 });
    const low = q.add({ kind: 'ai', message: 'low', score: 1 })!;
    q.add({ kind: 'ai', message: 'mid', score: 3 });
    expect(q.add({ kind: 'ai', message: 'worse', score: 0.5 })).toBeNull();
    expect(q.add({ kind: 'ai', message: 'better', score: 5 })).not.toBeNull();
    expect(q.get(low.id)?.status).toBe('skipped');
    expect(q.activeCount()).toBe(2);
  });

  it('ranks pending by decayed score so a fresh question beats an old one', () => {
    const c = clock(0);
    const q = new ReplyQueue({ now: c.now });
    const old = q.add({ kind: 'ai', message: 'old', score: 6 })!;
    c.set(60_000); // two half-lives: 6 -> 1.5
    const fresh = q.add({ kind: 'ai', message: 'fresh', score: 2 })!;
    expect(q.topPending(new Set(['ai']))?.id).toBe(fresh.id);
    expect(old.id).not.toBe(fresh.id);
  });

  it('speaks part by part and finishes as done', () => {
    const q = new ReplyQueue({ now: () => 0 });
    const m = q.add({ kind: 'manual', message: '', text: 'One. Two.', score: 100 })!;
    expect(q.takePart(m.id)).toBe('One.');
    expect(q.get(m.id)?.status).toBe('speaking');
    q.partSpoken(m.id);
    expect(q.get(m.id)?.status).toBe('ready');
    expect(q.takePart(m.id)).toBe('Two.');
    q.partSpoken(m.id);
    expect(q.get(m.id)?.status).toBe('done');
  });

  it('expires unspoken entries past their TTL and notifies onChange', () => {
    const c = clock(0);
    const onChange = vi.fn();
    const q = new ReplyQueue({ now: c.now, onChange });
    const a = q.add({ kind: 'thanks', message: '', text: 'Thanks!', score: 3, ttlMs: 1000 })!;
    c.set(1001);
    expect(q.expire()).toBe(1);
    expect(q.get(a.id)?.status).toBe('skipped');
    expect(onChange).toHaveBeenCalled();
  });

  it('keeps only the newest finished entries', () => {
    const c = clock(0);
    const q = new ReplyQueue({ keepFinished: 2, now: c.now });
    for (let i = 0; i < 5; i += 1) {
      c.set(i);
      const e = q.add({ kind: 'ai', message: String(i), score: 1 })!;
      q.skip(e.id);
    }
    expect(q.snapshot().map((e) => e.message)).toEqual(['4', '3']);
  });
});
