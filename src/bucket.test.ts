import { describe, expect, it } from 'vitest';

import { TokenBucket } from './bucket.js';

describe('TokenBucket', () => {
  it('starts full at burst and refuses when empty', () => {
    const b = new TokenBucket(6, 2, 0);
    expect(b.tryTake(0)).toBe(true);
    expect(b.tryTake(0)).toBe(true);
    expect(b.tryTake(0)).toBe(false);
  });

  it('refills continuously at perMinute and caps at burst', () => {
    const b = new TokenBucket(6, 2, 0); // one token per 10 s
    b.tryTake(0);
    b.tryTake(0);
    expect(b.msUntilNext(0)).toBe(10_000);
    expect(b.tryTake(9_999)).toBe(false);
    expect(b.tryTake(10_000)).toBe(true);
    expect(b.available(1_000_000)).toBe(2);
  });

  it('refund returns a token without exceeding capacity', () => {
    const b = new TokenBucket(1, 1, 0);
    b.tryTake(0);
    b.refund(0);
    expect(b.tryTake(0)).toBe(true);
    b.refund(0);
    b.refund(0);
    expect(b.available(0)).toBe(1);
  });

  it('setRate keeps accrued tokens and rate 0 never refills', () => {
    const b = new TokenBucket(60, 1, 0);
    b.tryTake(0);
    b.setRate(0, 500);
    expect(b.available(500)).toBeCloseTo(0.5);
    expect(b.msUntilNext(10_000_000)).toBe(Number.POSITIVE_INFINITY);
  });
});
