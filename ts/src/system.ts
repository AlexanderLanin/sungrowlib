import type {
  InverterInfo,
  RegisterValue,
  ModbusTransaction,
  ReadResult,
  ReadOptions,
  Logger,
  ConnectionState,
  ReconnectOptions,
  ConnectionStateCallback,
} from './core/types.js';
import { ConnectionError } from './core/errors.js';
import type { ConnectionStats } from './core/stats.js';
import { createStats } from './core/stats.js';
import { SungrowInverter, type ClientFactory } from './inverter/inverter.js';

export interface SungrowSystemOptions {
  hosts: string[];
  cachedActiveGroups?: Record<string, boolean>;
  clientFactory?: ClientFactory;
  logger?: Logger;
  reconnect?: ReconnectOptions;
  onStateChange?: ConnectionStateCallback;
  onBlockRead?: (tx: ModbusTransaction) => void;
}

function parseHost(hostStr: string): { host: string; port: number } {
  const colonIdx = hostStr.lastIndexOf(':');
  if (colonIdx > 0) {
    const port = parseInt(hostStr.slice(colonIdx + 1), 10);
    if (!isNaN(port)) return { host: hostStr.slice(0, colonIdx), port };
  }
  return { host: hostStr, port: 502 };
}

const PARTIAL_RETRY_DELAY_MS = 30_000;

