export type RegisterType = 'read' | 'hold';

export type CatalogDataType = 'U16' | 'S16' | 'U32' | 'S32' | 'UTF-8';

export interface CatalogRegister {
  name: string;
  address: number;
  type: RegisterType;
  baseDataType: CatalogDataType;
  arrayLength: number;
  registerWidth: number;
  level: number;
  scale?: number;
  unit?: string;
  description?: string;
  group?: string | string[];
  indicator?: string;
  models?: string[];
  modelsExclude?: string[];
  decoded?: Record<number, string>;
  mask?: number;
  unsupportedValue?: number | null;
}

/** Decoded register value after applying scale, lookup, or mask. */
export type DecodedValue = number | string | boolean | number[] | null;

export type Logger = (msg: string, data?: unknown) => void;

/** Filter which registers to read — by explicit names, max level (1–5), or both. */
export interface ReadOptions {
  names?: readonly string[];
  maxLevel?: number;
  /** Also return registers that were incidentally read as part of block coalescing. */
  includeIncidental?: boolean;
}

/**
 * 'yes'            — confirmed supported (non-zero value observed)
 * 'unsupported'    — Modbus exception; register does not exist on this device
 * 'not-applicable' — register exists but returned a built-in or catalog NA value
 * 'unknown'        — returned 0 on all reads; may be inactive or genuinely zero
 */
export type Support = 'yes' | 'unsupported' | 'not-applicable' | 'unknown';

export interface RegisterValue {
  name: string;
  address: number;
  type: RegisterType;
  dataType: CatalogDataType;
  level: number;
  group?: string | string[];
  indicator?: string;
  unit?: string;
  raw: number | number[];
  value: DecodedValue;
  supported: Support;
  /** Present when this register was not explicitly requested but fell within a coalesced block. */
  incidental?: true;
}

export type TransactionReason = 'read' | 'verification' | 'connect';

/** Trace of a single Modbus block read (FC03/FC04 request-response). */
export interface ModbusTransaction {
  host: string;
  reason: TransactionReason;
  type: RegisterType;
  startAddress: number;
  length: number;
  registerNames: string[];
  durationMs: number;
  retries: number;
  status: 'ok' | 'unsupported' | 'error';
  errorMessage?: string;
}

/** Result of a read operation — values and the Modbus transactions that produced them. */
export class ReadResult {
  constructor(
    readonly values: Map<string, RegisterValue>,
    readonly transactions: ModbusTransaction[],
  ) {}

  getString(name: string): string | null {
    const v = this.values.get(name);
    if (!v) return null;
    if (v.value !== null && typeof v.value !== 'string')
      throw new Error(`Register '${name}' is not a string register`);
    return v.value;
  }

  getNumber(name: string): number | null {
    const v = this.values.get(name);
    if (!v) return null;
    if (v.value !== null && typeof v.value !== 'number')
      throw new Error(`Register '${name}' is not a number register`);
    return v.value;
  }

  getBoolean(name: string): boolean | null {
    const v = this.values.get(name);
    if (!v) return null;
    if (v.value !== null && typeof v.value !== 'boolean')
      throw new Error(`Register '${name}' is not a boolean register`);
    return v.value;
  }

  getValue(name: string): DecodedValue | undefined {
    return this.values.get(name)?.value;
  }
}

export interface ExtendedReadResult {
  timestamp: string;
  model: string | null;
  activeGroups: Record<string, boolean>;
  values: RegisterValue[];
  rawWords: Record<number, number>;
}

export interface RegisterRange {
  readonly type: RegisterType;
  readonly start: number;
  readonly length: number;
}

export type ConnectionMode = 'standalone' | 'master' | 'slave';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface ReconnectOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

export type ConnectionStateCallback = (state: ConnectionState, detail?: string) => void;

/** Identity and topology info returned by connect(). */
export interface InverterInfo {
  serialNumber: string | null;
  model: string | null;
  connectionMode: ConnectionMode;
  slaveId: number;
  slaveCount: number;
  hasBattery: boolean;
  hasMeter: boolean;
  outputType: string | null;
  /** Fingerprint of the physical inverter setup. Changes when reliably
   *  detectable properties change (serial, model, battery, meter, master).
   *  Callers should discard cached activeGroups when this changes. */
  setupId: string;
}
