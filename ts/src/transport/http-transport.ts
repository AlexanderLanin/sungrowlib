import type { Transport } from './transport.js';
import {
  ConnectionError, InvalidResponseError,
  BusyError, TokenExpiredError, TooManyRetriesError,
} from '../core/errors.js';

export interface WiNetDevice {
  dev_id: number;
  dev_type: number;
  dev_code: number;
}

export interface WsMessage {
  result_code: number;
  result_msg: string;
  result_data: unknown;
}

export interface HttpResponse {
  result_code: number;
  result_msg: string;
  result_data: { param_value?: string } | null;
}

export interface HttpTransportDeps {
  openWebSocket(url: string): Promise<WebSocketLike>;
  httpGet(url: string): Promise<HttpResponse>;
}

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
}

export interface HttpTransportOptions {
  host: string;
  httpPort?: number;
  wsPort?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  busyDelayMs?: number;
  deps: HttpTransportDeps;
}

const DEFAULT_HTTP_PORT = 80;
const DEFAULT_WS_PORT = 8082;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_BUSY_DELAY_MS = 5000;

export function parseHexRegisters(hexString: string): number[] {
  const bytes = hexString.trim().split(/\s+/).map((h) => parseInt(h, 16));
  if (bytes.length > 0 && bytes[bytes.length - 1] === 0) {
    bytes.pop();
  }
  const registers: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    registers.push((bytes[i] << 8) | bytes[i + 1]);
  }
  return registers;
}

export function buildRegisterMap(start: number, registers: number[]): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < registers.length; i++) {
    map.set(start + i, registers[i]);
  }
  return map;
}

export class HttpTransport implements Transport {
  private _host: string;
  private _httpPort: number;
  private _wsPort: number;
  private _maxRetries: number;
  private _retryDelayMs: number;
  private _busyDelayMs: number;
  private _deps: HttpTransportDeps;

  private _token: string | null = null;
  private _device: WiNetDevice | null = null;
  private _ws: WebSocketLike | null = null;
  private _slaveId = 1;

  constructor(options: HttpTransportOptions) {
    this._host = options.host;
    this._httpPort = options.httpPort ?? DEFAULT_HTTP_PORT;
    this._wsPort = options.wsPort ?? DEFAULT_WS_PORT;
    this._maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this._retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this._busyDelayMs = options.busyDelayMs ?? DEFAULT_BUSY_DELAY_MS;
    this._deps = options.deps;
  }

  get connected(): boolean { return this._token !== null; }
  get token(): string | null { return this._token; }
  get device(): WiNetDevice | null { return this._device; }

  async connect(): Promise<void> {
    const wsUrl = `ws://${this._host}:${this._wsPort}/ws/home/overview`;
    try {
      this._ws = await this._deps.openWebSocket(wsUrl);
    } catch (err) {
      throw new ConnectionError(`WebSocket connect to ${wsUrl} failed`, {
        cause: err instanceof Error ? err : undefined,
      });
    }

    this._token = await this.authenticate();
    this._device = await this.discoverDevice();
  }

  async disconnect(): Promise<void> {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._token = null;
    this._device = null;
  }

  setSlaveId(id: number): void {
    this._slaveId = id;
  }

  async readInputRegisters(start: number, count: number): Promise<Map<number, number>> {
    return this.readRegisters('input', start, count);
  }

  async readHoldingRegisters(start: number, count: number): Promise<Map<number, number>> {
    return this.readRegisters('hold', start, count);
  }

  private async readRegisters(type: 'input' | 'hold', start: number, count: number): Promise<Map<number, number>> {
    if (!this._token || !this._device) {
      throw new ConnectionError('Not connected — call connect() first');
    }

    for (let attempt = 0; attempt < this._maxRetries; attempt++) {
      const params = new URLSearchParams({
        token: this._token,
        dev_id: String(this._device.dev_id),
        dev_type: String(this._device.dev_type),
        dev_code: String(this._device.dev_code),
        type: type === 'hold' ? '1' : '0',
        param_addr: String(start),
        param_num: String(count),
      });

      const url = `http://${this._host}:${this._httpPort}/device/getParam?${params}`;
      let resp: HttpResponse;

      try {
        resp = await this._deps.httpGet(url);
      } catch (err) {
        throw new ConnectionError(`HTTP request failed: ${url}`, {
          cause: err instanceof Error ? err : undefined,
        });
      }

      if (resp.result_code === 1) {
        const paramValue = resp.result_data?.param_value;
        if (paramValue === undefined || paramValue === null) {
          throw new InvalidResponseError('Missing param_value in response');
        }
        const registers = parseHexRegisters(paramValue);
        return buildRegisterMap(start, registers);
      }

      if (resp.result_code === 106) {
        this._token = null;
        throw new TokenExpiredError();
      }

      if (resp.result_code === 301) {
        if (attempt < this._maxRetries - 1) {
          await delay(this._busyDelayMs);
          continue;
        }
        throw new BusyError();
      }

      throw new InvalidResponseError(`Unexpected result_code ${resp.result_code}: ${resp.result_msg}`);
    }

    throw new TooManyRetriesError(this._maxRetries);
  }

  private authenticate(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!this._ws) { reject(new ConnectionError('WebSocket not open')); return; }

      const timeout = setTimeout(() => reject(new ConnectionError('WebSocket auth timed out')), 10000);

      this._ws.onMessage((raw) => {
        clearTimeout(timeout);
        try {
          const msg: WsMessage = JSON.parse(raw);
          if (msg.result_code !== 0) {
            reject(new ConnectionError(`Auth failed: ${msg.result_msg}`));
            return;
          }
          const data = msg.result_data as { token?: string };
          if (!data?.token) {
            reject(new InvalidResponseError('No token in auth response'));
            return;
          }
          resolve(data.token);
        } catch (err) {
          reject(new InvalidResponseError(`Invalid auth response: ${raw}`));
        }
      });

      this._ws.send(JSON.stringify({ service: 'connect', token: '' }));
    });
  }

  private discoverDevice(): Promise<WiNetDevice> {
    return new Promise<WiNetDevice>((resolve, reject) => {
      if (!this._ws) { reject(new ConnectionError('WebSocket not open')); return; }

      const timeout = setTimeout(() => reject(new ConnectionError('Device discovery timed out')), 10000);

      this._ws.onMessage((raw) => {
        clearTimeout(timeout);
        try {
          const msg: WsMessage = JSON.parse(raw);
          if (msg.result_code !== 0) {
            reject(new ConnectionError(`Device discovery failed: ${msg.result_msg}`));
            return;
          }
          const devices = msg.result_data as WiNetDevice[];
          if (!Array.isArray(devices) || devices.length === 0) {
            reject(new InvalidResponseError('No devices found'));
            return;
          }
          resolve(devices[0]);
        } catch {
          reject(new InvalidResponseError(`Invalid device list response: ${raw}`));
        }
      });

      this._ws.send(JSON.stringify({ service: 'devicelist' }));
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
