const isColorSupported = process.stdout.isTTY && !process.env['NO_COLOR'];

const codes = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
} as const;

type Style = keyof typeof codes;

function style(text: string, ...styles: Style[]): string {
  if (!isColorSupported) return text;
  const prefix = styles.map((s) => codes[s]).join('');
  return `${prefix}${text}${codes.reset}`;
}

export const c = {
  bold: (t: string) => style(t, 'bold'),
  dim: (t: string) => style(t, 'dim'),
  red: (t: string) => style(t, 'red'),
  green: (t: string) => style(t, 'green'),
  yellow: (t: string) => style(t, 'yellow'),
  cyan: (t: string) => style(t, 'cyan'),
  header: (t: string) => style(t, 'bold', 'cyan'),
  error: (t: string) => style(t, 'bold', 'red'),
  success: (t: string) => style(t, 'bold', 'green'),
  value: (t: string) => style(t, 'yellow'),
  unit: (t: string) => style(t, 'dim'),
  label: (t: string) => style(t, 'bold'),
};

export type OutputFormat = 'pretty' | 'json' | 'csv';

export interface Column {
  key: string;
  label: string;
  align?: 'left' | 'right';
  color?: (value: string) => string;
}

export interface TableData {
  columns: Column[];
  rows: Record<string, string | number | boolean | null | undefined>[];
}

function prettyTable(data: TableData): string {
  const widths = new Map<string, number>();
  for (const col of data.columns) {
    widths.set(col.key, col.label.length);
  }
  for (const row of data.rows) {
    for (const col of data.columns) {
      const val = String(row[col.key] ?? '');
      const current = widths.get(col.key)!;
      if (val.length > current) widths.set(col.key, val.length);
    }
  }

  const headerLine = data.columns
    .map((col) => {
      const w = widths.get(col.key)!;
      return c.bold(col.align === 'right' ? col.label.padStart(w) : col.label.padEnd(w));
    })
    .join('  ');

  const separator = c.dim('─'.repeat(
    Array.from(widths.values()).reduce((a, b) => a + b, 0) + (data.columns.length - 1) * 2,
  ));

  const lines = data.rows.map((row) =>
    data.columns
      .map((col) => {
        const w = widths.get(col.key)!;
        const raw = String(row[col.key] ?? '');
        const padded = col.align === 'right' ? raw.padStart(w) : raw.padEnd(w);
        return col.color ? col.color(padded) : padded;
      })
      .join('  '),
  );

  return [headerLine, separator, ...lines].join('\n');
}

function jsonOutput(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2);
}

function csvOutput(data: TableData): string {
  const header = data.columns.map((col) => col.label).join(',');
  const lines = data.rows.map((row) =>
    data.columns
      .map((col) => {
        const val = String(row[col.key] ?? '');
        return val.includes(',') || val.includes('"') ? `"${val.replace(/"/g, '""')}"` : val;
      })
      .join(','),
  );
  return [header, ...lines].join('\n');
}

export function formatTable(data: TableData, format: OutputFormat): string {
  switch (format) {
    case 'pretty':
      return prettyTable(data);
    case 'json':
      return jsonOutput(data.rows);
    case 'csv':
      return csvOutput(data);
  }
}

export function formatKeyValue(
  entries: Array<{ label: string; value: string }>,
  format: OutputFormat,
): string {
  if (format === 'json') {
    const obj: Record<string, string> = {};
    for (const e of entries) obj[e.label] = e.value;
    return JSON.stringify(obj, null, 2);
  }
  if (format === 'csv') {
    return ['key,value', ...entries.map((e) => `${e.label},${e.value}`)].join('\n');
  }
  const maxLabel = Math.max(...entries.map((e) => e.label.length));
  return entries
    .map((e) => `  ${c.label(e.label.padEnd(maxLabel))}  ${c.value(e.value)}`)
    .join('\n');
}

export function printSection(title: string): void {
  console.log(`\n${c.header(title)}`);
}

export function printError(message: string): void {
  console.error(c.error(`Error: ${message}`));
}
