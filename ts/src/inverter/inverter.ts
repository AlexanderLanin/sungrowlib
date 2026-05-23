import type {
  InverterInfo,
  CatalogRegister,
  DecodedValue,
  RegisterValue,
  ModbusTransaction,
  ReadResult,
  ReadOptions,
  Logger,
  ConnectionState,
} from '../core/types.js';
import type { Transport } from '../transport/transport.js';
import {
  type ModbusClient,
  createModbusClient,
  createModbusTransport,
} from '../transport/modbus.js';
import { ConnectionError } from '../core/errors.js';
import { loadCatalog, type RegisterCatalog } from '../registers/catalog.js';
import { computeBlocks, readBlock, decodeBlock, ProblematicRegisters, type BlockPlan } from '../registers/block-io.js';

import { type ConnectionStats, createStats } from '../core/stats.js';
import { SignalStateTracker } from '../core/signal-state.js';
import { applyComputed, BUILTIN_COMPUTED, type ComputedRegister } from '../registers/computed.js';

export type ClientFactory = (host: string, port: number) => Promise<ModbusClient>;

export interface SungrowInverterOptions {
  host: string;
  port?: number;
  /** Modbus slave ID. If omitted, probes [1, 2] automatically. */
  slaveId?: number;
  /** Slave IDs to probe when slaveId is not set. Default: [1, 2] */
  probeSlaveIds?: number[];
  /** Previously cached activeGroups from a prior connect().
   *  Groups detected as true in the cache are preserved when fresh
   *  detection returns false (e.g. MPPT current=0 at night). */
  cachedActiveGroups?: Record<string, boolean>;
  clientFactory?: ClientFactory;
  logger?: Logger;
  onBlockRead?: (tx: ModbusTransaction) => void;
}

/** Single Sungrow inverter connection over Modbus TCP. */
export class SungrowInverter {
  private transport: Transport | undefined;
  private client: ModbusClient | undefined;
  private host: string;
  private port: number;
  private slaveId: number | undefined;
  private probeSlaveIds: number[];
  private clientFactory: ClientFactory;
  private catalog: RegisterCatalog;
  private computedRegisters: ComputedRegister[];
  private logger: Logger | undefined;
  private onBlockRead: ((tx: ModbusTransaction) => void) | undefined;

  private cachedActiveGroups: Record<string, boolean> | undefined;

  private _info: InverterInfo | undefined;
  private _serialNumber: string | null = null;
  private _model: string | null = null;
  private _activeGroups: Record<string, boolean> = {};
  private _applicableRegisters: CatalogRegister[] = [];
  private _applicableRegistersReady = false;
  private _lastRawWords: Record<number, number> = {};
  private _lastValues: RegisterValue[] = [];
  private _state: ConnectionState = 'idle';
  private _stats: ConnectionStats = createStats();
  private _problematic = new ProblematicRegisters();
  private _signalStates = new SignalStateTracker();

  constructor(options: SungrowInverterOptions) {
    this.host = options.host;
    this.port = options.port ?? 502;
    this.slaveId = options.slaveId;
    this.probeSlaveIds = options.probeSlaveIds ?? [1, 2];
    this.cachedActiveGroups = options.cachedActiveGroups;
    this.clientFactory = options.clientFactory ?? createModbusClient;
    this.catalog = loadCatalog();
    this.computedRegisters = BUILTIN_COMPUTED;
    this.logger = options.logger;
    this.onBlockRead = options.onBlockRead;
  }

  get info(): InverterInfo | undefined { return this._info; }
  get serialNumber(): string | null { return this._serialNumber; }
  get model(): string | null { return this._model; }
  get activeGroups(): Record<string, boolean> { return this._activeGroups; }
  get lastRawWords(): Record<number, number> { return this._lastRawWords; }
  get lastValues(): RegisterValue[] { return this._lastValues; }
  get state(): ConnectionState { return this._state; }
  get connected(): boolean { return this._state === 'connected'; }
  get stats(): Readonly<ConnectionStats> { return this._stats; }
  get problematicRegisters(): ProblematicRegisters { return this._problematic; }
  get signalStates(): SignalStateTracker { return this._signalStates; }

