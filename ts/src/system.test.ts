import { describe, it, expect, vi } from 'vitest';
import type { ModbusClient } from './transport/modbus.js';
import { SungrowSystem } from './system.js';
import type { ClientFactory } from './inverter/inverter.js';
import { ConnectionError } from './core/errors.js';
import type { ConnectionState } from './core/types.js';

// Register data extracted from dump_master.yaml and dump_slave.yaml

function encodeSerialWords(serial: string): Record<number, number> {
  const result: Record<number, number> = {};
  for (let i = 0; i < 10; i++) {
    const hi = i * 2 < serial.length ? serial.charCodeAt(i * 2) : 0;
    const lo = i * 2 + 1 < serial.length ? serial.charCodeAt(i * 2 + 1) : 0;
    result[4990 + i] = (hi << 8) | lo;
  }
  return result;
}

const SERIAL_WORDS = encodeSerialWords('A2350415770');

const MASTER_INPUT: Record<number, number> = {
  ...SERIAL_WORDS,
  4950: 1, 4951: 0,
  4952: 2, 4953: 0,
  4954: 3100,
  4969: 2800,
  5000: 0xE12,
  5001: 80,
  5002: 0,
  5011: 2310,
  5012: 42,
  5013: 2280,
  5014: 38,
  5017: 0, 5018: 0,
  5071: 1500,
  5601: 0,
  13000: 64, 13001: 40, 13002: 0,
  13003: 255, 13004: 0,
  13008: 402,
  13010: 65134,
  13022: 0,
  13023: 0,
  13025: 210,
  13030: 65535,
  13037: 500, 13038: 0,
  13039: 100,
};

const MASTER_HOLDING: Record<number, number> = {
  33500: 170,
  33501: 160,
  33502: 2,
};

const SLAVE_INPUT: Record<number, number> = {
  5000: 0xE12,
  5017: 0, 5018: 0,
  13000: 8, 13001: 0, 13002: 0,
  13003: 273, 13004: 0,
  13008: 0, 13010: 0,
  13022: 0, 13023: 0, 13025: 0,
  13030: 65535,
};

const SLAVE_HOLDING: Record<number, number> = {
  33500: 170,
  33501: 161,
  33502: 2,
};

function createMockClientFromData(
  inputData: Record<number, number>,
  holdingData: Record<number, number>
): ModbusClient {
  return {
    connectTCP: vi.fn(),
    setID: vi.fn(),
    setTimeout: vi.fn(),
    close: vi.fn(),
    isOpen: true,
    readInputRegisters: vi.fn(async (addr: number, count: number) => {
      const data: number[] = [];
      const sungrowAddr = addr + 1;
      for (let i = 0; i < count; i++) {
        data.push(inputData[sungrowAddr + i] ?? 0);
      }
      return { data };
    }),
    readHoldingRegisters: vi.fn(async (addr: number, count: number) => {
      const data: number[] = [];
      const sungrowAddr = addr + 1;
      for (let i = 0; i < count; i++) {
        data.push(holdingData[sungrowAddr + i] ?? 0);
      }
      return { data };
    }),
  };
}

function mockClientFactory(
  inputData: Record<number, number>,
  holdingData: Record<number, number>
): ClientFactory {
  return async () => createMockClientFromData(inputData, holdingData);
}

const DASHBOARD_REGS = [
  'total_dc_power', 'load_power', 'export_power',
  'battery_power', 'battery_soc', 'battery_temperature',
  'daily_pv_generation', 'total_pv_generation', 'grid_state',
  'state_battery_charging', 'state_battery_discharging',
  'state_power_generated_from_pv', 'state_load_active',
  'state_feed_into_grid', 'state_import_from_grid',
] as const;

