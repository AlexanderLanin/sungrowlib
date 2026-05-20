import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogRegister, CatalogDataType, RegisterType } from '../core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rawRegisters = JSON.parse(
  readFileSync(resolve(__dirname, '../../../registers/registers-sungrow.json'), 'utf-8'),
);

export interface RawJsonEntry {
  name: string;
  address?: number;
  data_type: string;
  level?: number;
  accuracy?: number;
  scale?: number;
  unit_of_measurement?: string;
  description?: string;
  group?: string | string[];
  indicator?: string;
  models?: string[];
  models_exclude?: string[];
  decoded?: Record<string, string>;
  mask?: number;
  unsupported_value?: number | null | string;
  params?: unknown;
}

export interface RawJson {
  read: RawJsonEntry[];
  hold: RawJsonEntry[];
}

const BASE_TYPES: Record<string, CatalogDataType> = {
  U16: 'U16', S16: 'S16', U32: 'U32', S32: 'S32', 'UTF-8': 'UTF-8',
};

function parseDataType(raw: string): { baseDataType: CatalogDataType; arrayLength: number; registerWidth: number } | null {
  const arrayMatch = raw.match(/^(.+)\[(\d+)\]$/);
  const baseStr = arrayMatch ? arrayMatch[1] : raw;
  const arrayLength = arrayMatch ? parseInt(arrayMatch[2], 10) : 1;

  const baseDataType = BASE_TYPES[baseStr];
  if (!baseDataType) return null;

  const wordsPer = (baseDataType === 'U32' || baseDataType === 'S32') ? 2 : 1;
  return { baseDataType, arrayLength, registerWidth: arrayLength * wordsPer };
}

export function fnmatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}

function matchesModelList(model: string, patterns: string[]): boolean {
  return patterns.some((p) => fnmatch(model, p));
}

const MODEL_OVERRIDES: Record<string, Record<string, Partial<Pick<CatalogRegister, 'baseDataType' | 'registerWidth'>>>> = {
  'SH8.0RT-20': {
    load_power: { baseDataType: 'S16', registerWidth: 1 },
    export_power: { baseDataType: 'S16', registerWidth: 1 },
  },
};

function parseEntries(entries: RawJsonEntry[], type: RegisterType): CatalogRegister[] {
  const result: CatalogRegister[] = [];
  const seenNames = new Set<string>();

  for (const entry of entries) {
    if (entry.address == null) continue;
    if (entry.params != null) continue;

    const dt = parseDataType(entry.data_type);
    if (!dt) continue;

    let name = entry.name;
    while (seenNames.has(name)) {
      name += '_';
    }
    seenNames.add(name);

    let decoded: Record<number, string> | undefined;
    if (entry.decoded) {
      decoded = {};
      for (const [k, v] of Object.entries(entry.decoded)) {
        decoded[parseInt(k, 10)] = v;
      }
    }

    const scale = entry.accuracy ?? entry.scale;
    const rawUnsupported = entry.unsupported_value;
    const unsupportedValue: number | null | undefined =
      rawUnsupported === 'None' ? null
      : typeof rawUnsupported === 'number' ? rawUnsupported
      : rawUnsupported === null ? null
      : undefined;

    const reg: CatalogRegister = {
      name,
      address: entry.address,
      type,
      baseDataType: dt.baseDataType,
      arrayLength: dt.arrayLength,
      registerWidth: dt.registerWidth,
      level: entry.level ?? 5,
      ...(scale != null && { scale }),
      ...(entry.unit_of_measurement && { unit: entry.unit_of_measurement }),
      ...(entry.description && { description: entry.description }),
      ...(entry.group && { group: entry.group }),
      ...(entry.indicator && { indicator: entry.indicator }),
      ...(entry.models && { models: entry.models }),
      ...(entry.models_exclude && { modelsExclude: entry.models_exclude }),
      ...(decoded && { decoded }),
      ...(entry.mask != null && { mask: entry.mask }),
      ...(unsupportedValue !== undefined && { unsupportedValue }),
    };

    result.push(reg);
  }

  return result;
}

/** Parsed register catalog with model/group/level filtering. */
export class RegisterCatalog {
  private readonly registers: CatalogRegister[];
  private readonly byName: Map<string, CatalogRegister>;

  constructor(registers: CatalogRegister[]) {
    this.registers = registers;
    this.byName = new Map(registers.map((r) => [r.name, r]));
  }

  getAll(): CatalogRegister[] {
    return this.registers;
  }

  getByName(name: string): CatalogRegister | undefined {
    return this.byName.get(name);
  }

  filterByModel(model: string): CatalogRegister[] {
    return this.registers.filter((r) => {
      if (r.modelsExclude && matchesModelList(model, r.modelsExclude)) return false;
      if (r.models && !matchesModelList(model, r.models)) return false;
      return true;
    });
  }

  filterByLevel(registers: CatalogRegister[], maxLevel: number): CatalogRegister[] {
    return registers.filter((r) => r.level <= maxLevel);
  }

  getGroupIndicators(): CatalogRegister[] {
    return this.registers.filter((r) => r.indicator != null);
  }

  filterByGroups(registers: CatalogRegister[], activeGroups: Record<string, boolean>): CatalogRegister[] {
    return registers.filter((r) => {
      if (!r.group) return true;
      const groups = Array.isArray(r.group) ? r.group : [r.group];
      return groups.every((g) => activeGroups[g] === true);
    });
  }

  applyModelOverrides(registers: CatalogRegister[], model: string): CatalogRegister[] {
    const overrides = MODEL_OVERRIDES[model];
    if (!overrides) return registers;

    return registers.map((r) => {
      const o = overrides[r.name];
      if (!o) return r;
      return { ...r, ...o };
    });
  }
}

/** Build a catalog from raw JSON register data. */
export function loadCatalogFromData(data: RawJson): RegisterCatalog {
  const reads = parseEntries(data.read, 'read');
  const holds = parseEntries(data.hold, 'hold');
  return new RegisterCatalog([...reads, ...holds]);
}

const defaultCatalog = loadCatalogFromData(rawRegisters as RawJson);

/** Load the built-in Sungrow register catalog (311 registers, cached). */
export function loadCatalog(): RegisterCatalog {
  return defaultCatalog;
}
