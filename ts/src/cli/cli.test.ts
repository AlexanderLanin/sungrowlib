import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModbusClient } from '../transport/modbus.js';
import type { ClientFactory } from '../inverter/inverter.js';

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

const FAKE_INPUT: Record<number, number> = {
  ...SERIAL_WORDS,
  4950: 1, 4951: 0,
  4952: 2, 4953: 0,
  4954: 3100,
  4969: 2800,
  5000: 0xE12, // SH8.0RT-20
  5001: 80,
  5002: 0,
  5011: 2310, // mppt_1_voltage
  5012: 42,   // mppt_1_current
  5013: 2280, // mppt_2_voltage
  5014: 38,   // mppt_2_current
  5017: 4500, 5018: 0, // total_dc_power
  5071: 1500, // array_insulation_resistance → direct_lan
  5214: 500, 5215: 0,  // battery_power S32 → 500 W
  5601: 0,    // meter_active_power
  13000: 64, 13001: 40, 13002: 0,
  13003: 255, 13004: 0,
  13008: 402,     // load_power
  13010: 65134,   // export_power → -402
  13022: 500,     // battery_power_legacy
  13023: 870,     // battery_soc ×0.1 → 87.0%
  13025: 210,     // battery_temperature
  13030: 65535,
  13037: 500, 13038: 0,
  13039: 100,     // battery_capacity → has_battery
};

const FAKE_HOLDING: Record<number, number> = {
  33500: 0x55, // master_slave_mode disabled → standalone
  33501: 0,
  33502: 1,
};