describe('SungrowSystem', () => {
  it('throws clear error when reading before connect', async () => {
    const sys = new SungrowSystem({
      hosts: ['localhost'],
      clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
    });
    await expect(sys.read()).rejects.toThrow('Not connected');
  });

  it('reads data in standalone mode', async () => {
    const holdingDisabled = { ...MASTER_HOLDING, 33500: 0x55 };
    const sys = new SungrowSystem({
      hosts: ['localhost'],
      clientFactory: mockClientFactory(MASTER_INPUT, holdingDisabled),
    });
    await sys.connect();
    const data = await sys.read({ names: DASHBOARD_REGS });

    expect(data.values.get('total_dc_power')?.value).toBe(0);
    expect(data.values.get('load_power')?.value).toBe(402);
    expect(data.values.get('export_power')?.value).toBe(-402);
    expect(sys.hasSlaves).toBe(false);
    await sys.disconnect();
  });

  it('sums PV across master and slave via readSlaves', async () => {
    const masterInput = { ...MASTER_INPUT, 5017: 3000, 5018: 0 };
    const slaveInput = { ...SLAVE_INPUT, 5017: 2000, 5018: 0 };

    const factory: ClientFactory = async (host: string) => {
      if (host === 'slave-host') {
        return createMockClientFromData(slaveInput, SLAVE_HOLDING);
      }
      return createMockClientFromData(masterInput, MASTER_HOLDING);
    };

    const sys = new SungrowSystem({
      hosts: ['localhost', 'slave-host'],
      clientFactory: factory,
    });
    await sys.connect();

    const masterData = await sys.read({ names: ['total_dc_power'] });
    let totalPv = masterData.values.get('total_dc_power')?.value as number | null;

    if (sys.hasSlaves) {
      const slaveResults = await sys.readSlaves({ names: ['total_dc_power'] });
      for (const slaveData of slaveResults) {
        const slavePv = slaveData.values.get('total_dc_power')?.value as number | null;
        if (totalPv != null && slavePv != null) {
          totalPv += slavePv;
        }
      }
    }

    expect(totalPv).toBe(5000);
    await sys.disconnect();
  });

  it('uses master PV only when slave read fails', async () => {
    const masterInput = { ...MASTER_INPUT, 5017: 3000, 5018: 0 };

    const factory: ClientFactory = async (host: string) => {
      if (host === 'slave-host') {
        const client = createMockClientFromData(SLAVE_INPUT, SLAVE_HOLDING);
        const origInputRead = client.readInputRegisters;
        let readCount = 0;
        client.readInputRegisters = vi.fn(async (addr, count) => {
          readCount++;
          if (readCount > 10) {
            throw new Error('Slave read failed');
          }
          return (origInputRead as typeof client.readInputRegisters)(addr, count);
        });
        return client;
      }
      return createMockClientFromData(masterInput, MASTER_HOLDING);
    };

    const sys = new SungrowSystem({
      hosts: ['localhost', 'slave-host'],
      clientFactory: factory,
    });
    await sys.connect();

    const masterData = await sys.read({ names: ['total_dc_power'] });
    let totalPv = masterData.values.get('total_dc_power')?.value as number | null;

    const slaveResults = await sys.readSlaves({ names: ['total_dc_power'] });
    for (const slaveData of slaveResults) {
      const slavePv = slaveData.values.get('total_dc_power')?.value as number | null;
      if (totalPv != null && slavePv != null) {
        totalPv += slavePv;
      }
    }

    expect(totalPv).toBe(3000);
    await sys.disconnect();
  });

  it('exposes model and activeGroups', async () => {
    const holdingDisabled = { ...MASTER_HOLDING, 33500: 0x55 };
    const sys = new SungrowSystem({
      hosts: ['localhost'],
      clientFactory: mockClientFactory(MASTER_INPUT, holdingDisabled),
    });
    await sys.connect();
    expect(sys.model).toBe('SH8.0RT-20');
    expect(typeof sys.activeGroups).toBe('object');
    await sys.disconnect();
  });

  it('exposes lastRawWords and lastValues after read', async () => {
    const holdingDisabled = { ...MASTER_HOLDING, 33500: 0x55 };
    const sys = new SungrowSystem({
      hosts: ['localhost'],
      clientFactory: mockClientFactory(MASTER_INPUT, holdingDisabled),
    });
    await sys.connect();
    await sys.read({ maxLevel: 3 });
    expect(Object.keys(sys.lastRawWords).length).toBeGreaterThan(0);
    expect(sys.lastValues.length).toBeGreaterThan(0);
    await sys.disconnect();
  });

  describe('auto-discovery', () => {
    it('detects master automatically when slave is listed first', async () => {
      const factory: ClientFactory = async (host: string) => {
        if (host === 'slave-host') {
          return createMockClientFromData(SLAVE_INPUT, SLAVE_HOLDING);
        }
        return createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
      };

      const sys = new SungrowSystem({
        hosts: ['slave-host', 'master-host'],
        clientFactory: factory,
      });
      await sys.connect();

      expect(sys.info?.connectionMode).toBe('master');
      expect(sys.hasSlaves).toBe(true);
      expect(sys.slaveDetails.length).toBe(1);
      expect(sys.slaveDetails[0].host).toBe('slave-host');
      await sys.disconnect();
    });

    it('throws when no master found among multiple hosts', async () => {
      const holdingDisabled = { ...MASTER_HOLDING, 33500: 0x55 };
      const factory: ClientFactory = async () => {
        return createMockClientFromData(MASTER_INPUT, holdingDisabled);
      };

      const sys = new SungrowSystem({
        hosts: ['host-a', 'host-b'],
        clientFactory: factory,
      });

      await expect(sys.connect()).rejects.toThrow('No master detected');
    });

    it('throws when multiple masters found', async () => {
      const factory: ClientFactory = async () => {
        return createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
      };

      const sys = new SungrowSystem({
        hosts: ['host-a', 'host-b'],
        clientFactory: factory,
      });

      await expect(sys.connect()).rejects.toThrow('Multiple masters detected');
    });

    it('skips unreachable hosts and still works', async () => {
      const logs: string[] = [];
      const factory: ClientFactory = async (host: string) => {
        if (host === 'dead-host') throw new Error('ECONNREFUSED');
        return createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
      };

      const sys = new SungrowSystem({
        hosts: ['dead-host', 'master-host'],
        clientFactory: factory,
        logger: (msg) => logs.push(msg),
      });
      await sys.connect();

      expect(sys.info?.connectionMode).toBe('master');
      expect(logs.some((l) => l.includes('dead-host') && l.includes('connect failed'))).toBe(true);
      await sys.disconnect();
    });

    it('supports per-host ports via host:port notation', async () => {
      const ports: number[] = [];
      const factory: ClientFactory = async (host: string, port: number) => {
        ports.push(port);
        if (host === 'slave-host') {
          return createMockClientFromData(SLAVE_INPUT, SLAVE_HOLDING);
        }
        return createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
      };

      const sys = new SungrowSystem({
        hosts: ['master-host:502', 'slave-host:8502'],
        clientFactory: factory,
      });
      await sys.connect();

      expect(ports).toContain(502);
      expect(ports).toContain(8502);
      expect(sys.hasSlaves).toBe(true);
      await sys.disconnect();
    });

    it('slaveDetails includes host and lastValues', async () => {
      const slaveInput = { ...SLAVE_INPUT, 5017: 2000, 5018: 0 };
      const factory: ClientFactory = async (host: string) => {
        if (host === 'slave-host') {
          return createMockClientFromData(slaveInput, SLAVE_HOLDING);
        }
        return createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
      };

      const sys = new SungrowSystem({
        hosts: ['master-host', 'slave-host'],
        clientFactory: factory,
      });
      await sys.connect();

      await sys.readSlaves({ names: ['total_dc_power'] });
      const details = sys.slaveDetails;
      expect(details.length).toBe(1);
      expect(details[0].host).toBe('slave-host');
      expect(details[0].lastValues.length).toBeGreaterThan(0);
      expect(typeof details[0].activeGroups).toBe('object');
      await sys.disconnect();
    });

    it('single host works regardless of role', async () => {
      const sys = new SungrowSystem({
        hosts: ['localhost'],
        clientFactory: mockClientFactory(SLAVE_INPUT, SLAVE_HOLDING),
      });
      await sys.connect();

      expect(sys.info?.connectionMode).toBe('slave');
      expect(sys.hasSlaves).toBe(false);
      await sys.disconnect();
    });

    it('throws on empty hosts array', () => {
      expect(() => new SungrowSystem({ hosts: [] })).toThrow('At least one host required');
    });
  });

  describe('connection lifecycle', () => {
    it('tracks state through connect/disconnect', async () => {
      const holdingDisabled = { ...MASTER_HOLDING, 33500: 0x55 };
      const sys = new SungrowSystem({
        hosts: ['localhost'],
        clientFactory: mockClientFactory(MASTER_INPUT, holdingDisabled),
      });
      expect(sys.state).toBe('idle');

      await sys.connect();
      expect(sys.state).toBe('connected');

      await sys.disconnect();
      expect(sys.state).toBe('disconnected');
    });

    it('connect is idempotent', async () => {
      const holdingDisabled = { ...MASTER_HOLDING, 33500: 0x55 };
      const sys = new SungrowSystem({
        hosts: ['localhost'],
        clientFactory: mockClientFactory(MASTER_INPUT, holdingDisabled),
      });
      await sys.connect();
      await sys.connect();
      expect(sys.state).toBe('connected');
      await sys.disconnect();
    });

    it('disconnect is idempotent', async () => {
      const sys = new SungrowSystem({
        hosts: ['localhost'],
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await sys.disconnect();
      expect(sys.state).toBe('idle');
    });

    it('fires onStateChange callback', async () => {
      const states: ConnectionState[] = [];
      const holdingDisabled = { ...MASTER_HOLDING, 33500: 0x55 };
      const sys = new SungrowSystem({
        hosts: ['localhost'],
        clientFactory: mockClientFactory(MASTER_INPUT, holdingDisabled),
        onStateChange: (s) => states.push(s),
      });

      await sys.connect();
      await sys.disconnect();
      expect(states).toEqual(['connected', 'disconnected']);
    });
  });

  describe('auto-reconnect', () => {
    // Shared flag checked at READ time (not client creation time), so existing
    // clients start/stop failing when the flag is flipped.
    function switchableFactory() {
      let failReads = false;
      let factoryCallCount = 0;
      const holdingDisabled = { ...MASTER_HOLDING, 33500: 0x55 };

      const factory: ClientFactory = async () => {
        factoryCallCount++;
        const base = createMockClientFromData(MASTER_INPUT, holdingDisabled);
        const origInput = base.readInputRegisters;
        const origHolding = base.readHoldingRegisters;
        base.readInputRegisters = vi.fn(async (addr: number, count: number) => {
          if (failReads) throw new ConnectionError('ECONNRESET');
          return (origInput as typeof base.readInputRegisters)(addr, count);
        });
        base.readHoldingRegisters = vi.fn(async (addr: number, count: number) => {
          if (failReads) throw new ConnectionError('ECONNRESET');
          return (origHolding as typeof base.readHoldingRegisters)(addr, count);
        });
        return base;
      };

      return {
        factory,
        startFailing() { failReads = true; },
        stopFailing() { failReads = false; },
        get callCount() { return factoryCallCount; },
      };
    }

    // Factory where reconnect attempts also fail (for testing maxAttempts)
    function permanentlyFailingFactory() {
      let failReads = false;
      let failConnect = false;
      let factoryCallCount = 0;
      const holdingDisabled = { ...MASTER_HOLDING, 33500: 0x55 };

      const factory: ClientFactory = async () => {
        factoryCallCount++;
        if (failConnect) throw new ConnectionError('ECONNREFUSED');
        const base = createMockClientFromData(MASTER_INPUT, holdingDisabled);
        const origInput = base.readInputRegisters;
        const origHolding = base.readHoldingRegisters;
        base.readInputRegisters = vi.fn(async (addr: number, count: number) => {
          if (failReads) throw new ConnectionError('ECONNRESET');
          return (origInput as typeof base.readInputRegisters)(addr, count);
        });
        base.readHoldingRegisters = vi.fn(async (addr: number, count: number) => {
          if (failReads) throw new ConnectionError('ECONNRESET');
          return (origHolding as typeof base.readHoldingRegisters)(addr, count);
        });
        return base;
      };

      return {
        factory,
        startFailing() { failReads = true; failConnect = true; },
        get callCount() { return factoryCallCount; },
      };
    }

    it('schedules reconnect on ConnectionError from read()', async () => {
      vi.useFakeTimers();
      const helper = switchableFactory();

      const states: ConnectionState[] = [];
      const sys = new SungrowSystem({
        hosts: ['localhost'],
        clientFactory: helper.factory,
        reconnect: { baseDelayMs: 100 },
        onStateChange: (s) => states.push(s),
      });

      await sys.connect();
      expect(sys.state).toBe('connected');

      helper.startFailing();
      await expect(sys.read({ names: DASHBOARD_REGS })).rejects.toThrow(ConnectionError);
      expect(sys.state).toBe('reconnecting');

      helper.stopFailing();
      await vi.advanceTimersByTimeAsync(150);
      expect(sys.state).toBe('connected');
      expect(states).toEqual(['connected', 'reconnecting', 'connected']);

      await sys.disconnect();
      vi.useRealTimers();
    });

    it('gives up after maxAttempts', async () => {
      vi.useFakeTimers();
      const helper = permanentlyFailingFactory();

      const states: ConnectionState[] = [];
      const sys = new SungrowSystem({
        hosts: ['localhost'],
        clientFactory: helper.factory,
        reconnect: { baseDelayMs: 100, maxAttempts: 2 },
        onStateChange: (s) => states.push(s),
      });

      await sys.connect();
      helper.startFailing();
      await expect(sys.read({ names: DASHBOARD_REGS })).rejects.toThrow(ConnectionError);

      // First attempt fails
      await vi.advanceTimersByTimeAsync(150);
      expect(sys.state).toBe('reconnecting');

      // Second attempt fails → disconnected
      await vi.advanceTimersByTimeAsync(250);
      expect(sys.state).toBe('disconnected');
      expect(states).toContain('disconnected');

      vi.useRealTimers();
    });

    it('read() during reconnecting throws ConnectionError', async () => {
      vi.useFakeTimers();
      const helper = switchableFactory();

      const sys = new SungrowSystem({
        hosts: ['localhost'],
        clientFactory: helper.factory,
        reconnect: { baseDelayMs: 1000 },
      });

      await sys.connect();
      helper.startFailing();
      await expect(sys.read({ names: DASHBOARD_REGS })).rejects.toThrow(ConnectionError);
      expect(sys.state).toBe('reconnecting');

      // read() during reconnecting should throw immediately
      await expect(sys.read({ names: DASHBOARD_REGS })).rejects.toThrow('Reconnecting');

      helper.stopFailing();
      await vi.advanceTimersByTimeAsync(1100);
      expect(sys.state).toBe('connected');
      await sys.disconnect();
      vi.useRealTimers();
    });

    it('disconnect cancels pending reconnect', async () => {
      vi.useFakeTimers();
      const helper = switchableFactory();

      const sys = new SungrowSystem({
        hosts: ['localhost'],
        clientFactory: helper.factory,
        reconnect: { baseDelayMs: 5000 },
      });

      await sys.connect();
      helper.startFailing();
      await expect(sys.read({ names: DASHBOARD_REGS })).rejects.toThrow(ConnectionError);
      expect(sys.state).toBe('reconnecting');

      await sys.disconnect();
      expect(sys.state).toBe('disconnected');

      // Advancing timer should NOT trigger reconnect
      const prevCount = helper.callCount;
      await vi.advanceTimersByTimeAsync(6000);
      expect(helper.callCount).toBe(prevCount);

      vi.useRealTimers();
    });
  });
});
