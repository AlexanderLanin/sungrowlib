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
}

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
  supported: boolean;
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
export interface ReadResult {
  values: Map<string, RegisterValue>;
  transactions: ModbusTransaction[];
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