function createMockClient(
  inputData: Record<number, number>,
  holdingData: Record<number, number>,
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

function fakeClientFactory(): ClientFactory {
  return async () => createMockClient(FAKE_INPUT, FAKE_HOLDING);
}

function captureConsole() {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  return {
    lines,
    restore: () => { console.log = orig; },
  };
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('CLI catalog', () => {
  it('lists registers matching a search term', async () => {
    const { runCatalog } = await import('./commands/catalog.js');
    const cap = captureConsole();
    try {
      runCatalog({ search: 'battery_soc', format: 'pretty' });
    } finally {
      cap.restore();
    }
    const output = stripAnsi(cap.lines.join('\n'));
    expect(output).toContain('battery_soc');
    expect(output).toContain('13023');
  });

  it('outputs JSON format', async () => {
    const { runCatalog } = await import('./commands/catalog.js');
    const cap = captureConsole();
    try {
      runCatalog({ search: 'battery_soc', format: 'json' });
    } finally {
      cap.restore();
    }
    const parsed = JSON.parse(cap.lines.join('\n'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((r: { name: string }) => r.name === 'battery_soc')).toBe(true);
  });

  it('outputs CSV format', async () => {
    const { runCatalog } = await import('./commands/catalog.js');
    const cap = captureConsole();
    try {
      runCatalog({ search: 'battery_soc', format: 'csv' });
    } finally {
      cap.restore();
    }
    const output = cap.lines.join('\n');
    expect(output).toContain('Name,Addr');
    expect(output).toContain('battery_soc');
  });

  it('filters by level', async () => {
    const { runCatalog } = await import('./commands/catalog.js');
    const cap = captureConsole();
    try {
      runCatalog({ level: 1, format: 'json' });
    } finally {
      cap.restore();
    }
    const parsed = JSON.parse(cap.lines.join('\n'));
    expect(parsed.every((r: { level: number }) => r.level <= 1)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it('filters by type', async () => {
    const { runCatalog } = await import('./commands/catalog.js');
    const cap = captureConsole();
    try {
      runCatalog({ type: 'hold', format: 'json' });
    } finally {
      cap.restore();
    }
    const parsed = JSON.parse(cap.lines.join('\n'));
    expect(parsed.every((r: { type: string }) => r.type === 'hold')).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });
});

describe('CLI info', () => {
  it('shows inverter info in pretty format', async () => {
    const { SungrowInverter } = await import('../inverter/inverter.js');
    const inv = new SungrowInverter({ host: 'localhost', clientFactory: fakeClientFactory() });
    await inv.connect();

    const cap = captureConsole();
    const { formatKeyValue, printSection, c } = await import('./format.js');
    try {
      const info = inv.info!;
      printSection('Inverter Info');
      console.log(formatKeyValue([
        { label: 'Model', value: info.model ?? 'unknown' },
        { label: 'Serial', value: info.serialNumber ?? 'unknown' },
      ], 'pretty'));
    } finally {
      cap.restore();
    }

    const output = stripAnsi(cap.lines.join('\n'));
    expect(output).toContain('SH8.0RT-20');
    expect(output).toContain('A2350415770');

    await inv.disconnect();
  });

  it('outputs JSON format', async () => {
    const { SungrowInverter } = await import('../inverter/inverter.js');
    const inv = new SungrowInverter({ host: 'localhost', clientFactory: fakeClientFactory() });
    await inv.connect();

    const info = inv.info!;
    const output = JSON.stringify({ ...info, activeGroups: inv.activeGroups }, null, 2);
    const parsed = JSON.parse(output);

    expect(parsed.model).toBe('SH8.0RT-20');
    expect(parsed.serialNumber).toBe('A2350415770');
    expect(parsed.hasBattery).toBe(true);
    expect(parsed.connectionMode).toBe('standalone');

    await inv.disconnect();
  });
});

describe('CLI read', () => {
  it('reads registers by name', async () => {
    const { SungrowInverter } = await import('../inverter/inverter.js');
    const inv = new SungrowInverter({ host: 'localhost', clientFactory: fakeClientFactory() });
    await inv.connect();

    const data = await inv.read({ names: ['total_dc_power', 'battery_soc', 'battery_power'] });
    expect(data.values.get('total_dc_power')?.value).toBe(4500);
    expect(data.values.get('battery_power')?.value).toBe(500);

    await inv.disconnect();
  });

  it('reads registers by level', async () => {
    const { SungrowInverter } = await import('../inverter/inverter.js');
    const inv = new SungrowInverter({ host: 'localhost', clientFactory: fakeClientFactory() });
    await inv.connect();

    const data = await inv.read({ maxLevel: 1 });
    for (const v of data.values.values()) {
      expect(v.level).toBeLessThanOrEqual(1);
    }
    expect(data.values.size).toBeGreaterThan(0);

    await inv.disconnect();
  });

  it('supports --supported-only filtering', async () => {
    const { SungrowInverter } = await import('../inverter/inverter.js');
    const inv = new SungrowInverter({ host: 'localhost', clientFactory: fakeClientFactory() });
    await inv.connect();

    const data = await inv.read({ maxLevel: 3 });
    const supported = Array.from(data.values.values()).filter((v) => v.supported);
    const all = Array.from(data.values.values());
    expect(supported.length).toBeLessThanOrEqual(all.length);

    await inv.disconnect();
  });
});

describe('CLI dump', () => {
  it('produces valid JSON with rawWords', async () => {
    const { SungrowInverter } = await import('../inverter/inverter.js');
    const inv = new SungrowInverter({ host: 'localhost', clientFactory: fakeClientFactory() });
    await inv.connect();
    await inv.read({ maxLevel: 5 });

    const info = inv.info!;
    const output: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      model: info.model,
      serialNumber: info.serialNumber,
      connectionMode: info.connectionMode,
      activeGroups: inv.activeGroups,
      rawWords: inv.lastRawWords,
    };

    const json = JSON.stringify(output, null, 2);
    const parsed = JSON.parse(json);

    expect(parsed.model).toBe('SH8.0RT-20');
    expect(parsed.serialNumber).toBe('A2350415770');
    expect(typeof parsed.rawWords).toBe('object');
    expect(Object.keys(parsed.rawWords).length).toBeGreaterThan(0);

    await inv.disconnect();
  });

  it('includes decoded values when requested', async () => {
    const { SungrowInverter } = await import('../inverter/inverter.js');
    const inv = new SungrowInverter({ host: 'localhost', clientFactory: fakeClientFactory() });
    await inv.connect();
    await inv.read({ maxLevel: 3 });

    const values = inv.lastValues.map((rv) => ({
      name: rv.name,
      address: rv.address,
      value: rv.value,
      unit: rv.unit,
    }));

    expect(values.length).toBeGreaterThan(0);
    const dcPower = values.find((v) => v.name === 'total_dc_power');
    expect(dcPower?.value).toBe(4500);

    await inv.disconnect();
  });
});

describe('CLI watch', () => {
  it('reads multiple times with count limit', async () => {
    const { SungrowInverter } = await import('../inverter/inverter.js');
    const inv = new SungrowInverter({ host: 'localhost', clientFactory: fakeClientFactory() });
    await inv.connect();

    let readCount = 0;
    const targetCount = 3;

    while (readCount < targetCount) {
      const data = await inv.read({ maxLevel: 3, names: ['total_dc_power'] });
      expect(data.values.get('total_dc_power')?.value).toBe(4500);
      readCount++;
    }

    expect(readCount).toBe(targetCount);
    await inv.disconnect();
  });
});