/** Multi-inverter system with automatic master/slave detection. */
export class SungrowSystem {
  private master: SungrowInverter | undefined;
  private slaves: SungrowInverter[] = [];
  private inverterHosts = new Map<SungrowInverter, string>();
  private options: SungrowSystemOptions;
  private _state: ConnectionState = 'idle';
  private _reconnectAttempts = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private _partialRetryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SungrowSystemOptions) {
    if (options.hosts.length === 0) throw new Error('At least one host required');
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this._state === 'connected' || this._state === 'reconnecting') {
      await this.disconnect();
    }
    this._state = 'connecting';
    try {
      await this.connectInverters();
      this._state = 'connected';
      this._reconnectAttempts = 0;
      this.options.onStateChange?.('connected');
      if (this.hasPartialConnection && this.options.reconnect) {
        this.schedulePartialRetry();
      }
    } catch (err) {
      this._state = 'idle';
      throw err;
    }
  }

  private async connectInverters(): Promise<void> {
    const entries = this.options.hosts.map((hostStr) => {
      const { host, port } = parseHost(hostStr);
      return {
        inverter: new SungrowInverter({
          host,
          port,
          cachedActiveGroups: this.options.cachedActiveGroups,
          clientFactory: this.options.clientFactory,
          logger: this.options.logger,
          onBlockRead: this.options.onBlockRead,
        }),
        hostStr,
      };
    });

    const results = await Promise.allSettled(
      entries.map((e) => e.inverter.connect()),
    );

    const connected: { inverter: SungrowInverter; host: string }[] = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled') {
        connected.push({ inverter: entries[i].inverter, host: entries[i].hostStr });
      } else {
        if (this.options.logger) {
          this.options.logger(`${entries[i].hostStr} connect failed: ${(results[i] as PromiseRejectedResult).reason}`);
        }
      }
    }

    if (connected.length === 0) throw new Error('No inverters reachable');

    if (connected.length === 1) {
      this.master = connected[0].inverter;
      this.slaves = [];
    } else {
      const masters = connected.filter((c) => c.inverter.info?.connectionMode === 'master');
      if (masters.length === 0) throw new Error('No master detected among connected inverters');
      if (masters.length > 1) throw new Error('Multiple masters detected');
      this.master = masters[0].inverter;
      this.slaves = connected.filter((c) => c !== masters[0]).map((c) => c.inverter);
    }

    this.inverterHosts.clear();
    for (const c of connected) this.inverterHosts.set(c.inverter, c.host);
  }

  async disconnect(): Promise<void> {
    if (this._state === 'idle' || this._state === 'disconnected') return;
    this.clearReconnectTimer();
    await this.master?.disconnect();
    for (const slave of this.slaves) {
      await slave.disconnect();
    }
    this.master = undefined;
    this.slaves = [];
    this.inverterHosts.clear();
    this._state = 'disconnected';
    this.options.onStateChange?.('disconnected');
  }

  get state(): ConnectionState { return this._state; }
  get info(): InverterInfo | undefined { return this.master?.info; }
  get model(): string | null { return this.master?.model ?? null; }
  get activeGroups(): Record<string, boolean> { return this.master?.activeGroups ?? {}; }
  get lastRawWords(): Record<number, number> { return this.master?.lastRawWords ?? {}; }
  get lastValues(): RegisterValue[] { return this.master?.lastValues ?? []; }
  get masterHost(): string | null { return this.master ? (this.inverterHosts.get(this.master) ?? null) : null; }
  get hasSlaves(): boolean { return this.slaves.length > 0; }
  get stats(): Readonly<ConnectionStats> { return this.master?.stats ?? createStats(); }

  /**
   * True when connected but the system is incomplete:
   * - fewer hosts connected than configured, OR
   * - master reports slaves (inverter_count register) but none are connected, OR
   * - only a slave connected (master is absent from the system)
   */
  get hasPartialConnection(): boolean {
    if (this.options.hosts.length > 1) {
      const connectedCount = (this.master ? 1 : 0) + this.slaves.length;
      if (connectedCount < this.options.hosts.length) return true;
    }
    if ((this.info?.slaveCount ?? 0) > 0 && !this.hasSlaves) return true;
    if (this.info?.connectionMode === 'slave' && !this.hasSlaves) return true;
    return false;
  }

  get slaveDetails(): ReadonlyArray<{
    host: string; slaveId: number; model: string | null;
    activeGroups: Record<string, boolean>;
    lastRawWords: Record<number, number>; lastValues: RegisterValue[];
  }> {
    return this.slaves.map((s) => ({
      host: this.inverterHosts.get(s) ?? '?',
      slaveId: s.info?.slaveId ?? 0,
      model: s.model,
      activeGroups: s.activeGroups,
      lastRawWords: s.lastRawWords,
      lastValues: s.lastValues,
    }));
  }

  async read(options?: ReadOptions): Promise<ReadResult> {
    try {
      return await this.requireMaster().read(options);
    } catch (err) {
      if (err instanceof ConnectionError && this.options.reconnect) {
        this.scheduleReconnect(err.message);
      }
      throw err;
    }
  }

  async *readStream(options?: ReadOptions): AsyncGenerator<ReadResult> {
    try {
      yield* this.requireMaster().readStream(options);
    } catch (err) {
      if (err instanceof ConnectionError && this.options.reconnect) {
        this.scheduleReconnect(err.message);
      }
      throw err;
    }
  }

  async readSlaves(options?: ReadOptions): Promise<ReadResult[]> {
    const results: ReadResult[] = [];
    for (const slave of this.slaves) {
      try {
        results.push(await slave.read(options));
      } catch (err) {
        if (this.options.logger) this.options.logger(`slave read failed: ${err}`);
      }
    }
    return results;
  }

  private scheduleReconnect(reason?: string): void {
    if (this._state === 'reconnecting' || this._state === 'disconnected') return;
    this._state = 'reconnecting';
    this.options.onStateChange?.('reconnecting', reason);
    this.attemptReconnect();
  }

  private attemptReconnect(): void {
    const opts = this.options.reconnect!;
    const base = opts.baseDelayMs ?? 5000;
    const max = opts.maxDelayMs ?? 60000;
    const maxAttempts = opts.maxAttempts ?? Infinity;

    if (this._reconnectAttempts >= maxAttempts) {
      this._state = 'disconnected';
      this.options.onStateChange?.('disconnected', `gave up after ${this._reconnectAttempts} attempts`);
      return;
    }

    const delay = Math.min(base * Math.pow(2, this._reconnectAttempts), max);
    this._reconnectAttempts++;
    if (this.options.logger) {
      this.options.logger(`reconnect attempt ${this._reconnectAttempts} in ${delay}ms`);
    }
    this._reconnectTimer = setTimeout(() => this.doReconnect(), delay);
  }

  private async doReconnect(): Promise<void> {
    try {
      await this.master?.disconnect();
      for (const slave of this.slaves) await slave.disconnect();
      this.master = undefined;
      this.slaves = [];
      this.inverterHosts.clear();

      await this.connectInverters();
      this._state = 'connected';
      this._reconnectAttempts = 0;
      this.options.onStateChange?.('connected');
      if (this.hasPartialConnection && this.options.reconnect) {
        this.schedulePartialRetry();
      }
    } catch (err) {
      if (this.options.logger) {
        this.options.logger(`reconnect failed: ${err}`);
      }
      this.attemptReconnect();
    }
  }

  private schedulePartialRetry(): void {
    if (this._partialRetryTimer) return;
    this._partialRetryTimer = setTimeout(() => {
      this._partialRetryTimer = undefined;
      if (this._state === 'connected' && this.hasPartialConnection) {
        this.scheduleReconnect('partial connection: retrying missing hosts');
      }
    }, PARTIAL_RETRY_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
    if (this._partialRetryTimer) {
      clearTimeout(this._partialRetryTimer);
      this._partialRetryTimer = undefined;
    }
    this._reconnectAttempts = 0;
  }

  private requireMaster(): SungrowInverter {
    if (this._state === 'reconnecting') throw new ConnectionError('Reconnecting');
    if (this._state === 'disconnected') throw new ConnectionError('Disconnected');
    if (!this.master) throw new Error('Not connected — call connect() first');
    return this.master;
  }
}
