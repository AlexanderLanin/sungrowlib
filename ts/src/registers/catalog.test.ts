import { describe, it, expect } from 'vitest';
import { fnmatch, loadCatalog, loadCatalogFromData, RegisterCatalog } from './catalog.js';

describe('fnmatch', () => {
  it('matches exact strings', () => {
    expect(fnmatch('SH8.0RT-20', 'SH8.0RT-20')).toBe(true);
    expect(fnmatch('SH8.0RT-20', 'SH10RT')).toBe(false);
  });

  it('matches * wildcard', () => {
    expect(fnmatch('SH8.0RT-20', 'SH*')).toBe(true);
    expect(fnmatch('SG10KTL', 'SH*')).toBe(false);
    expect(fnmatch('SG50KTL-M', 'SG*KTL-M*')).toBe(true);
    expect(fnmatch('SH8.0RT-20', 'SH*RT*')).toBe(true);
    expect(fnmatch('SH5.0RS', 'SH*RT*')).toBe(false);
  });

  it('handles special regex chars in model names', () => {
    expect(fnmatch('SH8.0RT-20', 'SH8.0RT-20')).toBe(true);
    expect(fnmatch('SH80RT-20', 'SH8.0RT-20')).toBe(false);
  });
});

describe('loadCatalog', () => {
  it('loads the full catalog from JSON', () => {
    const catalog = loadCatalog();
    const all = catalog.getAll();
    expect(all.length).toBeGreaterThan(200);
  });

  it('contains known registers', () => {
    const catalog = loadCatalog();
    const serialNumber = catalog.getByName('serial_number');
    expect(serialNumber).toBeDefined();
    expect(serialNumber!.address).toBe(4990);
    expect(serialNumber!.baseDataType).toBe('UTF-8');
    expect(serialNumber!.level).toBe(1);
    expect(serialNumber!.arrayLength).toBe(10);
    expect(serialNumber!.registerWidth).toBe(10);
  });

  it('parses device_type_code with decoded map', () => {
    const catalog = loadCatalog();
    const dtc = catalog.getByName('device_type_code');
    expect(dtc).toBeDefined();
    expect(dtc!.decoded).toBeDefined();
    expect(dtc!.decoded![0xE12]).toBe('SH8.0RT-20');
  });

  it('parses array registers', () => {
    const catalog = loadCatalog();
    const pvToday = catalog.getByName('pv_power_of_today');
    expect(pvToday).toBeDefined();
    expect(pvToday!.arrayLength).toBe(96);
    expect(pvToday!.registerWidth).toBe(96);
    expect(pvToday!.baseDataType).toBe('U16');
  });

  it('parses U32 array registers', () => {
    const catalog = loadCatalog();
    const yearly = catalog.getByName('yearly_pv_energy_yields');
    expect(yearly).toBeDefined();
    expect(yearly!.arrayLength).toBe(20);
    expect(yearly!.registerWidth).toBe(40);
    expect(yearly!.baseDataType).toBe('U32');
  });

  it('parses accuracy as scale', () => {
    const catalog = loadCatalog();
    const dailyPv = catalog.getByName('daily_pv_generation');
    expect(dailyPv).toBeDefined();
    expect(dailyPv!.scale).toBe(0.1);
  });

  it('parses mask registers', () => {
    const catalog = loadCatalog();
    const chargingState = catalog.getByName('state_battery_charging');
    expect(chargingState).toBeDefined();
    expect(chargingState!.mask).toBe(2);
    expect(chargingState!.address).toBe(13001);
  });

  it('parses group and indicator', () => {
    const catalog = loadCatalog();
    const indicators = catalog.getGroupIndicators();
    expect(indicators.length).toBeGreaterThan(0);
    const meterIndicator = indicators.find((r) => r.indicator === 'has_meter');
    expect(meterIndicator).toBeDefined();
  });

  it('deduplicates names', () => {
    const catalog = loadCatalog();
    const all = catalog.getAll();
    const names = all.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('filterByModel', () => {
  it('excludes registers with models_exclude matching', () => {
    const catalog = loadCatalog();
    const filtered = catalog.filterByModel('SH8.0RT-20');
    const excluded = filtered.find((r) => r.name === 'total_running_time');
    expect(excluded).toBeUndefined();
  });

  it('includes registers with no model restrictions', () => {
    const catalog = loadCatalog();
    const filtered = catalog.filterByModel('SH8.0RT-20');
    const dailyPv = filtered.find((r) => r.name === 'daily_pv_generation');
    expect(dailyPv).toBeDefined();
  });

  it('excludes registers with models list not matching', () => {
    const catalog = loadCatalog();
    const filtered = catalog.filterByModel('SH8.0RT-20');
    const sgOnly = filtered.find((r) => r.name === 'string_1_current');
    expect(sgOnly).toBeUndefined();
  });

  it('includes registers matching wildcard models', () => {
    const catalog = loadCatalog();
    const filtered = catalog.filterByModel('SH8.0RT-20');
    const rtModel = filtered.find((r) => r.name === 'forced_charging_enable');
    expect(rtModel).toBeDefined();
  });
});

describe('filterByLevel', () => {
  it('filters by max level', () => {
    const catalog = loadCatalog();
    const all = catalog.getAll();
    const level3 = catalog.filterByLevel(all, 3);
    expect(level3.every((r) => r.level <= 3)).toBe(true);
    expect(level3.length).toBeLessThan(all.length);
    expect(level3.length).toBeGreaterThan(0);
  });
});

describe('filterByGroups', () => {
  it('excludes registers from inactive groups', () => {
    const catalog = loadCatalog();
    const all = catalog.getAll();
    const groups: Record<string, boolean> = { has_battery: false, is_master: true };
    const filtered = catalog.filterByGroups(all, groups);
    const batteryReg = filtered.find((r) => r.name === 'battery_power');
    expect(batteryReg).toBeUndefined();
  });

  it('includes registers from active groups', () => {
    const catalog = loadCatalog();
    const all = catalog.getAll();
    const groups: Record<string, boolean> = { has_battery: true, is_master: true };
    const filtered = catalog.filterByGroups(all, groups);
    const batteryReg = filtered.find((r) => r.name === 'battery_power');
    expect(batteryReg).toBeDefined();
  });

  it('excludes array-group registers when any group is inactive', () => {
    const catalog = loadCatalog();
    const all = catalog.getAll();
    const groups: Record<string, boolean> = { has_battery: true, direct_lan: false };
    const filtered = catalog.filterByGroups(all, groups);
    const arrayGroupReg = filtered.find((r) => Array.isArray(r.group) && r.group.includes('has_battery') && r.group.includes('direct_lan'));
    expect(arrayGroupReg).toBeUndefined();
  });

  it('includes array-group registers when all groups are active', () => {
    const catalog = loadCatalog();
    const all = catalog.getAll();
    const groups: Record<string, boolean> = { has_battery: true, direct_lan: true };
    const filtered = catalog.filterByGroups(all, groups);
    const arrayGroupReg = filtered.find((r) => Array.isArray(r.group) && r.group.includes('has_battery') && r.group.includes('direct_lan'));
    expect(arrayGroupReg).toBeDefined();
  });
});

describe('applyModelOverrides', () => {
  it('overrides S32 to S16 for load_power on SH8.0RT-20', () => {
    const catalog = loadCatalog();
    const all = catalog.getAll();
    const overridden = catalog.applyModelOverrides(all, 'SH8.0RT-20');
    const load = overridden.find((r) => r.name === 'load_power');
    expect(load).toBeDefined();
    expect(load!.baseDataType).toBe('S16');
    expect(load!.registerWidth).toBe(1);
  });

  it('does not override for other models', () => {
    const catalog = loadCatalog();
    const all = catalog.getAll();
    const overridden = catalog.applyModelOverrides(all, 'SH10RT');
    const load = overridden.find((r) => r.name === 'load_power');
    expect(load).toBeDefined();
    expect(load!.baseDataType).toBe('S32');
    expect(load!.registerWidth).toBe(2);
  });
});

describe('loadCatalogFromData', () => {
  it('loads a minimal catalog from inline data', () => {
    const catalog = loadCatalogFromData({
      read: [
        { name: 'test_reg', address: 1000, data_type: 'U16', level: 3 },
        { name: 'test_arr', address: 2000, data_type: 'U16[10]', level: 5, accuracy: 0.1, unit_of_measurement: 'kWh' },
      ],
      hold: [
        { name: 'hold_reg', address: 3000, data_type: 'S32', level: 4, decoded: { '170': 'Enabled', '85': 'Disabled' } },
      ],
    });
    expect(catalog.getAll().length).toBe(3);

    const arr = catalog.getByName('test_arr')!;
    expect(arr.arrayLength).toBe(10);
    expect(arr.registerWidth).toBe(10);
    expect(arr.scale).toBe(0.1);

    const hold = catalog.getByName('hold_reg')!;
    expect(hold.decoded![170]).toBe('Enabled');
    expect(hold.type).toBe('hold');
  });
});
