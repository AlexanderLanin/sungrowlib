import { describe, it, expect, vi } from 'vitest';
import type { ModbusClient } from '../transport/modbus.js';
import { SungrowInverter, type ClientFactory } from './inverter.js';
import { ConnectionError, UnsupportedRegisterError } from '../core/errors.js';
import { SupportState } from '../core/signal-state.js';
import type { ModbusTransaction } from '../core/types.js';

// Register data extracted from dump_master.yaml and dump_slave.yaml
// These are the raw 16-bit register values at 1-based Sungrow addresses.

// serial_number at 4990–4999, UTF-8[10]: "A2350415770" encoded as register words
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
  // serial_number for serial detection
  ...SERIAL_WORDS,
  // setup registers (level 1)
  4950: 1, 4951: 0,      // protocol_number U32
  4952: 2, 4953: 0,      // protocol_version U32
  4954: 3100,             // arm_software_version U16
  4969: 2800,             // dsp_software_version U16
  // device_type_code for model detection
  5000: 0xE12, // → 'SH8.0RT-20'
  5001: 80,               // nominal_output_power U16 ×0.1 = 8.0 kW
  5002: 0,                // output_type → "2P"
  // MPPT
  5011: 2310,             // mppt_1_voltage U16 ×0.1
  5012: 42,               // mppt_1_current U16 ×0.1
  5013: 2280,             // mppt_2_voltage U16 ×0.1
  5014: 38,               // mppt_2_current U16 ×0.1 → mppt2 indicator
  // PV block
  5017: 0, 5018: 0,
  // array_insulation_resistance → direct_lan indicator
  5071: 1500,
  // meter_active_power → has_meter indicator
  5601: 0,
  // Main block (13000–13030)
  13000: 64, 13001: 40, 13002: 0,
  13003: 255, 13004: 0,  // total_pv_generation U32 → 255 → ×0.1 = 25.5 kWh
  13008: 402,             // load_power S16 → 402 W
  13010: 65134,           // export_power S16 → -402 W
  13022: 0,               // battery_power_legacy U16 → 0 W
  13023: 0,               // battery_soc U16 ×0.1 → 0.0%
  13025: 210,             // battery_temperature S16 ×0.1 → 21.0°C
  13030: 65535,           // grid_state → NA
  13037: 500, 13038: 0,   // total_import_energy U32 → is_master group indicator
  13039: 100,              // battery_capacity U16 ×0.1 → 10.0 kWh → has_battery indicator
};

const MASTER_HOLDING: Record<number, number> = {
  33500: 170,  // master_slave_mode = 0xAA = Enabled
  33501: 160,  // master_slave_role = 0xA0 = Master
  33502: 2,    // inverter_count = 2
};

const SLAVE_INPUT: Record<number, number> = {
  5000: 0xE12,
  5017: 0, 5018: 0,
  13000: 8, 13001: 0, 13002: 0,
  13003: 273, 13004: 0,  // total_pv_generation → 27.3 kWh
  13008: 0, 13010: 0,
  13022: 0, 13023: 0, 13025: 0,
  13030: 65535,
};

