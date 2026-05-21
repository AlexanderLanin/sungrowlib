import type { RegisterValue } from '../../core/types.js';
import { connectInverter, connectSystem } from '../connection.js';
import { formatTable, printSection, c, type OutputFormat, type Column } from '../format.js';
import type { GlobalOptions } from '../main.js';

export interface ReadCommandOptions {
  level?: number;
  names?: string[];
  supportedOnly: boolean;
}

function formatValue(rv: RegisterValue): string {
  if (rv.value === null) return '';
  if (typeof rv.value === 'boolean') return rv.value ? 'true' : 'false';
  if (Array.isArray(rv.value)) return rv.value.join(', ');
  return String(rv.value);
}

const COLUMNS: Column[] = [
  { key: 'name', label: 'Name' },
  { key: 'address', label: 'Addr', align: 'right' },
  { key: 'type', label: 'Type' },
  { key: 'level', label: 'Lvl', align: 'right' },
  { key: 'value', label: 'Value', align: 'right', color: c.yellow },
  { key: 'unit', label: 'Unit', color: c.dim },
];

function valuesToRows(values: RegisterValue[]) {
  return values.map((rv) => ({
    name: rv.name,
    address: rv.address,
    type: rv.address === 0 ? 'comp' : rv.type,
    level: rv.level,
    value: formatValue(rv),
    unit: rv.unit ?? '',
  }));
}

function outputValues(values: RegisterValue[], format: OutputFormat, title = 'Register Values'): void {
  if (format === 'json') {
    const jsonValues = values.map((rv) => ({
      name: rv.name,
      address: rv.address,
      type: rv.address === 0 ? 'comp' : rv.type,
      level: rv.level,
      value: rv.value,
      unit: rv.unit ?? undefined,
      supported: rv.supported,
    }));
    console.log(JSON.stringify(jsonValues, null, 2));
    return;
  }

  if (format === 'pretty') {
    printSection(title);
  }
  console.log(formatTable({ columns: COLUMNS, rows: valuesToRows(values) }, format));
  if (format === 'pretty') {
    console.log(c.dim(`\n${values.length} registers read`));
  }
}

export async function runRead(global: GlobalOptions, options: ReadCommandOptions): Promise<void> {
  if (global.multiHost) {
    await runSystemRead(global, options);
  } else {
    await runInverterRead(global, options);
  }
}

async function runInverterRead(global: GlobalOptions, options: ReadCommandOptions): Promise<void> {
  const inverter = await connectInverter(global);

  try {
    const data = await inverter.read({
      maxLevel: options.level,
      names: options.names,
    });

    let values = Array.from(data.values.values());
    if (options.supportedOnly) {
      values = values.filter((v) => v.supported === 'yes');
    }

    outputValues(values, global.format);
  } finally {
    await inverter.disconnect();
  }
}

async function runSystemRead(global: GlobalOptions, options: ReadCommandOptions): Promise<void> {
  const system = await connectSystem(global);

  try {
    const data = await system.read({
      maxLevel: options.level,
      names: options.names,
    });

    let values = Array.from(data.values.values());
    if (options.supportedOnly) {
      values = values.filter((v) => v.supported === 'yes');
    }

    outputValues(values, global.format, 'Register Values (Master)');
  } finally {
    await system.disconnect();
  }
}
