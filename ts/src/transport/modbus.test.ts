import { describe, it, expect, vi } from 'vitest';
import type { ModbusClient } from './modbus.js';
import { readInputBlock, readHoldingBlock } from './modbus.js';

function createMockClient(
  inputRegisters: Record<number, number[]>,
  holdingRegisters: Record<number, number[]> = {}
): ModbusClient {
  return {
    connectTCP: vi.fn(),
    setID: vi.fn(),
    setTimeout: vi.fn(),
    close: vi.fn(),
    isOpen: true,
    readInputRegisters: vi.fn(async (addr: number, count: number) => {
      const result = inputRegisters[addr];
      if (!result) throw new Error(`No data at input address ${addr}`);
      return { data: result.slice(0, count) };
    }),
    readHoldingRegisters: vi.fn(async (addr: number, count: number) => {
      const result = holdingRegisters[addr];
      if (!result) throw new Error(`No data at holding address ${addr}`);
      return { data: result.slice(0, count) };
    }),
  };
}

describe('readInputBlock', () => {
  it('returns map keyed by 1-based Sungrow addresses', async () => {
    const client = createMockClient({ 12999: [64, 40, 0] });
    const map = await readInputBlock(client, 13000, 3);
    expect(map.get(13000)).toBe(64);
    expect(map.get(13001)).toBe(40);
    expect(map.get(13002)).toBe(0);
    expect(client.readInputRegisters).toHaveBeenCalledWith(12999, 3);
  });
});

describe('readHoldingBlock', () => {
  it('returns map with 1-based addresses and correct offset', async () => {
    const client = createMockClient({}, { 33499: [0xAA, 0xA0, 2] });
    const map = await readHoldingBlock(client, 33500, 3);
    expect(map.get(33500)).toBe(0xAA);
    expect(map.get(33501)).toBe(0xA0);
    expect(map.get(33502)).toBe(2);
    expect(client.readHoldingRegisters).toHaveBeenCalledWith(33499, 3);
  });
});
