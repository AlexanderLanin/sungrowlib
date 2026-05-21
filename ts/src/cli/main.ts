#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { printError } from './format.js';
import type { OutputFormat } from './format.js';

const HELP = `
sungrowlib - Sungrow inverter CLI

Usage: sungrowlib <command> [options]

Commands:
  catalog   List available registers (offline, no connection needed)
  info      Connect and show inverter info (model, serial, topology)
  read      Read registers (one-shot)
  watch     Read registers repeatedly at an interval
  dump      Save raw register data as JSON

Global options:
  -H, --host <ip>       Inverter IP (or set SUNGROW_HOST)
  -p, --port <n>        Modbus TCP port (default: 502)
  -s, --slave-id <n>    Modbus slave ID (default: auto-detect)
  -f, --format <fmt>    Output format: pretty, json, csv (default: pretty)
  -v, --verbose         Enable debug logging
  -h, --help            Show help

Examples:
  sungrowlib catalog --search power
  sungrowlib info -H 192.168.1.100
  sungrowlib read -H 192.168.1.100 --level 3
  sungrowlib watch -H 192.168.1.100 -n total_dc_power,battery_soc
  sungrowlib dump -H 192.168.1.100 > dump.json
`.trim();

const CATALOG_HELP = `
sungrowlib catalog - List available registers (offline)

Options:
  -l, --level <n>       Filter by max level (1-5)
  -t, --type <type>     Filter by register type (read or hold)
  --search <text>       Case-insensitive substring match on name
  -f, --format <fmt>    Output format (default: pretty)
  -h, --help            Show help
`.trim();

const INFO_HELP = `
sungrowlib info - Connect and show inverter info

Options:
  -H, --host <ip>       Inverter IP (required, or set SUNGROW_HOST)
  -p, --port <n>        Modbus TCP port (default: 502)
  -s, --slave-id <n>    Modbus slave ID (default: auto-detect)
  -f, --format <fmt>    Output format (default: pretty)
  -v, --verbose         Enable debug logging
  -h, --help            Show help
`.trim();

const READ_HELP = `
sungrowlib read - Read registers (one-shot)

Options:
  -H, --host <ip>       Inverter IP (required, or set SUNGROW_HOST)
  -p, --port <n>        Modbus TCP port (default: 502)
  -s, --slave-id <n>    Modbus slave ID (default: auto-detect)
  -l, --level <n>       Max register level (1-5)
  -n, --names <list>    Comma-separated register names
  --supported-only      Omit unsupported registers
  -f, --format <fmt>    Output format (default: pretty)
  -v, --verbose         Enable debug logging
  -h, --help            Show help
`.trim();

const WATCH_HELP = `
sungrowlib watch - Read registers repeatedly

Options:
  -H, --host <ip>       Inverter IP (required, or set SUNGROW_HOST)
  -p, --port <n>        Modbus TCP port (default: 502)
  -s, --slave-id <n>    Modbus slave ID (default: auto-detect)
  -l, --level <n>       Max register level (default: 3)
  -n, --names <list>    Comma-separated register names
  -i, --interval <sec>  Seconds between reads (default: 5)
  -c, --count <n>       Number of reads before stopping
  --append              Append output instead of clearing screen
  -f, --format <fmt>    Output format (default: pretty)
  -v, --verbose         Enable debug logging
  -h, --help            Show help
`.trim();

const DUMP_HELP = `
sungrowlib dump - Save raw register data as JSON

Options:
  -H, --host <ip>       Inverter IP (required, or set SUNGROW_HOST)
  -p, --port <n>        Modbus TCP port (default: 502)
  -s, --slave-id <n>    Modbus slave ID (default: auto-detect)
  -l, --level <n>       Max register level (default: 5)
  -v, --verbose         Enable debug logging
  -h, --help            Show help
`.trim();

const COMMAND_HELP: Record<string, string> = {
  catalog: CATALOG_HELP,
  info: INFO_HELP,
  read: READ_HELP,
  watch: WATCH_HELP,
  dump: DUMP_HELP,
};

export interface GlobalOptions {
  hosts: string[];
  port: number;
  slaveId?: number;
  format: OutputFormat;
  verbose: boolean;
  multiHost: boolean;
}

function parseFormat(value: string | undefined): OutputFormat {
  if (!value || value === 'pretty') return 'pretty';
  if (value === 'json') return 'json';
  if (value === 'csv') return 'csv';
  printError(`Unknown format "${value}". Use pretty, json, or csv.`);
  process.exit(1);
}