  /** Connect to the inverter and detect model, feature groups, and master/slave topology. */
  async connect(): Promise<InverterInfo> {
    if (this._state === 'connected' || this._state === 'reconnecting') {
      await this.disconnect();
    }
    this._state = 'connecting';
    try {
      return await this.doConnect();
    } catch (err) {
      this._state = 'idle';
      throw err;
    }
  }

  private async doConnect(): Promise<InverterInfo> {
    this._applicableRegistersReady = false;
    this.client = await this.clientFactory(this.host, this.port);
    this.transport = createModbusTransport(this.client);
    this._stats.connections++;

    if (this.slaveId != null) {
      this.transport.setSlaveId(this.slaveId);
    } else {
      this.slaveId = await this.probeSlaveId();
    }

    // One batch read for all detection data — serial, model, groups, output type, and
    // master/slave topology all land in one round-trip instead of 5 sequential ones.
    const detected = await this.detectStartupInfo();
    this._serialNumber = detected.serialNumber;
    this._model = detected.model;
    if (this.logger) this.logger(`slave=${this.slaveId}, serial=${this._serialNumber}, model=${this._model}`);

    let applicable = this._model
      ? this.catalog.filterByModel(this._model)
      : this.catalog.getAll();
    if (this._model) {
      applicable = this.catalog.applyModelOverrides(applicable, this._model);
    }

    this._activeGroups = detected.groups;
    // A group that was true before (e.g. has_battery) but reads zero now (e.g. at night when
    // MPPT current is 0) should stay true — the hardware didn't disappear, the value just dropped.
    if (this.cachedActiveGroups) {
      for (const [group, active] of Object.entries(this.cachedActiveGroups)) {
        if (active && this._activeGroups[group] === false) this._activeGroups[group] = true;
      }
    }
    if (this.logger) this.logger(`groups=${JSON.stringify(this._activeGroups)}`);

    this._applicableRegisters = this.catalog.filterByGroups(applicable, this._activeGroups);

    this._info = {
      serialNumber: this._serialNumber,
      model: this._model,
      connectionMode: 'standalone',
      slaveId: this.slaveId!,
      slaveCount: 0,
      hasBattery: this._activeGroups['has_battery'] === true,
      hasMeter: this._activeGroups['has_meter'] === true,
      outputType: detected.outputType,
      setupId: this.computeSetupId(),
    };

    if (detected.masterSlaveMode === 'Enabled') {
      this._info.slaveCount = typeof detected.inverterCount === 'number'
        ? detected.inverterCount - 1 : 0;
      if (detected.masterSlaveRole === 'Master') {
        this._info.connectionMode = 'master';
      } else if (detected.masterSlaveRole != null) {
        this._info.connectionMode = 'slave';
      }
    }
    // Only set after all detection is done — readStream() uses the full catalog while this
    // is false, so every read during connect goes through the normal path without filtering.
    this._applicableRegistersReady = true;

    const isMasterByGroups = this._activeGroups['is_master'] === true;
    const isMasterByRole = this._info.connectionMode !== 'slave';
    if (isMasterByGroups !== isMasterByRole) {
      if (this.logger) this.logger(`is_master inconsistency: groups=${isMasterByGroups}, role=${isMasterByRole}`);
    }

    this._state = 'connected';
    return this._info;
  }

  async disconnect(): Promise<void> {
    if (this._state === 'idle' || this._state === 'disconnected') return;
    if (this.transport) {
      await this.transport.disconnect();
      this.transport = undefined;
      this.client = undefined;
    }
    this._state = 'disconnected';
  }

  /** Read registers filtered by name and/or level. Returns values and the Modbus transactions that produced them. */
  async read(options?: ReadOptions): Promise<ReadResult> {
    const values = new Map<string, RegisterValue>();
    const transactions: ModbusTransaction[] = [];
    for await (const batch of this.readStream(options)) {
      for (const [name, v] of batch.values) values.set(name, v);
      transactions.push(...batch.transactions);
    }
    return { values, transactions };
  }

