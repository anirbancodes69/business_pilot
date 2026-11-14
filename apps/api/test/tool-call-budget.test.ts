import { describe, expect, it } from 'vitest';
import { ToolCallBudget } from '../src/query/tool-call-budget';

describe('tool call budget', () => {
  it('allows exactly the limit per request and then refuses', () => {
    const now = 1_000;
    const b = new ToolCallBudget(() => now);
    const results = Array.from({ length: 8 }, () => b.take('req-1', 6, now + 120_000));
    expect(results).toEqual([true, true, true, true, true, true, false, false]);
  });

  it('counts each request separately', () => {
    const b = new ToolCallBudget(() => 1_000);
    expect(b.take('a', 1, 200_000)).toBe(true);
    expect(b.take('a', 1, 200_000)).toBe(false);
    expect(b.take('b', 1, 200_000)).toBe(true);
  });

  it('forgets a request once its context has expired', () => {
    let now = 1_000;
    const b = new ToolCallBudget(() => now);
    b.take('a', 1, 5_000);
    expect(b.take('a', 1, 5_000)).toBe(false);
    now = 6_000;
    expect(b.take('a', 1, 10_000)).toBe(true); // a new window, not a leak
  });
});
