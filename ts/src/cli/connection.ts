import { SungrowInverter } from '../index.js';
import { SungrowSystem } from '../system.js';
import { ConnectionError, TimeoutError } from '../core/errors.js';
import { printError, c } from './format.js';
import type { GlobalOptions } from './main.js';

function makeLogger(options: GlobalOptions) {
  return options.verbose
    ? (msg: string) => console.error(c.dim(`[debug] ${msg}`))
    : undefined;
}

function parseHostPort(host: string, defaultPort: number): { host: string; port: number } {
  const match = host.match(/^(.+):(\d+)$/);
  if (match) return { host: match[1], port: parseInt(match[2], 10) };
  return { host, port: defaultPort };
}

export async function connectInverter(options: GlobalOptions): Promise<SungrowInverter> {
  const { host, port } = parseHostPort(options.hosts[0], options.port);
  const inverter = new SungrowInverter({
    host,
    port,
    slaveId: options.slaveId,
    logger: makeLogger(options),
  });

  try {
    await inverter.connect();
  } catch (err) {
    if (err instanceof TimeoutError) {
      printError(`Connection to ${host}:${port} timed out`);
    } else if (err instanceof ConnectionError) {
      printError(`Cannot connect to ${host}:${port} — is the inverter online?`);
    } else {
      printError(err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  }

  return inverter;
}

export async function connectSystem(options: GlobalOptions): Promise<SungrowSystem> {
  const hosts = options.hosts.map((h) =>
    h.includes(':') ? h : `${h}:${options.port}`
  );
  const system = new SungrowSystem({
    hosts,
    logger: makeLogger(options),
  });

  try {
    await system.connect();
  } catch (err) {
    if (err instanceof TimeoutError) {
      printError(`Connection timed out`);
    } else if (err instanceof ConnectionError) {
      printError(`Cannot connect — are the inverters online?`);
    } else {
      printError(err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  }

  return system;
}
