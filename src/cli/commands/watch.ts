import type { RegisterValue } from '../../core/types.js';
import { connectInverter } from '../connection.js';
import { formatTable, printSection, printError, c, type Column } from '../format.js';
import type { GlobalOptions } from '../main.js';

export interface WatchCommandOptions {
  level: number;
  names?: string[];
  interval: number;
  count?: number;
  append: boolean;
}

function formatValue(rv: RegisterValue): string {
  if (rv.value === null) return '';
  if (typeof rv.value === 'boolean') return rv.value ? 'true' : 'false';
  if (Array.isArray(rv.value)) return rv.value.join(', ');
  return String(rv.value);
}

export async function runWatch(global: GlobalOptions, options: WatchCommandOptions): Promise<void> {
  const inverter = await connectInverter(global);

  let readCount = 0;
  let failCount = 0;
  let running = true;

  const cleanup = async () => {
    running = false;
    await inverter.disconnect();
    if (global.format === 'pretty') {
      console.log(c.dim(`\n${readCount} reads completed, ${failCount} failed`));
    }
  };

  process.on('SIGINT', () => { cleanup().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { cleanup().then(() => process.exit(0)); });

  const columns: Column[] = [
    { key: 'name', label: 'Name' },
    { key: 'value', label: 'Value', align: 'right', color: c.yellow },
    { key: 'unit', label: 'Unit', color: c.dim },
  ];

  while (running) {
    try {
      const data = await inverter.read({
        maxLevel: options.level,
        names: options.names,
      });
      readCount++;

      const values = Array.from(data.values.values()).filter((v) => v.supported);
      const rows = values.map((rv) => ({
        name: rv.name,
        value: formatValue(rv),
        unit: rv.unit ?? '',
      }));

      if (!options.append) {
        process.stdout.write('\x1b[2J\x1b[H');
      }

      if (global.format === 'pretty') {
        const timestamp = new Date().toLocaleTimeString();
        printSection(`[${timestamp}]  Read #${readCount}  (${options.interval}s interval)`);
      }
      console.log(formatTable({ columns, rows }, global.format));
      if (global.format === 'pretty' && !options.append) {
        console.log(c.dim(`\n${readCount} reads OK, ${failCount} failed — Ctrl+C to stop`));
      }
    } catch (err) {
      failCount++;
      printError(err instanceof Error ? err.message : String(err));
    }

    if (options.count != null && readCount >= options.count) {
      break;
    }

    if (running) {
      await new Promise((r) => setTimeout(r, options.interval * 1000));
    }
  }

  await inverter.disconnect();
}