function resolveGlobalOptions(values: Record<string, unknown>): GlobalOptions {
  const rawHost = values['host'];
  let hosts: string[];
  if (Array.isArray(rawHost)) {
    hosts = rawHost as string[];
  } else if (typeof rawHost === 'string') {
    hosts = [rawHost];
  } else {
    const envHost = process.env['SUNGROW_HOST'];
    if (envHost) {
      hosts = [envHost];
    } else {
      printError('--host is required (or set SUNGROW_HOST environment variable)');
      process.exit(1);
    }
  }
  return {
    hosts,
    port: values['port'] ? parseInt(values['port'] as string, 10) : 502,
    slaveId: values['slave-id'] ? parseInt(values['slave-id'] as string, 10) : undefined,
    format: parseFormat(values['format'] as string | undefined),
    verbose: (values['verbose'] as boolean) ?? false,
    multiHost: hosts.length > 1,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith('-') ? args[0] : undefined;
  const commandArgs = command ? args.slice(1) : args;

  if (!command || commandArgs.includes('--help') || commandArgs.includes('-h')) {
    if (command && COMMAND_HELP[command]) {
      console.log(COMMAND_HELP[command]);
    } else {
      console.log(HELP);
    }
    return;
  }

  switch (command) {
    case 'catalog': {
      const { values } = parseArgs({
        args: commandArgs,
        options: {
          level: { type: 'string', short: 'l' },
          type: { type: 'string', short: 't' },
          search: { type: 'string' },
          format: { type: 'string', short: 'f' },
        },
        strict: true,
      });
      const { runCatalog } = await import('./commands/catalog.js');
      runCatalog({
        level: values.level ? parseInt(values.level, 10) : undefined,
        type: values.type as 'read' | 'hold' | undefined,
        search: values.search,
        format: parseFormat(values.format),
      });
      break;
    }

    case 'info': {
      const { values } = parseArgs({
        args: commandArgs,
        options: {
          host: { type: 'string', short: 'H', multiple: true },
          port: { type: 'string', short: 'p' },
          'slave-id': { type: 'string', short: 's' },
          format: { type: 'string', short: 'f' },
          verbose: { type: 'boolean', short: 'v', default: false },
        },
        strict: true,
      });
      const global = resolveGlobalOptions(values);
      const { runInfo } = await import('./commands/info.js');
      await runInfo(global);
      break;
    }

    case 'read': {
      const { values } = parseArgs({
        args: commandArgs,
        options: {
          host: { type: 'string', short: 'H', multiple: true },
          port: { type: 'string', short: 'p' },
          'slave-id': { type: 'string', short: 's' },
          format: { type: 'string', short: 'f' },
          verbose: { type: 'boolean', short: 'v', default: false },
          level: { type: 'string', short: 'l' },
          names: { type: 'string', short: 'n' },
          'supported-only': { type: 'boolean', default: false },
        },
        strict: true,
      });
      const global = resolveGlobalOptions(values);
      const { runRead } = await import('./commands/read.js');
      await runRead(global, {
        level: values.level ? parseInt(values.level, 10) : undefined,
        names: values.names?.split(',').map((n) => n.trim()),
        supportedOnly: values['supported-only'] ?? false,
      });
      break;
    }

    case 'watch': {
      const { values } = parseArgs({
        args: commandArgs,
        options: {
          host: { type: 'string', short: 'H', multiple: true },
          port: { type: 'string', short: 'p' },
          'slave-id': { type: 'string', short: 's' },
          format: { type: 'string', short: 'f' },
          verbose: { type: 'boolean', short: 'v', default: false },
          level: { type: 'string', short: 'l' },
          names: { type: 'string', short: 'n' },
          interval: { type: 'string', short: 'i' },
          count: { type: 'string', short: 'c' },
          append: { type: 'boolean', default: false },
        },
        strict: true,
      });
      const global = resolveGlobalOptions(values);
      const { runWatch } = await import('./commands/watch.js');
      await runWatch(global, {
        level: values.level ? parseInt(values.level, 10) : 3,
        names: values.names?.split(',').map((n) => n.trim()),
        interval: values.interval ? parseInt(values.interval, 10) : 5,
        count: values.count ? parseInt(values.count, 10) : undefined,
        append: values.append ?? false,
      });
      break;
    }

    case 'dump': {
      const { values } = parseArgs({
        args: commandArgs,
        options: {
          host: { type: 'string', short: 'H', multiple: true },
          port: { type: 'string', short: 'p' },
          'slave-id': { type: 'string', short: 's' },
          verbose: { type: 'boolean', short: 'v', default: false },
          level: { type: 'string', short: 'l' },
        },
        strict: true,
      });
      const global = resolveGlobalOptions(values);
      const { runDump } = await import('./commands/dump.js');
      await runDump(global, {
        level: values.level ? parseInt(values.level, 10) : 5,
      });
      break;
    }

    default:
      printError(`Unknown command "${command}". Run sungrowlib --help for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  printError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