  /** Streaming read that yields ReadResult batches as each Modbus block completes. */
  async *readStream(options?: ReadOptions): AsyncGenerator<ReadResult> {
    this.requireTransport();
    let registers: CatalogRegister[];
    const useFullCatalog = !this._applicableRegistersReady;

    if (useFullCatalog) {
      if (options?.names) {
        const nameSet = new Set(options.names);
        registers = [...nameSet]
          .map((n) => this.catalog.getByName(n))
          .filter((r): r is CatalogRegister => r != null);
      } else {
        registers = this.catalog.getAll();
      }
    } else if (options?.names && options?.maxLevel) {
      const nameSet = new Set(options.names);
      const byLevel = this._applicableRegisters.filter((r) => r.level <= options.maxLevel!);
      const byName = this._applicableRegisters.filter((r) => nameSet.has(r.name));
      const combined = new Map<string, CatalogRegister>();
      for (const r of byLevel) combined.set(r.name, r);
      for (const r of byName) combined.set(r.name, r);
      registers = [...combined.values()];
    } else if (options?.names) {
      const nameSet = new Set(options.names);
      registers = this._applicableRegisters.filter((r) => nameSet.has(r.name));
    } else if (options?.maxLevel) {
      registers = this._applicableRegisters.filter((r) => r.level <= options.maxLevel!);
    } else {
      registers = this._applicableRegisters;
    }

    const blocks = useFullCatalog
      ? computeBlocks(registers)
      : computeBlocks(registers, this._problematic);
    const registersByName = new Map(registers.map((r) => [r.name, r]));
    const allRawWords: Record<number, number> = {};
    const allValues: RegisterValue[] = [];
    const allDecoded = new Map<string, DecodedValue>();

    for (const block of blocks) {
      const blockStart = Date.now();
      let retries = 0;
      try {
        const currentTransport = this.requireTransport();
        const rawMap = await readBlock(currentTransport, block, {
          reconnect: useFullCatalog ? undefined : () => this.reconnectTransport(),
          onRetry: () => retries++,
        });
        this._stats.readCallsSuccess++;
        const txReason = useFullCatalog ? 'connect' as const : 'read' as const;
        const tx: ModbusTransaction = {
          host: this.host, reason: txReason, type: block.type, startAddress: block.start, length: block.length,
          registerNames: block.registers.map((r) => r.name),
          durationMs: Date.now() - blockStart, retries,
          status: rawMap.size === 0 ? 'unsupported' : 'ok',
        };
        this.onBlockRead?.(tx);
        for (const [addr, val] of rawMap) {
          allRawWords[addr] = val;
        }
        const decoded = decodeBlock(block, rawMap);

        const incidentals: RegisterValue[] = [];
        if (options?.includeIncidental) {
          const requestedAddrs = new Set<number>();
          for (const reg of block.registers) {
            for (let i = 0; i < reg.registerWidth; i++) requestedAddrs.add(reg.address + i);
          }
          const seen = new Set<string>();
          for (const [addr] of rawMap) {
            if (requestedAddrs.has(addr)) continue;
            const incReg = this.catalog.getByAddress(addr, block.type);
            if (!incReg || seen.has(incReg.name)) continue;
            seen.add(incReg.name);
            const miniBlock: BlockPlan = {
              type: block.type, start: incReg.address, length: incReg.registerWidth, registers: [incReg],
            };
            for (const v of decodeBlock(miniBlock, rawMap)) {
              incidentals.push({ ...v, incidental: true });
            }
          }
        }

        this._stats.retrievedSignalsSuccess += decoded.length + incidentals.length;
        const isMulti = block.registers.length > 1;
        for (const v of [...decoded, ...incidentals]) {
          const rawNum = typeof v.raw === 'number' ? v.raw : null;
          this._signalStates.update(v.name, rawNum, isMulti ? 'multi' : 'single', v.supported === 'not-applicable');
          const isSupp = this._signalStates.isSupported(v.name);
          if (isSupp === false && v.supported === 'yes') v.supported = 'unknown';
          allDecoded.set(v.name, v.value);
          allValues.push(v);
        }

        this._lastRawWords = { ...allRawWords };
        this._lastValues = [...allValues];
        this._stats.lastReadTimestamp = new Date().toISOString();

        yield {
          values: new Map([...decoded, ...incidentals].map((v) => [v.name, v])),
          transactions: [tx],
        };
      } catch (err) {
        this._stats.readCallsFailed++;
        const tx: ModbusTransaction = {
          host: this.host, reason: useFullCatalog ? 'connect' : 'read', type: block.type, startAddress: block.start, length: block.length,
          registerNames: block.registers.map((r) => r.name),
          durationMs: Date.now() - blockStart, retries,
          status: 'error',
          errorMessage: err instanceof Error ? err.message : String(err),
        };
        this.onBlockRead?.(tx);
        if (err instanceof ConnectionError) {
          throw err;
        }
        this._stats.retrievedSignalsFailed += block.registers.length;
        this._problematic.mark(block.type, block.start, block.length);
        if (this.logger) this.logger(`block ${block.type}@${block.start} failed: ${err}`);
      }
    }

    const pendingNames = useFullCatalog ? [] : this._signalStates.getPendingVerifications();
    if (pendingNames.length > 0) {
      const verificationValues: RegisterValue[] = [];
      const verificationTransactions: ModbusTransaction[] = [];

      for (const name of pendingNames) {
        const reg = registersByName.get(name);
        if (!reg) continue;

        const singleBlock: BlockPlan = {
          type: reg.type, start: reg.address,
          length: reg.registerWidth, registers: [reg],
        };

        const blockStart = Date.now();
        let retries = 0;
        try {
          const currentTransport = this.requireTransport();
          const rawMap = await readBlock(currentTransport, singleBlock, {
            reconnect: () => this.reconnectTransport(),
            onRetry: () => retries++,
          });

          const wasUnsupported = rawMap.size === 0;
          const tx: ModbusTransaction = {
            host: this.host, reason: 'verification', type: singleBlock.type,
            startAddress: singleBlock.start, length: singleBlock.length,
            registerNames: [name],
            durationMs: Date.now() - blockStart, retries,
            status: wasUnsupported ? 'unsupported' : 'ok',
          };
          this.onBlockRead?.(tx);
          verificationTransactions.push(tx);

          if (wasUnsupported) {
            this._signalStates.update(name, null, 'single', true);
            const existingIdx = allValues.findIndex((av) => av.name === name);
            if (existingIdx >= 0) {
              const updated = { ...allValues[existingIdx], supported: 'unsupported' as const };
              allValues[existingIdx] = updated;
              verificationValues.push(updated);
            }
          } else {
            for (const [addr, val] of rawMap) {
              allRawWords[addr] = val;
            }
            const decoded = decodeBlock(singleBlock, rawMap);
            if (decoded.length === 0) {
              this._signalStates.update(name, null, 'single');
            }
            for (const v of decoded) {
              const rawNum = typeof v.raw === 'number' ? v.raw : null;
              this._signalStates.update(v.name, rawNum, 'single');
              const isSupp = this._signalStates.isSupported(v.name);
              if (isSupp === false && v.supported === 'yes') v.supported = 'unknown';
              allDecoded.set(v.name, v.value);
              verificationValues.push(v);
              const existingIdx = allValues.findIndex((av) => av.name === v.name);
              if (existingIdx >= 0) allValues[existingIdx] = v;
              else allValues.push(v);
            }
          }
        } catch (err) {
          const tx: ModbusTransaction = {
            host: this.host, reason: 'verification', type: singleBlock.type,
            startAddress: singleBlock.start, length: singleBlock.length,
            registerNames: [name],
            durationMs: Date.now() - blockStart, retries,
            status: 'error',
            errorMessage: err instanceof Error ? err.message : String(err),
          };
          this.onBlockRead?.(tx);
          verificationTransactions.push(tx);

          if (err instanceof ConnectionError) throw err;
          if (this.logger) this.logger(`verification of ${name} failed: ${err}`);
        }
      }

      if (verificationValues.length > 0 || verificationTransactions.length > 0) {
        this._lastRawWords = { ...allRawWords };
        this._lastValues = [...allValues];
        yield {
          values: new Map(verificationValues.map((v) => [v.name, v])),
          transactions: verificationTransactions,
        };
      }
    }

    applyComputed(allDecoded, this.computedRegisters);

    const computedBatch: RegisterValue[] = [];
    for (const cr of this.computedRegisters) {
      if (cr.dependencies.some((dep) => !allDecoded.has(dep))) continue;
      const value = allDecoded.get(cr.name);
      if (value === undefined) continue;
      const rv: RegisterValue = {
        name: cr.name,
        address: 0,
        type: 'read',
        dataType: 'U16',
        level: 0,
        ...(cr.unit && { unit: cr.unit }),
        raw: 0,
        value,
        supported: 'yes',
      };
      computedBatch.push(rv);
      allValues.push(rv);
    }

    if (computedBatch.length > 0) {
      this._lastValues = [...allValues];
      yield {
        values: new Map(computedBatch.map((v) => [v.name, v])),
        transactions: [],
      };
    }
  }

