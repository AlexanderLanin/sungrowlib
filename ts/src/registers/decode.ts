import type { CatalogDataType, CatalogRegister, DecodedValue, Support } from '../core/types.js';

const NA_U16 = 0xFFFF;
const NA_U32 = 0xFFFFFFFF;

export function decodeRawScalar(data: number[], offset: number, dataType: CatalogDataType): number | null {
  if (dataType === 'U16' || dataType === 'S16') {
    const raw = data[offset];
    if (raw === undefined) return null;
    if (dataType === 'S16') {
      if (raw === 0x7FFF) return null;
      if (raw > 0x7FFF) return raw - 0x10000;
    } else {
      if (raw === NA_U16) return null;
    }
    return raw;
  }
  if (dataType === 'U32' || dataType === 'S32') {
    const low = data[offset];
    const high = data[offset + 1];
    if (low === undefined || high === undefined) return null;
    const raw = high * 65536 + low;
    if (dataType === 'S32') {
      if (raw === 0x7FFFFFFF) return null;
      if (raw > 0x7FFFFFFF) return raw - 0x100000000;
    } else {
      if (raw === NA_U32) return null;
    }
    return raw;
  }
  return null;
}

export function decodeUtf8(data: number[], offset: number, regCount: number): string | null {
  const chars: string[] = [];
  for (let i = 0; i < regCount; i++) {
    const word = data[offset + i];
    if (word === undefined || word === NA_U16) break;
    chars.push(String.fromCharCode(word >> 8));
    chars.push(String.fromCharCode(word & 0xFF));
  }
  return chars.join('').replace(/\0+$/, '') || null;
}

export function decodeArray(
  data: number[],
  offset: number,
  baseType: CatalogDataType,
  count: number,
  scale?: number
): number[] | null {
  const wordsPer = (baseType === 'U32' || baseType === 'S32') ? 2 : 1;
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    const val = decodeRawScalar(data, offset + i * wordsPer, baseType);
    if (val === null) {
      result.push(0);
    } else {
      result.push(scale ? val * scale : val);
    }
  }
  return result;
}

export function applyMask(raw: number, mask: number): boolean {
  return (raw & mask) !== 0;
}

export function lookupDecoded(raw: number, table: Record<number, string>): string | number {
  return table[raw] ?? raw;
}

export function isUnsupported(raw: number, unsupportedValue: number | null | undefined): boolean {
  if (unsupportedValue === undefined) return false;
  return raw === unsupportedValue;
}

function extractRawWord(data: number[], offset: number, dataType: CatalogDataType): number | null {
  if (dataType === 'U16' || dataType === 'S16') {
    return data[offset] ?? null;
  }
  if (dataType === 'U32' || dataType === 'S32') {
    const low = data[offset];
    const high = data[offset + 1];
    if (low === undefined || high === undefined) return null;
    return high * 65536 + low;
  }
  return null;
}

export type DecodeResult = {
  raw: number | number[];
  value: DecodedValue;
  supported: Support;
};

export function decodeCatalogRegister(
  reg: CatalogRegister,
  data: number[],
  offset: number
): DecodeResult | null {
  if (reg.baseDataType === 'UTF-8') {
    const str = decodeUtf8(data, offset, reg.registerWidth);
    return str != null
      ? { raw: data.slice(offset, offset + reg.registerWidth), value: str, supported: 'yes' }
      : null;
  }

  if (reg.arrayLength > 1) {
    const arr = decodeArray(data, offset, reg.baseDataType, reg.arrayLength, reg.scale);
    if (!arr) return null;
    const rawArr = data.slice(offset, offset + reg.registerWidth);
    return { raw: rawArr, value: arr, supported: 'yes' };
  }

  const rawVal = decodeRawScalar(data, offset, reg.baseDataType);
  if (rawVal === null) {
    const rawWord = extractRawWord(data, offset, reg.baseDataType);
    if (rawWord === null) return null;
    return { raw: rawWord, value: null, supported: 'not-applicable' };
  }

  const supported: Support = isUnsupported(rawVal, reg.unsupportedValue) ? 'not-applicable' : 'yes';

  if (reg.mask != null) {
    return { raw: rawVal, value: applyMask(rawVal, reg.mask), supported };
  }

  if (reg.decoded) {
    return { raw: rawVal, value: lookupDecoded(rawVal, reg.decoded), supported };
  }

  const scaled = reg.scale ? rawVal * reg.scale : rawVal;
  return { raw: rawVal, value: scaled, supported };
}
