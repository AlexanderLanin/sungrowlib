import { describe, it, expect } from 'vitest';
import { decodeUtf8, decodeArray, applyMask, lookupDecoded, isUnsupported, decodeCatalogRegister, decodeRawScalar } from './decode.js';
import type { CatalogRegister } from '../core/types.js';

describe('decodeRawScalar', () => {
  it('decodes U16', () => expect(decodeRawScalar([100], 0, 'U16')).toBe(100));
  it('decodes S16 negative', () => expect(decodeRawScalar([0xFFFE], 0, 'S16')).toBe(-2));
  it('treats S16 0x7FFF as N/A', () => expect(decodeRawScalar([0x7FFF], 0, 'S16')).toBeNull());
  it('decodes S16 near max positive', () => expect(decodeRawScalar([0x7FFE], 0, 'S16')).toBe(32766));
  it('returns null for NA U16', () => expect(decodeRawScalar([0xFFFF], 0, 'U16')).toBeNull());
  it('decodes S16 0xFFFF as -1', () => expect(decodeRawScalar([0xFFFF], 0, 'S16')).toBe(-1));
  it('decodes U32 (little-endian)', () => expect(decodeRawScalar([2, 1], 0, 'U32')).toBe(65538));
  it('decodes S32 negative', () => expect(decodeRawScalar([0xFFFE, 0xFFFF], 0, 'S32')).toBe(-2));
  it('returns null for NA U32', () => expect(decodeRawScalar([0xFFFF, 0xFFFF], 0, 'U32')).toBeNull());
  it('decodes S32 0xFFFFFFFF as -1', () => expect(decodeRawScalar([0xFFFF, 0xFFFF], 0, 'S32')).toBe(-1));
  it('treats S32 0x7FFFFFFF as N/A', () => expect(decodeRawScalar([0xFFFF, 0x7FFF], 0, 'S32')).toBeNull());
  it('decodes S32 near max positive', () => expect(decodeRawScalar([0xFFFE, 0x7FFF], 0, 'S32')).toBe(0x7FFFFFFE));
  it('returns null for UTF-8', () => expect(decodeRawScalar([100], 0, 'UTF-8')).toBeNull());
  it('reads from offset', () => expect(decodeRawScalar([999, 42], 1, 'U16')).toBe(42));

  // From dump_master.yaml: export_power at 13010, S16
  it('dump: export_power [65134] → -402 W', () => {
    expect(decodeRawScalar([65134], 0, 'S16')).toBe(-402);
  });

  // From dump_master.yaml: load_power at 13008, S16
  it('dump: load_power [402] → 402 W', () => {
    expect(decodeRawScalar([402], 0, 'S16')).toBe(402);
  });

  // From dump_master.yaml: total_pv_generation at 13003-13004, U32
  it('dump: total_pv_generation [255, 0] → 255', () => {
    expect(decodeRawScalar([255, 0], 0, 'U32')).toBe(255);
  });
});

describe('decodeUtf8', () => {
  it('decodes ASCII from register words', () => {
    const data = [0x4142, 0x4344];
    expect(decodeUtf8(data, 0, 2)).toBe('ABCD');
  });

  it('strips trailing nulls', () => {
    const data = [0x4100, 0x0000];
    expect(decodeUtf8(data, 0, 2)).toBe('A');
  });

  it('returns null for all-NA', () => {
    expect(decodeUtf8([0xFFFF], 0, 1)).toBeNull();
  });

  it('decodes serial number style data', () => {
    const chars = 'A2350415770';
    const words: number[] = [];
    for (let i = 0; i < chars.length; i += 2) {
      const hi = chars.charCodeAt(i);
      const lo = i + 1 < chars.length ? chars.charCodeAt(i + 1) : 0;
      words.push((hi << 8) | lo);
    }
    expect(decodeUtf8(words, 0, words.length)).toBe('A2350415770');
  });
});

