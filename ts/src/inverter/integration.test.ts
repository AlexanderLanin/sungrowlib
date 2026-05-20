import { describe, it, expect, vi } from 'vitest';
import type { Transport } from '../transport/transport.js';
import type { DecodedValue } from '../core/types.js';
import { loadCatalog } from '../registers/catalog.js';
import { computeBlocks, readBlock, decodeBlock, ProblematicRegisters } from '../registers/block-io.js';
import { applyComputed, BUILTIN_COMPUTED } from '../registers/computed.js';
import { UnsupportedRegisterError, ModbusProtocolError } from '../core/errors.js';

function createTransportMock(
  inputData: Record<number, number>,
  holdingData: Record<number, number> = {},
): Transport {
  return {
    connected: true,
    disconnect: vi.fn(async () => {}),
    setSlaveId: vi.fn(),
    readInputRegisters: vi.fn(async (start: number, count: number) => {
      const map = new Map<number, number>();
      for (let i = 0; i < count; i++) {
        map.set(start + i, inputData[start + i] ?? 0);
      }
      return map;
    }),
    readHoldingRegisters: vi.fn(async (start: number, count: number) => {
      const map = new Map<number, number>();
      for (let i = 0; i < count; i++) {
        map.set(start + i, holdingData[start + i] ?? 0);
      }
      return map;
    }),
  };
}

async function runPipeline(
  transport: Transport,
  registerNames: string[],
  problematic?: ProblematicRegisters,
): Promise<Map<string, DecodedValue>> {
  const catalog = loadCatalog();
  const applicable = catalog.applyModelOverrides(
    catalog.filterByModel('SH8.0RT-20'),
    'SH8.0RT-20',
  );
  const nameSet = new Set(registerNames);
  const selected = applicable.filter((r) => nameSet.has(r.name));
  const blocks = computeBlocks(selected, problematic);

  const result = new Map<string, DecodedValue>();
  for (const block of blocks) {
    const rawMap = await readBlock(transport, block);
    for (const v of decodeBlock(block, rawMap)) {
      result.set(v.name, v.value);
    }
  }
  applyComputed(result, BUILTIN_COMPUTED);
  return result;
}

// Realistic raw register data from SH8.0RT-20 dumps
const INPUT_DATA: Record<number, number> = {
  // load_power S16 (overridden from S32) at 13008
  13008: 402,
  // export_power S16 (overridden from S32) at 13010
  13010: 65134, // -402 as unsigned 16-bit
  // total_pv_generation U32 at 13003–13004 (low word first)
  13003: 255, 13004: 0, // 255 × 0.1 = 25.5 kWh
  // battery_power_legacy U16 at 13022
  13022: 0,
  // battery_soc U16 at 13023 (×0.1)
  13023: 500, // 50.0%
  // mppt_1_voltage U16 at 5011 (×0.1)
  5011: 3200, // 320.0V
  // mppt_1_current U16 at 5012 (×0.1)
  5012: 85, // 8.5A
};

const HOLDING_DATA: Record<number, number> = {
  // year/month/day/hour/minute/second at hold 5000–5005
  5000: 25, // 2025
  5001: 6,
  5002: 15,
  5003: 14,
  5004: 30,
  5005: 45,
};