const SLAVE_HOLDING: Record<number, number> = {
  33500: 170,  // Enabled
  33501: 161,  // 0xA1 = Slave 1
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

describe('SungrowInverter', () => {
  describe('connect (model + groups + master/slave detection)', () => {
    it('detects SH8.0RT-20 model', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();
      expect(inv.model).toBe('SH8.0RT-20');
    });

    it('reads serial number during connect', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      const info = await inv.connect();
      expect(inv.serialNumber).toBe('A2350415770');
      expect(info.serialNumber).toBe('A2350415770');
    });

    it('detects master mode from dump data', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      const info = await inv.connect();
      expect(info.connectionMode).toBe('master');
      expect(info.slaveCount).toBe(1);
      expect(info.slaveId).toBe(1);
      expect(inv.activeGroups['is_master']).toBe(true);
    });

    it('detects slave mode from dump data', async () => {
      const inv = new SungrowInverter({
        host: 'localhost', slaveId: 2,
        clientFactory: mockClientFactory(SLAVE_INPUT, SLAVE_HOLDING),
      });
      const info = await inv.connect();
      expect(info.connectionMode).toBe('slave');
      expect(info.slaveId).toBe(2);
      expect(inv.activeGroups['is_master']).toBe(false);
    });

    it('detects standalone when holding registers throw', async () => {
      const factory: ClientFactory = async () => {
        const client = createMockClientFromData(MASTER_INPUT, {});
        client.readHoldingRegisters = vi.fn(async () => {
          throw new Error('Holding registers not accessible');
        });
        return client;
      };
      const inv = new SungrowInverter({
        host: 'localhost', clientFactory: factory,
      });
      const info = await inv.connect();
      expect(info.connectionMode).toBe('standalone');
      expect(info.slaveCount).toBe(0);
      expect(inv.activeGroups['is_master']).toBe(true);
    });

    it('detects standalone when master_slave_mode is disabled', async () => {
      const holding = { ...MASTER_HOLDING, 33500: 0x55 };
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, holding),
      });
      const info = await inv.connect();
      expect(info.connectionMode).toBe('standalone');
    });

    it('detects active groups including mppt2', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();
      expect(inv.activeGroups['has_battery']).toBe(true);
      expect(inv.activeGroups['is_master']).toBe(true);
      expect(inv.activeGroups['direct_lan']).toBe(true);
      expect(inv.activeGroups['has_meter']).toBe(false);
      expect(inv.activeGroups['mppt2']).toBe(true);
    });

    it('populates hasBattery, hasMeter, outputType, setupId', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      const info = await inv.connect();
      expect(info.hasBattery).toBe(true);
      expect(info.hasMeter).toBe(false);
      expect(info.outputType).toBe('2P');
      expect(info.setupId).toContain('A2350415770');
      expect(info.setupId).toContain('SH8.0RT-20');
    });

    it('preserves cached active groups when fresh detection returns false', async () => {
      const nightInput = { ...MASTER_INPUT, 5014: 0 };
      const inv = new SungrowInverter({
        host: 'localhost',
        cachedActiveGroups: { mppt2: true },
        clientFactory: mockClientFactory(nightInput, MASTER_HOLDING),
      });
      await inv.connect();
      expect(inv.activeGroups['mppt2']).toBe(true);
    });

    it('does not override fresh true with cached false', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        cachedActiveGroups: { mppt2: false },
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();
      expect(inv.activeGroups['mppt2']).toBe(true);
    });

    it('detects mppt2 as inactive without cache when current is 0', async () => {
      const nightInput = { ...MASTER_INPUT, 5014: 0 };
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(nightInput, MASTER_HOLDING),
      });
      await inv.connect();
      expect(inv.activeGroups['mppt2']).toBe(false);
    });

    it('probes slave IDs when slaveId not specified', async () => {
      const setIdCalls: number[] = [];
      const factory: ClientFactory = async () => {
        const client = createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
        client.setID = vi.fn((id: number) => { setIdCalls.push(id); });
        return client;
      };
      const inv = new SungrowInverter({
        host: 'localhost', clientFactory: factory,
      });
      const info = await inv.connect();
      expect(setIdCalls[0]).toBe(1);
      expect(info.slaveId).toBe(1);
    });

    it('falls back to second slave ID when first returns 0xFFFF', async () => {
      const factory: ClientFactory = async () => {
        let currentId = 1;
        const client = createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
        client.setID = vi.fn((id: number) => { currentId = id; });
        const origRead = client.readInputRegisters;
        client.readInputRegisters = vi.fn(async (addr: number, count: number) => {
          // device_type_code at PDU address 4999 (sungrow 5000 - 1)
          if (currentId === 1 && addr === 4999 && count === 1) {
            return { data: [0xFFFF] };
          }
          return (origRead as typeof client.readInputRegisters)(addr, count);
        });
        return client;
      };
      const inv = new SungrowInverter({
        host: 'localhost', clientFactory: factory,
      });
      const info = await inv.connect();
      expect(info.slaveId).toBe(2);
    });
  });

  describe('read (unified read path)', () => {
    it('reads dashboard registers by name', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();
      const data = await inv.read({ names: DASHBOARD_REGS });
      expect(data.values).toBeInstanceOf(Map);
      expect(data.values.get('total_dc_power')?.value).toBe(0);
      expect(data.values.get('load_power')?.value).toBe(402);
      expect(data.values.get('export_power')?.value).toBe(-402);
    });

    it('reads PV power from dump (0 W at night)', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();
      const data = await inv.read({ names: ['total_dc_power'] });
      expect(data.values.get('total_dc_power')?.value).toBe(0);
    });

    it('decodes state bits as individual booleans via masks', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();
      const data = await inv.read({ names: DASHBOARD_REGS });
      // state_bits=40: load_active + import_from_grid
      expect(data.values.get('state_battery_charging')?.value).toBe(false);
      expect(data.values.get('state_battery_discharging')?.value).toBe(false);
      expect(data.values.get('state_load_active')?.value).toBe(true);
      expect(data.values.get('state_import_from_grid')?.value).toBe(true);
      expect(data.values.get('state_power_generated_from_pv')?.value).toBe(false);
    });

    it('reads battery data from dump', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();
      const data = await inv.read({ names: DASHBOARD_REGS });
      expect(data.values.get('battery_power')?.value).toBe(0);
      expect(data.values.get('battery_soc')?.value).toBeCloseTo(0.0);
      expect(data.values.get('battery_temperature')?.value).toBeCloseTo(21.0);
    });

    it('reads daily and total PV from dump', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();
      const data = await inv.read({ names: ['daily_pv_generation', 'total_pv_generation'] });
      expect(data.values.get('daily_pv_generation')?.value).toBeCloseTo(0.0);
      expect(data.values.get('total_pv_generation')?.value).toBeCloseTo(25.5);
    });

    it('filters by maxLevel', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();
      const data = await inv.read({ maxLevel: 1 });
      expect(data.values.size).toBeGreaterThan(0);
      for (const v of inv.lastValues) {
        expect(v.level).toBeLessThanOrEqual(1);
      }
    });

    it('reads all registers without options', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();
      const data = await inv.read();
      expect(data.values.size).toBeGreaterThan(10);
    });

    it('tracks stats after reads', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();
      expect(inv.stats.connections).toBe(1);

      await inv.read({ names: DASHBOARD_REGS });
      expect(inv.stats.readCallsSuccess).toBeGreaterThan(0);
      expect(inv.stats.retrievedSignalsSuccess).toBeGreaterThan(0);
      expect(inv.stats.lastReadTimestamp).not.toBeNull();
    });

    it('stores lastRawWords and lastValues after read', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();
      await inv.read({ names: DASHBOARD_REGS });
      expect(Object.keys(inv.lastRawWords).length).toBeGreaterThan(0);
      expect(inv.lastValues.length).toBeGreaterThan(0);
    });
  });

  describe('readStream (async generator)', () => {
    it('yields batches and final result matches read()', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();

      const allValues: import('../core/types.js').RegisterValue[] = [];
      let batchCount = 0;
      for await (const batch of inv.readStream({ names: DASHBOARD_REGS })) {
        allValues.push(...batch.values.values());
        batchCount++;
      }

      expect(batchCount).toBeGreaterThan(0);
      expect(allValues.length).toBeGreaterThan(0);

      const inv2 = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv2.connect();
      const readResult = await inv2.read({ names: DASHBOARD_REGS });
      for (const v of allValues) {
        expect(readResult.values.get(v.name)?.value).toEqual(v.value);
      }
    });

    it('updates lastValues progressively after each batch', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();

      let prevCount = 0;
      for await (const _batch of inv.readStream({ maxLevel: 3 })) {
        expect(inv.lastValues.length).toBeGreaterThanOrEqual(prevCount);
        prevCount = inv.lastValues.length;
      }
      expect(prevCount).toBeGreaterThan(0);
    });

    it('includes computed registers as final batch', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();

      const batches: import('../core/types.js').RegisterValue[][] = [];
      for await (const batch of inv.readStream({ maxLevel: 5 })) {
        batches.push([...batch.values.values()]);
      }

      const lastBatch = batches[batches.length - 1];
      const computedNames = lastBatch.filter((v) => v.address === 0 && v.level === 0);
      expect(computedNames.length).toBeGreaterThan(0);
    });
  });

  describe('onBlockRead hook', () => {
    it('emits connect transactions during connect', async () => {
      const traces: ModbusTransaction[] = [];
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
        onBlockRead: (trace) => traces.push(trace),
      });
      await inv.connect();

      expect(traces.length).toBeGreaterThan(0);
      for (const tx of traces) {
        expect(tx.reason).toBe('connect');
        expect(tx.host).toBe('localhost');
        expect(tx.durationMs).toBeGreaterThanOrEqual(0);
        expect(tx.startAddress).toBeGreaterThan(0);
      }

      const registerNames = traces.flatMap((tx) => tx.registerNames);
      expect(registerNames).toContain('device_type_code');
      expect(registerNames).toContain('serial_number');
    });

    it('calls onBlockRead for each block during readStream', async () => {
      const traces: ModbusTransaction[] = [];
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
        onBlockRead: (trace) => traces.push(trace),
      });
      await inv.connect();
      traces.length = 0;

      for await (const _batch of inv.readStream({ names: DASHBOARD_REGS })) {
        // drain
      }

      expect(traces.length).toBeGreaterThan(0);
      for (const tx of traces) {
        expect(tx.host).toBe('localhost');
        expect(tx.reason).toMatch(/^(read|verification)$/);
        expect(tx.type).toMatch(/^(read|hold)$/);
        expect(tx.startAddress).toBeGreaterThan(0);
        expect(tx.length).toBeGreaterThan(0);
        expect(tx.registerNames.length).toBeGreaterThan(0);
        expect(tx.durationMs).toBeGreaterThanOrEqual(0);
        expect(tx.status).toBe('ok');
      }
    });

    it('emits error trace for failed blocks', async () => {
      const traces: ModbusTransaction[] = [];
      const factory: ClientFactory = async () => {
        const client = createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
        const origRead = client.readInputRegisters;
        let connected = false;
        client.readInputRegisters = vi.fn(async (addr: number, count: number) => {
          const sungrowAddr = addr + 1;
          if (connected && sungrowAddr >= 13000 && sungrowAddr < 13050) {
            throw new Error('Gateway target device failed');
          }
          return (origRead as typeof client.readInputRegisters)(addr, count);
        });
        const origSetId = client.setID;
        client.setID = vi.fn((id: number) => { connected = true; (origSetId as (id: number) => void)(id); });
        return client;
      };

      const inv = new SungrowInverter({
        host: 'localhost', clientFactory: factory,
        onBlockRead: (trace) => traces.push(trace),
      });
      await inv.connect();
      traces.length = 0;

      for await (const _batch of inv.readStream({ maxLevel: 3 })) {
        // drain
      }

      const errorTraces = traces.filter((tx) => tx.status === 'error');
      expect(errorTraces.length).toBeGreaterThan(0);
      expect(errorTraces[0].errorMessage).toBeDefined();
    });

    it('does not emit traces for computed registers', async () => {
      const traces: ModbusTransaction[] = [];
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
        onBlockRead: (trace) => traces.push(trace),
      });
      await inv.connect();
      traces.length = 0;

      for await (const _batch of inv.readStream({ maxLevel: 5 })) {
        // drain
      }

      for (const tx of traces) {
        expect(tx.startAddress).toBeGreaterThan(0);
      }
    });
  });

  describe('ReadResult transactions', () => {
    it('readStream batch contains transaction with correct block info', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();

      let firstModbusBatch: import('../core/types.js').ReadResult | undefined;
      for await (const batch of inv.readStream({ names: DASHBOARD_REGS })) {
        if (batch.transactions.length > 0 && !firstModbusBatch) {
          firstModbusBatch = batch;
        }
      }

      expect(firstModbusBatch).toBeDefined();
      const tx = firstModbusBatch!.transactions[0];
      expect(tx.host).toBe('localhost');
      expect(tx.reason).toBe('read');
      expect(tx.type).toMatch(/^(read|hold)$/);
      expect(tx.status).toBe('ok');
    });

    it('read() accumulates all transactions', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();

      // Count blocks that would be read by counting onBlockRead calls (excluding connect)
      const blockCount = { n: 0 };
      const inv2 = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
        onBlockRead: (tx) => { if (tx.reason !== 'connect') blockCount.n++; },
      });
      await inv2.connect();
      for await (const _batch of inv2.readStream({ names: DASHBOARD_REGS })) { /* drain */ }

      const result = await inv.read({ names: DASHBOARD_REGS });
      expect(result.transactions.length).toBe(blockCount.n);
    });

    it('computed batch has empty transactions', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();

      let lastBatch: import('../core/types.js').ReadResult | undefined;
      for await (const batch of inv.readStream({ maxLevel: 5 })) {
        lastBatch = batch;
      }

      // The final batch contains computed registers and must have no transactions
      expect(lastBatch).toBeDefined();
      const lastValues = [...lastBatch!.values.values()];
      const hasComputed = lastValues.some((v) => v.address === 0 && v.level === 0);
      expect(hasComputed).toBe(true);
      expect(lastBatch!.transactions).toEqual([]);
    });
  });

  describe('connection lifecycle', () => {
    it('tracks state through connect/disconnect', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      expect(inv.state).toBe('idle');

      await inv.connect();
      expect(inv.state).toBe('connected');
      expect(inv.connected).toBe(true);

      await inv.disconnect();
      expect(inv.state).toBe('disconnected');
      expect(inv.connected).toBe(false);
    });

    it('connect is idempotent: disconnects first if already connected', async () => {
      const closeCalls: number[] = [];
      let connectCount = 0;
      const factory: ClientFactory = async () => {
        connectCount++;
        const client = createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
        client.close = vi.fn(() => { closeCalls.push(connectCount); });
        return client;
      };

      const inv = new SungrowInverter({ host: 'localhost', clientFactory: factory });
      await inv.connect();
      expect(connectCount).toBe(1);

      await inv.connect();
      expect(connectCount).toBe(2);
      expect(closeCalls).toContain(1);
      expect(inv.state).toBe('connected');
    });

    it('disconnect is idempotent: no-op when idle', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.disconnect();
      expect(inv.state).toBe('idle');
    });

    it('disconnect is idempotent: no-op when already disconnected', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();
      await inv.disconnect();
      expect(inv.state).toBe('disconnected');
      await inv.disconnect();
      expect(inv.state).toBe('disconnected');
    });

    it('state resets to idle on connect failure', async () => {
      const factory: ClientFactory = async () => { throw new Error('ECONNREFUSED'); };
      const inv = new SungrowInverter({ host: 'localhost', clientFactory: factory });

      await expect(inv.connect()).rejects.toThrow();
      expect(inv.state).toBe('idle');
    });
  });

  describe('connection error handling', () => {
    it('readStream aborts on ConnectionError and throws to caller', async () => {
      let readCount = 0;
      const factory: ClientFactory = async () => {
        const client = createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
        const origRead = client.readInputRegisters;
        client.readInputRegisters = vi.fn(async (addr, count) => {
          readCount++;
          if (readCount > 10) throw new ConnectionError('ECONNRESET');
          return (origRead as typeof client.readInputRegisters)(addr, count);
        });
        return client;
      };

      const inv = new SungrowInverter({
        host: 'localhost', clientFactory: factory,
      });
      await inv.connect();

      let batchCount = 0;
      await expect(async () => {
        for await (const _batch of inv.readStream({ maxLevel: 5 })) {
          batchCount++;
        }
      }).rejects.toThrow(ConnectionError);

      expect(batchCount).toBeGreaterThan(0);
    });

    it('readStream continues past non-connection errors', async () => {
      const factory: ClientFactory = async () => {
        const client = createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
        const origRead = client.readInputRegisters;
        let connected = false;
        // Fail persistently for the 13000+ block after connect
        client.readInputRegisters = vi.fn(async (addr: number, count: number) => {
          const sungrowAddr = addr + 1;
          if (connected && sungrowAddr >= 13000 && sungrowAddr < 13050) {
            throw new Error('Gateway target device failed');
          }
          return (origRead as typeof client.readInputRegisters)(addr, count);
        });
        // Track when connect finishes by wrapping setID (called during slave probing)
        const origSetId = client.setID;
        client.setID = vi.fn((id: number) => { connected = true; (origSetId as (id: number) => void)(id); });
        return client;
      };

      const inv = new SungrowInverter({
        host: 'localhost', clientFactory: factory,
      });
      await inv.connect();

      let batchCount = 0;
      for await (const _batch of inv.readStream({ maxLevel: 3 })) {
        batchCount++;
      }
      expect(batchCount).toBeGreaterThan(0);
      expect(inv.stats.readCallsFailed).toBeGreaterThan(0);
    });

    it('reconnects transport on ConnectionError within readBlock retries', async () => {
      let connectCount = 0;
      const factory: ClientFactory = async () => {
        connectCount++;
        if (connectCount === 1) {
          // First connection: fails after a few reads
          let readCount = 0;
          const client = createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
          const origRead = client.readInputRegisters;
          client.readInputRegisters = vi.fn(async (addr, count) => {
            readCount++;
            if (readCount > 10) throw new ConnectionError('ECONNRESET');
            return (origRead as typeof client.readInputRegisters)(addr, count);
          });
          return client;
        }
        // Subsequent connections: work fine
        return createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
      };

      const inv = new SungrowInverter({
        host: 'localhost', clientFactory: factory,
      });
      await inv.connect();
      expect(connectCount).toBe(1);

      const data = await inv.read({ names: DASHBOARD_REGS });
      expect(data.values.size).toBeGreaterThan(0);
      expect(inv.stats.reconnects).toBeGreaterThan(0);
      expect(connectCount).toBe(2);
    });

    it('propagates ConnectionError when reconnect also fails', async () => {
      let connectCount = 0;
      const factory: ClientFactory = async () => {
        connectCount++;
        if (connectCount === 1) {
          let readCount = 0;
          const client = createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
          const origRead = client.readInputRegisters;
          client.readInputRegisters = vi.fn(async (addr, count) => {
            readCount++;
            if (readCount > 10) throw new ConnectionError('ECONNRESET');
            return (origRead as typeof client.readInputRegisters)(addr, count);
          });
          return client;
        }
        throw new ConnectionError('ECONNREFUSED');
      };

      const inv = new SungrowInverter({
        host: 'localhost', clientFactory: factory,
      });
      await inv.connect();

      await expect(inv.read({ names: DASHBOARD_REGS })).rejects.toThrow(ConnectionError);
    });
  });

  describe('readStream verification pass', () => {
    it('verifies zero-valued registers individually after block reads', async () => {
      const traces: ModbusTransaction[] = [];
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
        onBlockRead: (tx) => traces.push(tx),
      });
      await inv.connect();

      for await (const _batch of inv.readStream({ names: DASHBOARD_REGS })) {
        // drain
      }

      const verificationTraces = traces.filter((tx) => tx.reason === 'verification');
      expect(verificationTraces.length).toBeGreaterThan(0);
      for (const tx of verificationTraces) {
        expect(tx.registerNames).toHaveLength(1);
        expect(tx.status).toBe('ok');
      }
    });

    it('marks verified zero-valued registers as CONFIRMED_UNKNOWN', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();

      for await (const _batch of inv.readStream({ names: DASHBOARD_REGS })) {
        // drain
      }

      // battery_power (5214) is 0 and alone in its block → CONFIRMED_UNKNOWN from single-register block read
      expect(inv.signalStates.getState('battery_power')).toBe(SupportState.CONFIRMED_UNKNOWN);
    });

    it('sets supported=false on verified zero-valued registers', async () => {
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
      });
      await inv.connect();

      const result = await inv.read({ names: DASHBOARD_REGS });
      const bp = result.values.get('battery_power');
      expect(bp).toBeDefined();
      expect(bp!.value).toBe(0);
      expect(bp!.supported).toBe(false);
    });

    it('corrects values when verification returns non-zero', async () => {
      let readCount = 0;
      const factory: ClientFactory = async () => {
        const client = createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
        const origRead = client.readInputRegisters;
        // Return 500 for battery_power (addr 5214, S32) on all reads
        client.readInputRegisters = vi.fn(async (addr: number, count: number) => {
          readCount++;
          const sungrowAddr = addr + 1;
          if (count === 2 && sungrowAddr === 5214) {
            return { data: [500, 0] };
          }
          return (origRead as typeof client.readInputRegisters)(addr, count);
        });
        return client;
      };

      const inv = new SungrowInverter({
        host: 'localhost', clientFactory: factory,
      });
      await inv.connect();

      const result = await inv.read({ names: DASHBOARD_REGS });
      const bp = result.values.get('battery_power');
      expect(bp).toBeDefined();
      expect(bp!.value).toBe(500);
      expect(bp!.supported).toBe(true);
      expect(inv.signalStates.getState('battery_power')).toBe(SupportState.YES);
    });

    it('handles UnsupportedRegisterError during verification', async () => {
      const factory: ClientFactory = async () => {
        const client = createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
        const origRead = client.readInputRegisters;
        client.readInputRegisters = vi.fn(async (addr: number, count: number) => {
          const sungrowAddr = addr + 1;
          // Single-register verification read for battery_soc (addr 13023) → unsupported
          if (count === 1 && sungrowAddr === 13023) {
            throw new UnsupportedRegisterError(addr, count);
          }
          return (origRead as typeof client.readInputRegisters)(addr, count);
        });
        return client;
      };

      const traces: ModbusTransaction[] = [];
      const inv = new SungrowInverter({
        host: 'localhost', clientFactory: factory,
        onBlockRead: (tx) => traces.push(tx),
      });
      await inv.connect();

      for await (const _batch of inv.readStream({ names: DASHBOARD_REGS })) {
        // drain
      }

      expect(inv.signalStates.getState('battery_soc')).toBe(SupportState.NO);
      const unsupportedTx = traces.find(
        (tx) => tx.reason === 'verification' && tx.registerNames[0] === 'battery_soc',
      );
      expect(unsupportedTx?.status).toBe('unsupported');
    });

    it('does not verify when all values are non-zero', async () => {
      const nonZeroInput = {
        ...MASTER_INPUT,
        5214: 300, 5215: 0, // battery_power S32 non-zero
        13023: 50,          // battery_soc non-zero
      };
      const traces: ModbusTransaction[] = [];
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(nonZeroInput, MASTER_HOLDING),
        onBlockRead: (tx) => traces.push(tx),
      });
      await inv.connect();

      for await (const _batch of inv.readStream({ names: ['battery_power', 'battery_soc', 'battery_temperature'] })) {
        // drain
      }

      const verificationTraces = traces.filter((tx) => tx.reason === 'verification');
      expect(verificationTraces.length).toBe(0);
    });

    it('does not re-verify on subsequent reads', async () => {
      const traces: ModbusTransaction[] = [];
      const inv = new SungrowInverter({
        host: 'localhost',
        clientFactory: mockClientFactory(MASTER_INPUT, MASTER_HOLDING),
        onBlockRead: (tx) => traces.push(tx),
      });
      await inv.connect();

      // First read — triggers verification
      for await (const _batch of inv.readStream({ names: DASHBOARD_REGS })) { /* drain */ }
      const firstVerifications = traces.filter((tx) => tx.reason === 'verification').length;
      expect(firstVerifications).toBeGreaterThan(0);

      traces.length = 0;

      // Second read — no verification needed (all states resolved)
      for await (const _batch of inv.readStream({ names: DASHBOARD_REGS })) { /* drain */ }
      const secondVerifications = traces.filter((tx) => tx.reason === 'verification').length;
      expect(secondVerifications).toBe(0);
    });

    it('propagates ConnectionError during verification', async () => {
      let readCallCount = 0;
      const factory: ClientFactory = async () => {
        const client = createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
        const origRead = client.readInputRegisters;
        client.readInputRegisters = vi.fn(async (addr: number, count: number) => {
          readCallCount++;
          // Fail on single-register verification reads
          if (count === 1) {
            throw new ConnectionError('ECONNRESET');
          }
          return (origRead as typeof client.readInputRegisters)(addr, count);
        });
        return client;
      };

      const inv = new SungrowInverter({
        host: 'localhost', clientFactory: factory,
      });
      await inv.connect();

      await expect(async () => {
        for await (const _batch of inv.readStream({ names: DASHBOARD_REGS })) { /* drain */ }
      }).rejects.toThrow(ConnectionError);
    });

    it('continues verification past non-connection errors', async () => {
      const factory: ClientFactory = async () => {
        const client = createMockClientFromData(MASTER_INPUT, MASTER_HOLDING);
        const origRead = client.readInputRegisters;
        client.readInputRegisters = vi.fn(async (addr: number, count: number) => {
          const sungrowAddr = addr + 1;
          // Always fail single-register verification reads for battery_soc (addr 13023)
          if (count === 1 && sungrowAddr === 13023) {
            throw new Error('test device error');
          }
          return (origRead as typeof client.readInputRegisters)(addr, count);
        });
        return client;
      };

      const traces: ModbusTransaction[] = [];
      const inv = new SungrowInverter({
        host: 'localhost', clientFactory: factory,
        onBlockRead: (tx) => traces.push(tx),
      });
      await inv.connect();

      // Should complete without throwing
      for await (const _batch of inv.readStream({ names: DASHBOARD_REGS })) { /* drain */ }

      const errorTx = traces.find(
        (tx) => tx.reason === 'verification' && tx.status === 'error',
      );
      expect(errorTx).toBeDefined();
      expect(errorTx!.registerNames[0]).toBe('battery_soc');
    });

    it('corrected values feed into computed registers', async () => {
      // mppt_1_voltage at 5011 is non-zero (2310 → 231.0V) in MASTER_INPUT,
      // mppt_1_current at 5012 is non-zero (42 → 4.2A) → mppt_1_power = 231.0 * 4.2
      // Make voltage 0 in multi-block, but return 2310 on single verification read
      const zeroVoltageInput = { ...MASTER_INPUT, 5011: 0 };
      const factory: ClientFactory = async () => {
        const client = createMockClientFromData(zeroVoltageInput, MASTER_HOLDING);
        const origRead = client.readInputRegisters;
        client.readInputRegisters = vi.fn(async (addr: number, count: number) => {
          const sungrowAddr = addr + 1;
          if (count === 1 && sungrowAddr === 5011) {
            return { data: [2310] };
          }
          return (origRead as typeof client.readInputRegisters)(addr, count);
        });
        return client;
      };

      const inv = new SungrowInverter({
        host: 'localhost', clientFactory: factory,
      });
      await inv.connect();

      const result = await inv.read({ maxLevel: 5 });
      const power = result.values.get('mppt_1_power');
      expect(power).toBeDefined();
      expect(power!.value).toBeCloseTo(231.0 * 4.2, 1);
    });
  });
});

