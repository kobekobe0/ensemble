import { describe, expect, it } from 'vitest';
import { detectLimit, parseResetTime } from '../src/limits.js';

const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime(); // local noon

describe('detectLimit', () => {
  it.each([
    "You've hit your usage limit. Try again later.",
    'Error: 429 Too Many Requests',
    'rate_limit_error: Rate limit exceeded',
    'RESOURCE_EXHAUSTED: Quota exceeded',
    'Claude AI usage limit reached|1792659600',
    'Your limit resets at 3pm',
  ])('detects %s', (s) => {
    expect(detectLimit(s, NOW)).not.toBeNull();
  });

  it.each(['TypeError: x is undefined', 'exit code 1', 'Compiled 4290 modules', ''])('ignores %s', (s) => {
    expect(detectLimit(s, NOW)).toBeNull();
  });
});

describe('parseResetTime', () => {
  const at = (h: number, m = 0, dayOffset = 0) => {
    const d = new Date(NOW);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  it('absolute clock times', () => {
    expect(parseResetTime('limit resets at 3:00 PM', NOW)).toBe(at(15));
    expect(parseResetTime('resets 3pm (Europe/Berlin)', NOW)).toBe(at(15));
    expect(parseResetTime('try again at 15:30', NOW)).toBe(at(15, 30));
    expect(parseResetTime('resets at 9am', NOW)).toBe(at(9, 0, 1)); // already passed today → tomorrow
    expect(parseResetTime('resets at 12am', NOW)).toBe(at(0, 0, 1));
  });
  it('ISO timestamps', () => {
    expect(parseResetTime('reset at 2026-10-22T18:00:00Z', NOW)).toBe(Date.parse('2026-10-22T18:00:00Z'));
  });
  it('relative durations', () => {
    expect(parseResetTime('try again in 2 hours', NOW)).toBe(NOW + 2 * 3_600_000);
    expect(parseResetTime('Please retry in 45 minutes.', NOW)).toBe(NOW + 45 * 60_000);
    expect(parseResetTime('resets in 1h 30m', NOW)).toBe(NOW + 90 * 60_000);
    expect(parseResetTime('try again in 2 hours 15 minutes', NOW)).toBe(NOW + 135 * 60_000);
    expect(parseResetTime('retry in 37 seconds', NOW)).toBe(NOW + 37_000);
  });
  it('epoch / retry fields', () => {
    expect(parseResetTime('{"error":"rate limit","resetsAt":1792659600}', NOW)).toBe(1792659600_000);
    expect(parseResetTime('{"reset_at": 1792659600123}', NOW)).toBe(1792659600123);
    expect(parseResetTime('{"retry_after": 30}', NOW)).toBe(NOW + 30_000);
  });
  it('returns null when nothing matches', () => {
    expect(parseResetTime('usage limit reached', NOW)).toBeNull();
  });
});
