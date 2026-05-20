import { connectInverter, connectSystem } from '../connection.js';
import type { GlobalOptions } from '../main.js';

export interface DumpCommandOptions {
  level: number;
  includeValues: boolean;
}

export async function runDump(global: GlobalOptions, options: DumpCommandOptions): Promise<void> {
  if (global.multiHost) {
    await runSystemDump(global, options);
  } else {
    await runInverterDump(global, options);
  }
}

async function runInverterDump(global: GlobalOptions, options: DumpCommandOptions): Promise<void> {
  const inverter = await connectInverter(global);

  try {
    await inverter.read({ maxLevel: options.level });

    const info = inverter.info!;
    const output: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      model: info.model,
      serialNumber: info.serialNumber,
      connectionMode: info.connectionMode,
      slaveId: info.slaveId,
      activeGroups: inverter.activeGroups,
      rawWords: inverter.lastRawWords,
    };

    if (options.includeValues) {
      output['values'] = inverter.lastValues.map((rv) => ({
        name: rv.name,
        address: rv.address,
        type: rv.type,
        level: rv.level,
        raw: rv.raw,
        value: rv.value,
        unit: rv.unit,
        supported: rv.supported,
      }));
    }

    console.log(JSON.stringify(output, null, 2));
  } finally {
    await inverter.disconnect();
  }
}

async function runSystemDump(global: GlobalOptions, options: DumpCommandOptions): Promise<void> {
  const system = await connectSystem(global);

  try {
    await system.read({ maxLevel: options.level });
    await system.readSlaves({ maxLevel: options.level });

    const info = system.info!;
    const output: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      model: info.model,
      serialNumber: info.serialNumber,
      connectionMode: info.connectionMode,
      slaveId: info.slaveId,
      activeGroups: system.activeGroups,
      rawWords: system.lastRawWords,
      slaveDetails: system.slaveDetails.map((s) => ({
        host: s.host,
        slaveId: s.slaveId,
        model: s.model,
        rawWords: s.lastRawWords,
      })),
    };

    if (options.includeValues) {
      output['values'] = system.lastValues.map((rv) => ({
        name: rv.name,
        address: rv.address,
        type: rv.type,
        level: rv.level,
        raw: rv.raw,
        value: rv.value,
        unit: rv.unit,
        supported: rv.supported,
      }));
    }

    console.log(JSON.stringify(output, null, 2));
  } finally {
    await system.disconnect();
  }
}