  private async probeSlaveId(): Promise<number> {
    const transport = this.requireTransport();

    for (const id of this.probeSlaveIds) {
      transport.setSlaveId(id);
      try {
        const result = await this.read({ names: ['device_type_code'] });
        const v = result.values.get('device_type_code');
        if (v && v.supported !== 'unsupported' && v.supported !== 'not-applicable' && v.value !== null && v.value !== 0) {
          if (this.logger) this.logger(`slave ID ${id} responded`);
          return id;
        }
      } catch {
        if (this.logger) this.logger(`slave ID ${id} did not respond`);
      }
    }

    const fallback = this.probeSlaveIds[0] ?? 1;
    if (this.logger) this.logger(`no slave ID responded, using ${fallback}`);
    transport.setSlaveId(fallback);
    return fallback;
  }

  private async detectStartupInfo(): Promise<{
    serialNumber: string | null;
    model: string | null;
    outputType: string | null;
    groups: Record<string, boolean>;
    masterSlaveMode: DecodedValue;
    masterSlaveRole: DecodedValue;
    inverterCount: DecodedValue;
  }> {
    const indicators = this.catalog.getGroupIndicators();
    // All names in one read() so computeBlocks can coalesce adjacent addresses into
    // multi-register blocks rather than issuing one Modbus call per detection method.
    const result = await this.read({
      names: [
        'serial_number', 'device_type_code', 'output_type',
        'master_slave_mode', 'master_slave_role', 'inverter_count',
        ...indicators.map((r) => r.name),
      ],
    });

    const get = (name: string) => result.values.get(name);

    const groups: Record<string, boolean> = {};
    for (const ind of indicators) {
      const v = get(ind.name);
      groups[ind.indicator!] = v != null
        && v.supported !== 'unsupported'
        && v.supported !== 'not-applicable'
        && v.value !== null
        && v.value !== 0;
    }

    return {
      serialNumber: typeof get('serial_number')?.value === 'string'
        ? (get('serial_number')!.value as string) : null,
      model: typeof get('device_type_code')?.value === 'string'
        ? (get('device_type_code')!.value as string) : null,
      outputType: typeof get('output_type')?.value === 'string'
        ? (get('output_type')!.value as string) : null,
      groups,
      masterSlaveMode: get('master_slave_mode')?.value ?? null,
      masterSlaveRole: get('master_slave_role')?.value ?? null,
      inverterCount: get('inverter_count')?.value ?? null,
    };
  }

