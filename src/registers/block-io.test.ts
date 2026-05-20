import { describe, it, expect, vi } from 'vitest';
import { computeBlocks, readBlock, decodeBlock, ProblematicRegisters, type BlockPlan } from './block-io.js';
import type { CatalogRegister } from '../core/types.js';
import type { Transport } from '../transport/transport.js';
import { ConnectionError, ModbusProtocolError, UnsupportedRegisterError } from '../core/errors.js';

function makeReg(overrides: Partial<CatalogRegister>): CatalogRegister {
  return {
    name: 'test', address: 1000, type: 'read', baseDataType: 'U16',
    arrayLength: 1, registerWidth: 1, level: 3, ...overrides,
  };
}

describe('computeBlocks', () => {
  it('coalesces adjacent registers into one block', () => {
    const regs = [
      makeReg({ name: 'a', address: 100, registerWidth: 1 }),
      makeReg({ name: 'b', address: 101, registerWidth: 1 }),
      makeReg({ name: 'c', address: 102, registerWidth: 2 }),
    ];
    const blocks = computeBlocks(regs);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].start).toBe(100);
    expect(blocks[0].length).toBe(4);
    expect(blocks[0].registers).toHaveLength(3);
  });

  it('bridges small gaps', () => {
    const regs = [
      makeReg({ name: 'a', address: 100, registerWidth: 1 }),
      makeReg({ name: 'b', address: 108, registerWidth: 1 }),
    ];
    const blocks = computeBlocks(regs);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].length).toBe(9);
  });

  it('splits at large gaps', () => {
    const regs = [
      makeReg({ name: 'a', address: 100, registerWidth: 1 }),
      makeReg({ name: 'b', address: 200, registerWidth: 1 }),
    ];
    const blocks = computeBlocks(regs);
    expect(blocks).toHaveLength(2);
  });

  it('splits blocks exceeding MAX_BLOCK_SIZE', () => {
    const regs = [
      makeReg({ name: 'a', address: 100, registerWidth: 1 }),
      makeReg({ name: 'b', address: 100 + 124, registerWidth: 1 }),
      makeReg({ name: 'c', address: 100 + 130, registerWidth: 1 }),
    ];
    const blocks = computeBlocks(regs);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const b of blocks) {
      expect(b.length).toBeLessThanOrEqual(125);
    }
  });

  it('separates read and hold registers', () => {
    const regs = [
      makeReg({ name: 'a', address: 100, type: 'read' }),
      makeReg({ name: 'b', address: 100, type: 'hold' }),
    ];
    const blocks = computeBlocks(regs);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).not.toBe(blocks[1].type);
  });

  it('handles array registers', () => {
    const regs = [
      makeReg({ name: 'arr', address: 6100, registerWidth: 96, arrayLength: 96 }),
    ];
    const blocks = computeBlocks(regs);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].length).toBe(96);
  });
});

function makeMockTransport(behavior: {
  readInput?: (start: number, count: number) => Promise<Map<number, number>>;
}): Transport {
  const defaultRead = async (start: number, count: number) => {
    const map = new Map<number, number>();
    for (let i = 0; i < count; i++) map.set(start + i, 0);
    return map;
  };
  return {
    connected: true,
    disconnect: vi.fn(async () => {}),
    setSlaveId: vi.fn(),
    readInputRegisters: vi.fn(behavior.readInput ?? defaultRead),
    readHoldingRegisters: vi.fn(defaultRead),
  };
}

const testBlock: BlockPlan = {
  type: 'read',
  start: 5000,
  length: 2,
  registers: [makeReg({ name: 'a', address: 5000 }), makeReg({ name: 'b', address: 5001 })],
};

describe('readBlock retry', () => {
  it('returns empty map on UnsupportedRegisterError', async () => {
    const transport = makeMockTransport({
      readInput: async () => { throw new UnsupportedRegisterError(5000, 2); },
    });
    const result = await readBlock(transport, testBlock);
    expect(result.size).toBe(0);
  });

  it('retries once on ModbusProtocolError then succeeds', async () => {
    let calls = 0;
    const transport = makeMockTransport({
      readInput: async (start, count) => {
        calls++;
        if (calls === 1) throw new ModbusProtocolError('slave failure');
        const map = new Map<number, number>();
        for (let i = 0; i < count; i++) map.set(start + i, 42);
        return map;
      },
    });
    const result = await readBlock(transport, testBlock);
    expect(calls).toBe(2);
    expect(result.get(5000)).toBe(42);
  });

  it('retries with reconnect on ConnectionError', async () => {
    let calls = 0;
    const transport = makeMockTransport({
      readInput: async () => {
        calls++;
        if (calls <= 2) throw new ConnectionError('lost');
        const map = new Map<number, number>();
        map.set(5000, 99); map.set(5001, 99);
        return map;
      },
    });
    const freshTransport = makeMockTransport({
      readInput: async (start, count) => {
        const map = new Map<number, number>();
        for (let i = 0; i < count; i++) map.set(start + i, 99);
        return map;
      },
    });
    const reconnect = vi.fn(async () => freshTransport);

    const result = await readBlock(transport, testBlock, { reconnect });
    expect(reconnect).toHaveBeenCalled();
    expect(result.get(5000)).toBe(99);
  });

  it('throws after max retries exhausted', async () => {
    const transport = makeMockTransport({
      readInput: async () => { throw new ConnectionError('always fails'); },
    });
    await expect(readBlock(transport, testBlock, { maxRetries: 0 }))
      .rejects.toBeInstanceOf(ConnectionError);
  });
});

