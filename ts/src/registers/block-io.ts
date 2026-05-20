import type { CatalogRegister, RegisterValue, RegisterType } from '../core/types.js';
import type { Transport } from '../transport/transport.js';
import { decodeCatalogRegister } from './decode.js';
import { ConnectionError, ModbusProtocolError, UnsupportedRegisterError } from '../core/errors.js';

const MAX_BLOCK_SIZE = 125;
const GAP_TOLERANCE = 10;

export class ProblematicRegisters {
  private readonly _addresses = new Map<RegisterType, Set<number>>();

  mark(type: RegisterType, start: number, count: number): void {
    if (!this._addresses.has(type)) this._addresses.set(type, new Set());
    const set = this._addresses.get(type)!;
    for (let i = start; i < start + count; i++) set.add(i);
  }

  isBlocked(type: RegisterType, address: number): boolean {
    return this._addresses.get(type)?.has(address) ?? false;
  }

  clear(): void {
    this._addresses.clear();
  }

  get size(): number {
    let total = 0;
    for (const set of this._addresses.values()) total += set.size;
    return total;
  }
}

export interface BlockPlan {
  type: RegisterType;
  start: number;
  length: number;
  registers: CatalogRegister[];
}

export function computeBlocks(registers: CatalogRegister[], problematic?: ProblematicRegisters): BlockPlan[] {
  const byType = new Map<RegisterType, CatalogRegister[]>();
  for (const reg of registers) {
    const list = byType.get(reg.type) ?? [];
    list.push(reg);
    byType.set(reg.type, list);
  }

  const blocks: BlockPlan[] = [];

  for (const [type, regs] of byType) {
    const sorted = [...regs].sort((a, b) => a.address - b.address);
    let current: BlockPlan | null = null;

    for (const reg of sorted) {
      const regEnd = reg.address + reg.registerWidth;

      if (!current) {
        current = { type, start: reg.address, length: reg.registerWidth, registers: [reg] };
        continue;
      }

      const currentEnd = current.start + current.length;
      const gap = reg.address - currentEnd;
      const newLength = regEnd - current.start;

      const hasBlocker = problematic ? hasProblematicInRange(problematic, type, currentEnd, reg.address) : false;

      if (!hasBlocker && gap <= GAP_TOLERANCE && newLength <= MAX_BLOCK_SIZE) {
        current.length = newLength;
        current.registers.push(reg);
      } else {
        blocks.push(current);
        current = { type, start: reg.address, length: reg.registerWidth, registers: [reg] };
      }
    }

    if (current) blocks.push(current);
  }

  const result: BlockPlan[] = [];
  for (const block of blocks) {
    if (block.length <= MAX_BLOCK_SIZE) {
      result.push(block);
    } else {
      splitBlock(block, result);
    }
  }

  return result;
}

function hasProblematicInRange(p: ProblematicRegisters, type: RegisterType, from: number, to: number): boolean {
  for (let addr = from; addr < to; addr++) {
    if (p.isBlocked(type, addr)) return true;
  }
  return false;
}

function splitBlock(block: BlockPlan, out: BlockPlan[]): void {
  let current: BlockPlan = { type: block.type, start: block.start, length: 0, registers: [] };

  for (const reg of block.registers) {
    const regEnd = reg.address + reg.registerWidth;

    if (current.registers.length === 0) {
      current.start = reg.address;
      current.length = reg.registerWidth;
      current.registers.push(reg);
      continue;
    }

    const newLength = regEnd - current.start;
    if (newLength <= MAX_BLOCK_SIZE) {
      current.length = newLength;
      current.registers.push(reg);
    } else {
      out.push(current);
      current = { type: block.type, start: reg.address, length: reg.registerWidth, registers: [reg] };
    }
  }

  if (current.registers.length > 0) out.push(current);
}

export interface ReadBlockOptions {
  maxRetries?: number;
  reconnect?: () => Promise<Transport>;
  onRetry?: () => void;
}

const DEFAULT_MAX_RETRIES = 4;

export async function readBlock(
  transport: Transport,
  block: BlockPlan,
  options?: ReadBlockOptions,
): Promise<Map<number, number>> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  let t = transport;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return block.type === 'hold'
        ? await t.readHoldingRegisters(block.start, block.length)
        : await t.readInputRegisters(block.start, block.length);
    } catch (err) {
      lastError = err;

      if (err instanceof UnsupportedRegisterError) {
        return new Map<number, number>();
      }

      if (err instanceof ModbusProtocolError && attempt === 0) {
        options?.onRetry?.();
        continue;
      }

      if (err instanceof ConnectionError && attempt < maxRetries && options?.reconnect) {
        options?.onRetry?.();
        t = await options.reconnect();
        continue;
      }

      throw err;
    }
  }

  throw lastError;
}

export function decodeBlock(block: BlockPlan, rawMap: Map<number, number>): RegisterValue[] {
  const values: RegisterValue[] = [];

  for (const reg of block.registers) {
    const data: number[] = [];
    for (let i = 0; i < reg.registerWidth; i++) {
      const v = rawMap.get(reg.address + i);
      if (v === undefined) break;
      data.push(v);
    }
    if (data.length < reg.registerWidth) continue;

    const result = decodeCatalogRegister(reg, data, 0);
    if (!result) continue;

    values.push({
      name: reg.name,
      address: reg.address,
      type: reg.type,
      dataType: reg.baseDataType,
      level: reg.level,
      ...(reg.group && { group: reg.group }),
      ...(reg.indicator && { indicator: reg.indicator }),
      ...(reg.unit && { unit: reg.unit }),
      raw: result.raw,
      value: result.value,
      supported: result.supported,
    });
  }

  return values;
}
