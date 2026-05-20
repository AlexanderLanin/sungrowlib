import type { Transport } from './transport.js';
import { wrapModbusError, ConnectionError, TimeoutError } from '../core/errors.js';

export interface ModbusClient {
  connectTCP(host: string, options: { port: number }): Promise<void>;
  setID(id: number): void;
  setTimeout(ms: number): void;
  readInputRegisters(addr: number, count: number): Promise<{ data: number[] }>;
  readHoldingRegisters(addr: number, count: number): Promise<{ data: number[] }>;
  close(cb: () => void): void;
  isOpen?: boolean;
}

const CONNECT_TIMEOUT_MS = 5000;
const MIN_CALL_INTERVAL_MS = 2000;

export async function createModbusClient(host: string, port = 502): Promise<ModbusClient> {
  const { default: ModbusRTU } = await import('modbus-serial');
  const client = new ModbusRTU() as unknown as ModbusClient;

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new TimeoutError(`TCP connect to ${host}:${port} timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS);
  });

  try {
    await Promise.race([client.connectTCP(host, { port }), timeout]);
  } catch (err) {
    client.close(() => {});
    if (err instanceof TimeoutError) throw err;
    throw new ConnectionError(`TCP connect to ${host}:${port} failed`, { cause: err instanceof Error ? err : undefined });
  }

  client.setTimeout(5000);
  return client;
}

export class Throttle {
  private _nextAllowed = 0;
  private _intervalMs: number;

  constructor(intervalMs = MIN_CALL_INTERVAL_MS) {
    this._intervalMs = intervalMs;
  }

  async wait(): Promise<void> {
    const now = Date.now();
    if (now < this._nextAllowed) {
      await new Promise((r) => setTimeout(r, this._nextAllowed - now));
    }
    this._nextAllowed = Date.now() + this._intervalMs;
  }
}

export function createModbusTransport(client: ModbusClient, throttle?: Throttle): Transport {
  return {
    get connected() { return !!client.isOpen; },
    async disconnect() { client.close(() => {}); },
    setSlaveId(id: number) { client.setID(id); },
    async readInputRegisters(start: number, count: number) {
      return readInputBlock(client, start, count, throttle);
    },
    async readHoldingRegisters(start: number, count: number) {
      return readHoldingBlock(client, start, count, throttle);
    },
  };
}

export async function readInputBlock(
  client: ModbusClient,
  startAddr: number,
  count: number,
  throttle?: Throttle,
): Promise<Map<number, number>> {
  if (throttle) await throttle.wait();
  const pduAddr = startAddr - 1;
  try {
    const result = await client.readInputRegisters(pduAddr, count);
    const map = new Map<number, number>();
    for (let i = 0; i < result.data.length; i++) {
      map.set(startAddr + i, result.data[i]);
    }
    return map;
  } catch (err) {
    throw wrapModbusError(err, `readInput@${startAddr}+${count}`);
  }
}

export async function readHoldingBlock(
  client: ModbusClient,
  startAddr: number,
  count: number,
  throttle?: Throttle,
): Promise<Map<number, number>> {
  if (throttle) await throttle.wait();
  const pduAddr = startAddr - 1;
  try {
    const result = await client.readHoldingRegisters(pduAddr, count);
    const map = new Map<number, number>();
    for (let i = 0; i < result.data.length; i++) {
      map.set(startAddr + i, result.data[i]);
    }
    return map;
  } catch (err) {
    throw wrapModbusError(err, `readHolding@${startAddr}+${count}`);
  }
}