describe('integration: Transport → catalog → block-io → decode → computed', () => {

  it('decodes realistic register data through the full pipeline', async () => {
    const transport = createTransportMock(INPUT_DATA, HOLDING_DATA);

    const result = await runPipeline(transport, [
      'load_power', 'export_power', 'total_pv_generation',
      'battery_power', 'battery_soc',
      'year', 'month', 'day', 'hour', 'minute', 'second',
    ]);

    expect(result.get('load_power')).toBe(402);
    expect(result.get('export_power')).toBe(-402);
    expect(result.get('total_pv_generation')).toBeCloseTo(25.5);
    expect(result.get('battery_power')).toBe(0);
    expect(result.get('battery_soc')).toBeCloseTo(50.0);
    expect(result.get('timestamp')).toBe('2025-06-15 14:30:45');
  });

  it('model override changes S32 to S16 for load_power', async () => {
    const catalog = loadCatalog();

    const beforeOverride = catalog.filterByModel('SH8.0RT-20');
    const loadBefore = beforeOverride.find((r) => r.name === 'load_power')!;
    expect(loadBefore.baseDataType).toBe('S32');
    expect(loadBefore.registerWidth).toBe(2);

    const afterOverride = catalog.applyModelOverrides(beforeOverride, 'SH8.0RT-20');
    const loadAfter = afterOverride.find((r) => r.name === 'load_power')!;
    expect(loadAfter.baseDataType).toBe('S16');
    expect(loadAfter.registerWidth).toBe(1);

    const transport = createTransportMock(INPUT_DATA);
    const result = await runPipeline(transport, ['load_power']);
    expect(result.get('load_power')).toBe(402);
  });

  it('computes mppt_1_power from voltage and current through the pipeline', async () => {
    const transport = createTransportMock(INPUT_DATA);

    const result = await runPipeline(transport, [
      'mppt_1_voltage', 'mppt_1_current',
    ]);

    expect(result.get('mppt_1_voltage')).toBeCloseTo(320.0);
    expect(result.get('mppt_1_current')).toBeCloseTo(8.5);
    expect(result.get('mppt_1_power')).toBeCloseTo(320.0 * 8.5);
  });

  it('splits blocks around ProblematicRegisters and reads both parts', async () => {
    const transport = createTransportMock(INPUT_DATA);
    const problematic = new ProblematicRegisters();
    // load_power is at 13008, battery_power at 5214 — different address ranges.
    // Mark the gap as problematic so computeBlocks splits them into separate blocks.
    problematic.mark('read', 13009, 13);

    const catalog = loadCatalog();
    const applicable = catalog.applyModelOverrides(
      catalog.filterByModel('SH8.0RT-20'),
      'SH8.0RT-20',
    );
    const nameSet = new Set(['load_power', 'battery_power']);
    const selected = applicable.filter((r) => nameSet.has(r.name));
    const blocks = computeBlocks(selected, problematic);

    expect(blocks.length).toBe(2);

    const result = new Map<string, DecodedValue>();
    for (const block of blocks) {
      const rawMap = await readBlock(transport, block);
      for (const v of decodeBlock(block, rawMap)) {
        result.set(v.name, v.value);
      }
    }

    expect(result.get('load_power')).toBe(402);
    expect(result.get('battery_power')).toBe(0);
  });

  it('handles UnsupportedRegisterError gracefully — other blocks still produce results', async () => {
    let inputCallCount = 0;
    const transport: Transport = {
      connected: true,
      disconnect: vi.fn(async () => {}),
      setSlaveId: vi.fn(),
      readInputRegisters: vi.fn(async (start: number, count: number) => {
        inputCallCount++;
        // Fail for the block starting around 5011 (mppt registers)
        if (start <= 5012 && start + count > 5011) {
          throw new UnsupportedRegisterError(start, count);
        }
        const map = new Map<number, number>();
        for (let i = 0; i < count; i++) {
          map.set(start + i, INPUT_DATA[start + i] ?? 0);
        }
        return map;
      }),
      readHoldingRegisters: vi.fn(async (start: number, count: number) => {
        const map = new Map<number, number>();
        for (let i = 0; i < count; i++) {
          map.set(start + i, HOLDING_DATA[start + i] ?? 0);
        }
        return map;
      }),
    };

    const result = await runPipeline(transport, [
      'load_power', 'mppt_1_voltage', 'mppt_1_current',
    ]);

    expect(result.get('load_power')).toBe(402);
    expect(result.has('mppt_1_voltage')).toBe(false);
    expect(result.has('mppt_1_current')).toBe(false);
  });

  it('retries on ModbusProtocolError then succeeds', async () => {
    let callCount = 0;
    const transport: Transport = {
      connected: true,
      disconnect: vi.fn(async () => {}),
      setSlaveId: vi.fn(),
      readInputRegisters: vi.fn(async (start: number, count: number) => {
        callCount++;
        if (callCount === 1) {
          throw new ModbusProtocolError('slave failure');
        }
        const map = new Map<number, number>();
        for (let i = 0; i < count; i++) {
          map.set(start + i, INPUT_DATA[start + i] ?? 0);
        }
        return map;
      }),
      readHoldingRegisters: vi.fn(async () => new Map<number, number>()),
    };

    const result = await runPipeline(transport, ['load_power']);

    expect(callCount).toBe(2);
    expect(result.get('load_power')).toBe(402);
  });
});
