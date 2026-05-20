import { describe, it, expect } from 'vitest';
import { applyComputed, BUILTIN_COMPUTED, type ComputedRegister } from './computed.js';
import type { DecodedValue } from '../core/types.js';

describe('applyComputed', () => {
  it('adds computed value to the map', () => {
    const values = new Map<string, DecodedValue>([['a', 2], ['b', 3]]);
    const cr: ComputedRegister = {
      name: 'sum',
      dependencies: ['a', 'b'],
      compute(v) { return (v.get('a') as number) + (v.get('b') as number); },
    };
    applyComputed(values, [cr]);
    expect(values.get('sum')).toBe(5);
  });

  it('skips when a dependency is missing', () => {
    const values = new Map<string, DecodedValue>([['a', 2]]);
    const cr: ComputedRegister = {
      name: 'sum',
      dependencies: ['a', 'b'],
      compute() { return 99; },
    };
    applyComputed(values, [cr]);
    expect(values.has('sum')).toBe(false);
  });

  it('skips when compute returns undefined', () => {
    const values = new Map<string, DecodedValue>([['a', 2]]);
    const cr: ComputedRegister = {
      name: 'x',
      dependencies: ['a'],
      compute() { return undefined as unknown as DecodedValue; },
    };
    applyComputed(values, [cr]);
    expect(values.has('x')).toBe(false);
  });
});

describe('BUILTIN_COMPUTED — timestamp', () => {
  const timestampCR = BUILTIN_COMPUTED.find((c) => c.name === 'timestamp')!;

  it('synthesises ISO-like timestamp from 6 registers', () => {
    const values = new Map<string, DecodedValue>([
      ['year', 25], ['month', 3], ['day', 7],
      ['hour', 9], ['minute', 5], ['second', 2],
    ]);
    applyComputed(values, [timestampCR]);
    expect(values.get('timestamp')).toBe('2025-03-07 09:05:02');
  });

  it('handles full year values', () => {
    const values = new Map<string, DecodedValue>([
      ['year', 2026], ['month', 12], ['day', 31],
      ['hour', 23], ['minute', 59], ['second', 59],
    ]);
    applyComputed(values, [timestampCR]);
    expect(values.get('timestamp')).toBe('2026-12-31 23:59:59');
  });

  it('returns null for non-numeric values', () => {
    const values = new Map<string, DecodedValue>([
      ['year', 'bad'], ['month', 3], ['day', 7],
      ['hour', 9], ['minute', 5], ['second', 2],
    ]);
    applyComputed(values, [timestampCR]);
    expect(values.get('timestamp')).toBeNull();
  });
});

describe('BUILTIN_COMPUTED — alarm_timestamp', () => {
  const alarmCR = BUILTIN_COMPUTED.find((c) => c.name === 'alarm_timestamp')!;

  it('synthesises alarm timestamp when alarm code is non-zero', () => {
    const values = new Map<string, DecodedValue>([
      ['pid_alarm_code', 42],
      ['alarm_time_year', 25], ['alarm_time_month', 1], ['alarm_time_day', 15],
      ['alarm_time_hour', 14], ['alarm_time_minute', 30], ['alarm_time_second', 0],
    ]);
    applyComputed(values, [alarmCR]);
    expect(values.get('alarm_timestamp')).toBe('2025-01-15 14:30:00');
  });

  it('returns null when alarm code is 0', () => {
    const values = new Map<string, DecodedValue>([
      ['pid_alarm_code', 0],
      ['alarm_time_year', 25], ['alarm_time_month', 1], ['alarm_time_day', 15],
      ['alarm_time_hour', 14], ['alarm_time_minute', 30], ['alarm_time_second', 0],
    ]);
    applyComputed(values, [alarmCR]);
    expect(values.get('alarm_timestamp')).toBeNull();
  });

  it('returns null when alarm code is null', () => {
    const values = new Map<string, DecodedValue>([
      ['pid_alarm_code', null],
      ['alarm_time_year', 25], ['alarm_time_month', 1], ['alarm_time_day', 15],
      ['alarm_time_hour', 14], ['alarm_time_minute', 30], ['alarm_time_second', 0],
    ]);
    applyComputed(values, [alarmCR]);
    expect(values.get('alarm_timestamp')).toBeNull();
  });
});

describe('BUILTIN_COMPUTED — mppt power', () => {
  it('computes P = V × I for mppt_1', () => {
    const cr = BUILTIN_COMPUTED.find((c) => c.name === 'mppt_1_power')!;
    const values = new Map<string, DecodedValue>([
      ['mppt_1_voltage', 350.5],
      ['mppt_1_current', 8.2],
    ]);
    applyComputed(values, [cr]);
    expect(values.get('mppt_1_power')).toBeCloseTo(350.5 * 8.2);
  });

  it('returns null when voltage is not a number', () => {
    const cr = BUILTIN_COMPUTED.find((c) => c.name === 'mppt_2_power')!;
    const values = new Map<string, DecodedValue>([
      ['mppt_2_voltage', null],
      ['mppt_2_current', 5],
    ]);
    applyComputed(values, [cr]);
    expect(values.get('mppt_2_power')).toBeNull();
  });

  it('creates registers for mppt 1 through 12', () => {
    const mpptNames = BUILTIN_COMPUTED
      .filter((c) => c.name.startsWith('mppt_') && c.name.endsWith('_power'))
      .map((c) => c.name);
    expect(mpptNames).toHaveLength(12);
    for (let i = 1; i <= 12; i++) {
      expect(mpptNames).toContain(`mppt_${i}_power`);
    }
  });

  it('has unit W on all mppt power registers', () => {
    const mpptRegs = BUILTIN_COMPUTED.filter((c) => c.name.startsWith('mppt_') && c.name.endsWith('_power'));
    for (const cr of mpptRegs) {
      expect(cr.unit).toBe('W');
    }
  });
});
