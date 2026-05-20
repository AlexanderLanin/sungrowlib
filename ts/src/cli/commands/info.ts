import { connectInverter, connectSystem } from '../connection.js';
import { formatKeyValue, printSection, c, type OutputFormat } from '../format.js';
import type { GlobalOptions } from '../main.js';

export async function runInfo(options: GlobalOptions): Promise<void> {
  if (options.multiHost) {
    await runSystemInfo(options);
  } else {
    await runInverterInfo(options);
  }
}

async function runInverterInfo(options: GlobalOptions): Promise<void> {
  const inverter = await connectInverter(options);

  try {
    const info = inverter.info!;
    const groups = inverter.activeGroups;

    if (options.format === 'json') {
      console.log(JSON.stringify({ ...info, activeGroups: groups, stats: inverter.stats }, null, 2));
      return;
    }

    if (options.format === 'csv') {
      const entries = [
        ...Object.entries(info).map(([k, v]) => `${k},${v}`),
        ...Object.entries(groups).map(([k, v]) => `group_${k},${v}`),
      ];
      console.log(['key,value', ...entries].join('\n'));
      return;
    }

    printSection('Inverter Info');
    console.log(formatKeyValue([
      { label: 'Model', value: info.model ?? 'unknown' },
      { label: 'Serial', value: info.serialNumber ?? 'unknown' },
      { label: 'Slave ID', value: String(info.slaveId) },
      { label: 'Connection', value: info.connectionMode },
      { label: 'Slave Count', value: String(info.slaveCount) },
      { label: 'Battery', value: info.hasBattery ? c.green('yes') : c.dim('no') },
      { label: 'Meter', value: info.hasMeter ? c.green('yes') : c.dim('no') },
      { label: 'Output Type', value: info.outputType ?? 'unknown' },
      { label: 'Setup ID', value: info.setupId },
    ], options.format));

    printSection('Active Groups');
    console.log(formatKeyValue(
      Object.entries(groups).map(([k, v]) => ({
        label: k,
        value: v ? c.green('yes') : c.dim('no'),
      })),
      options.format,
    ));

    const stats = inverter.stats;
    printSection('Connection Stats');
    console.log(formatKeyValue([
      { label: 'Connections', value: String(stats.connections) },
      { label: 'Read Success', value: String(stats.readCallsSuccess) },
      { label: 'Read Failed', value: stats.readCallsFailed > 0 ? c.red(String(stats.readCallsFailed)) : '0' },
    ], options.format));
  } finally {
    await inverter.disconnect();
  }
}

async function runSystemInfo(options: GlobalOptions): Promise<void> {
  const system = await connectSystem(options);

  try {
    const info = system.info!;
    const groups = system.activeGroups;
    const slaves = system.slaveDetails;

    if (options.format === 'json') {
      console.log(JSON.stringify({
        ...info,
        activeGroups: groups,
        slaveDetails: slaves.map((s) => ({
          host: s.host,
          slaveId: s.slaveId,
          model: s.model,
        })),
        stats: system.stats,
      }, null, 2));
      return;
    }

    printSection('System Info (Master)');
    console.log(formatKeyValue([
      { label: 'Model', value: info.model ?? 'unknown' },
      { label: 'Serial', value: info.serialNumber ?? 'unknown' },
      { label: 'Connection', value: info.connectionMode },
      { label: 'Slaves', value: String(slaves.length) },
      { label: 'Battery', value: info.hasBattery ? c.green('yes') : c.dim('no') },
      { label: 'Meter', value: info.hasMeter ? c.green('yes') : c.dim('no') },
    ], options.format));

    if (slaves.length > 0) {
      printSection('Slave Details');
      for (const s of slaves) {
        console.log(formatKeyValue([
          { label: 'Host', value: s.host },
          { label: 'Slave ID', value: String(s.slaveId) },
          { label: 'Model', value: s.model ?? 'unknown' },
        ], options.format));
      }
    }

    printSection('Active Groups');
    console.log(formatKeyValue(
      Object.entries(groups).map(([k, v]) => ({
        label: k,
        value: v ? c.green('yes') : c.dim('no'),
      })),
      options.format,
    ));
  } finally {
    await system.disconnect();
  }
}