  // Attempts to fingerprint the physical inverter setup.
  // Based only on values that are reliably detectable at any time (including night).
  // Callers should discard cached activeGroups when this ID changes.
  private computeSetupId(): string {
    return [
      this._serialNumber, this._model,
      this._activeGroups['has_battery'],
      this._activeGroups['has_meter'],
      this._activeGroups['is_master'],
    ].join(':');
  }

  private async reconnectTransport(): Promise<Transport> {
    const prevState = this._state;
    this._state = 'reconnecting';
    if (this.logger) this.logger('reconnecting transport...');
    try {
      if (this.transport) {
        await this.transport.disconnect();
      }
      this.client = await this.clientFactory(this.host, this.port);
      this.transport = createModbusTransport(this.client);
      if (this.slaveId != null) {
        this.transport.setSlaveId(this.slaveId);
      }
      this._stats.reconnects++;
      this._state = 'connected';
      if (this.logger) this.logger('transport reconnected');
      return this.transport;
    } catch (err) {
      this._state = prevState;
      throw err;
    }
  }

  private requireTransport(): Transport {
    if (!this.transport) {
      if (this._state === 'disconnected') throw new ConnectionError('Disconnected');
      if (this._state === 'reconnecting') throw new ConnectionError('Reconnecting');
      throw new Error('Not connected — call connect() first');
    }
    return this.transport;
  }
}

