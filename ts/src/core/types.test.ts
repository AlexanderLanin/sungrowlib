import { describe, it, expect } from 'vitest';
import { ReadResult } from './types.js';
import type { RegisterValue } from './types.js';

function makeRV(name: string, value: RegisterValue['value']): RegisterValue {
  return {
    name, address: 0, type: 'read', dataType: 'U16',
    level: 1, raw: 0, value, supported: 'yes',
  };
}

function makeResult(...entries: RegisterValue[]): ReadResult {
  return new ReadResult(new Map(entries.map((v) => [v.name, v])), []);
}

describe('ReadResult.getString', () => {
  it('returns the string value', () => {
    expect(makeResult(makeRV('a', 'hello')).getString('a')).toBe('hello');
  });
  it('returns null for NA value', () => {
    expect(makeResult(makeRV('a', null)).getString('a')).toBeNull();
  });
  it('returns null when register not in result', () => {
    expect(makeResult().getString('missing')).toBeNull();
  });
  it('throws on type mismatch', () => {
    expect(() => makeResult(makeRV('a', 42)).getString('a')).toThrow("not a string register");
  });
});

describe('ReadResult.getNumber', () => {
  it('returns the number value', () => {
    expect(makeResult(makeRV('a', 42)).getNumber('a')).toBe(42);
  });
  it('returns null for NA value', () => {
    expect(makeResult(makeRV('a', null)).getNumber('a')).toBeNull();
  });
  it('returns null when register not in result', () => {
    expect(makeResult().getNumber('missing')).toBeNull();
  });
  it('throws on type mismatch', () => {
    expect(() => makeResult(makeRV('a', 'text')).getNumber('a')).toThrow("not a number register");
  });
});

describe('ReadResult.getBoolean', () => {
  it('returns the boolean value', () => {
    expect(makeResult(makeRV('a', true)).getBoolean('a')).toBe(true);
  });
  it('returns null for NA value', () => {
    expect(makeResult(makeRV('a', null)).getBoolean('a')).toBeNull();
  });
  it('returns null when register not in result', () => {
    expect(makeResult().getBoolean('missing')).toBeNull();
  });
  it('throws on type mismatch', () => {
    expect(() => makeResult(makeRV('a', 42)).getBoolean('a')).toThrow("not a boolean register");
  });
});

describe('ReadResult.getValue', () => {
  it('returns the raw DecodedValue', () => {
    expect(makeResult(makeRV('a', 99)).getValue('a')).toBe(99);
  });
  it('returns undefined when register not in result', () => {
    expect(makeResult().getValue('missing')).toBeUndefined();
  });
  it('returns null for NA value', () => {
    expect(makeResult(makeRV('a', null)).getValue('a')).toBeNull();
  });
});