describe('decodeArray', () => {
  it('decodes U16 array', () => {
    const data = [100, 200, 300];
    expect(decodeArray(data, 0, 'U16', 3)).toEqual([100, 200, 300]);
  });

  it('applies scale to array', () => {
    const data = [10, 20, 30];
    const result = decodeArray(data, 0, 'U16', 3, 0.1);
    expect(result).toEqual([1, 2, 3]);
  });

  it('decodes U32 array (little-endian word order)', () => {
    const data = [100, 0, 200, 1];
    const result = decodeArray(data, 0, 'U32', 2);
    expect(result).toEqual([100, 65736]);
  });

  it('treats NA values as 0 in arrays', () => {
    const data = [0xFFFF, 100];
    const result = decodeArray(data, 0, 'U16', 2);
    expect(result).toEqual([0, 100]);
  });
});

describe('applyMask', () => {
  it('returns true when bit set', () => expect(applyMask(0b101, 4)).toBe(true));
  it('returns false when bit not set', () => expect(applyMask(0b101, 2)).toBe(false));
  it('battery charging mask=2 on state 6', () => expect(applyMask(6, 2)).toBe(true));
});

describe('lookupDecoded', () => {
  const table = { 0xAA: 'Enabled', 0x55: 'Disabled' };
  it('returns decoded string', () => expect(lookupDecoded(0xAA, table)).toBe('Enabled'));
  it('returns <unknown:N> if not in table', () => expect(lookupDecoded(99, table)).toBe('<unknown:99>'));
});

describe('isUnsupported', () => {
  it('returns true when value matches', () => expect(isUnsupported(0, 0)).toBe(true));
  it('returns false when value differs', () => expect(isUnsupported(100, 0)).toBe(false));
  it('returns false when unsupportedValue undefined', () => expect(isUnsupported(0, undefined)).toBe(false));
  it('handles null unsupportedValue', () => expect(isUnsupported(0, null)).toBe(false));
});

describe('decodeCatalogRegister', () => {
  const makeReg = (overrides: Partial<CatalogRegister>): CatalogRegister => ({
    name: 'test', address: 1000, type: 'read', baseDataType: 'U16',
    arrayLength: 1, registerWidth: 1, level: 3, ...overrides,
  });

  it('decodes simple U16', () => {
    const reg = makeReg({});
    const result = decodeCatalogRegister(reg, [42], 0);
    expect(result).toEqual({ raw: 42, value: 42, supported: 'yes' });
  });

  it('decodes with scale', () => {
    const reg = makeReg({ scale: 0.1 });
    const result = decodeCatalogRegister(reg, [500], 0);
    expect(result).toEqual({ raw: 500, value: 50, supported: 'yes' });
  });

  it('decodes with decoded map', () => {
    const reg = makeReg({ decoded: { 170: 'Enabled', 85: 'Disabled' } });
    const result = decodeCatalogRegister(reg, [170], 0);
    expect(result).toEqual({ raw: 170, value: 'Enabled', supported: 'yes' });
  });

  it('decodes with mask', () => {
    const reg = makeReg({ mask: 2 });
    const result = decodeCatalogRegister(reg, [6], 0);
    expect(result).toEqual({ raw: 6, value: true, supported: 'yes' });
  });

  it('marks unsupported', () => {
    const reg = makeReg({ unsupportedValue: 0 });
    const result = decodeCatalogRegister(reg, [0], 0);
    expect(result!.supported).toBe('not-applicable');
  });

  it('decodes UTF-8', () => {
    const reg = makeReg({ baseDataType: 'UTF-8', arrayLength: 2, registerWidth: 2 });
    const result = decodeCatalogRegister(reg, [0x4142, 0x4344], 0);
    expect(result!.value).toBe('ABCD');
  });

  it('decodes array', () => {
    const reg = makeReg({ arrayLength: 3, registerWidth: 3 });
    const result = decodeCatalogRegister(reg, [10, 20, 30], 0);
    expect(result!.value).toEqual([10, 20, 30]);
  });

  it('emits supported=false with raw word for NA sentinel', () => {
    const reg = makeReg({});
    expect(decodeCatalogRegister(reg, [0xFFFF], 0)).toEqual({ raw: 0xFFFF, value: null, supported: 'not-applicable' });
  });
});