describe('readBlock onRetry callback', () => {
  it('calls onRetry on ModbusProtocolError free retry', async () => {
    let calls = 0;
    const transport = makeMockTransport({
      readInput: async (start, count) => {
        calls++;
        if (calls === 1) throw new ModbusProtocolError('slave failure');
        const map = new Map<number, number>();
        for (let i = 0; i < count; i++) map.set(start + i, 0);
        return map;
      },
    });
    const onRetry = vi.fn();
    await readBlock(transport, testBlock, { onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry on ConnectionError with reconnect', async () => {
    let calls = 0;
    const transport = makeMockTransport({
      readInput: async () => {
        calls++;
        if (calls === 1) throw new ConnectionError('lost');
        const map = new Map<number, number>();
        map.set(5000, 1); map.set(5001, 1);
        return map;
      },
    });
    const onRetry = vi.fn();
    await readBlock(transport, testBlock, { reconnect: async () => transport, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not call onRetry on immediate success', async () => {
    const transport = makeMockTransport({});
    const onRetry = vi.fn();
    await readBlock(transport, testBlock, { onRetry });
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe('ProblematicRegisters', () => {
  it('splits blocks around problematic addresses', () => {
    const p = new ProblematicRegisters();
    p.mark('read', 105, 3);

    const regs = [
      makeReg({ name: 'a', address: 100, registerWidth: 1 }),
      makeReg({ name: 'b', address: 104, registerWidth: 1 }),
      makeReg({ name: 'c', address: 108, registerWidth: 1 }),
    ];
    const blocks = computeBlocks(regs, p);
    expect(blocks.length).toBe(2);
    expect(blocks[0].registers.map((r) => r.name)).toEqual(['a', 'b']);
    expect(blocks[1].registers.map((r) => r.name)).toEqual(['c']);
  });

  it('does not split when no problematic addresses in gap', () => {
    const p = new ProblematicRegisters();
    p.mark('read', 200, 1);

    const regs = [
      makeReg({ name: 'a', address: 100, registerWidth: 1 }),
      makeReg({ name: 'b', address: 105, registerWidth: 1 }),
    ];
    const blocks = computeBlocks(regs, p);
    expect(blocks.length).toBe(1);
  });

  it('tracks size', () => {
    const p = new ProblematicRegisters();
    expect(p.size).toBe(0);
    p.mark('read', 100, 3);
    expect(p.size).toBe(3);
    p.clear();
    expect(p.size).toBe(0);
  });
});

describe('decodeBlock', () => {
  it('propagates indicator', () => {
    const block: BlockPlan = {
      type: 'read', start: 5000, length: 1,
      registers: [makeReg({ name: 'ind', address: 5000, group: 'has_battery', indicator: 'has_battery' })],
    };
    const values = decodeBlock(block, new Map([[5000, 42]]));
    expect(values).toHaveLength(1);
    expect(values[0].indicator).toBe('has_battery');
  });

  it('propagates array group', () => {
    const block: BlockPlan = {
      type: 'read', start: 5000, length: 1,
      registers: [makeReg({ name: 'recv', address: 5000, group: ['has_battery', 'direct_lan'] })],
    };
    const values = decodeBlock(block, new Map([[5000, 42]]));
    expect(values).toHaveLength(1);
    expect(values[0].group).toEqual(['has_battery', 'direct_lan']);
  });

  it('omits indicator when not set', () => {
    const block: BlockPlan = {
      type: 'read', start: 5000, length: 1,
      registers: [makeReg({ name: 'plain', address: 5000 })],
    };
    const values = decodeBlock(block, new Map([[5000, 42]]));
    expect(values).toHaveLength(1);
    expect(values[0].indicator).toBeUndefined();
  });
});
