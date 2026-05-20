export class SungrowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SungrowError';
  }
}

export class ConnectionError extends SungrowError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConnectionError';
  }
}

export class TimeoutError extends ConnectionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TimeoutError';
  }
}

export class ModbusProtocolError extends SungrowError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModbusProtocolError';
  }
}

export class UnsupportedRegisterError extends SungrowError {
  readonly startAddress: number;
  readonly count: number;

  constructor(startAddress: number, count: number, options?: ErrorOptions) {
    super(`Registers ${startAddress}–${startAddress + count - 1} not supported`, options);
    this.name = 'UnsupportedRegisterError';
    this.startAddress = startAddress;
    this.count = count;
  }
}

export class BusyError extends SungrowError {
  constructor(message = 'Device busy', options?: ErrorOptions) {
    super(message, options);
    this.name = 'BusyError';
  }
}

export class TokenExpiredError extends SungrowError {
  constructor(message = 'Token expired', options?: ErrorOptions) {
    super(message, options);
    this.name = 'TokenExpiredError';
  }
}

export class TooManyRetriesError extends SungrowError {
  readonly attempts: number;
  constructor(attempts: number, options?: ErrorOptions) {
    super(`Failed after ${attempts} attempts`, options);
    this.name = 'TooManyRetriesError';
    this.attempts = attempts;
  }
}

export class InvalidResponseError extends SungrowError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidResponseError';
  }
}

export function wrapModbusError(err: unknown, context?: string): SungrowError {
  if (err instanceof SungrowError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? err : undefined;
  const lower = message.toLowerCase();

  if (lower.includes('illegal data address') || lower.includes('illegal address')) {
    return new UnsupportedRegisterError(0, 0, { cause });
  }

  if (lower.includes('gateway target device failed') || lower.includes('slave failure')) {
    return new ModbusProtocolError(context ? `${context}: ${message}` : message, { cause });
  }

  if (lower.includes('gateway no response') || lower.includes('no response')) {
    return new ModbusProtocolError(context ? `${context}: ${message}` : message, { cause });
  }

  if (lower.includes('timed out') || lower.includes('timeout')) {
    return new TimeoutError(context ? `${context}: ${message}` : message, { cause });
  }

  if (
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('epipe') ||
    lower.includes('port not open') ||
    lower.includes('not connected')
  ) {
    return new ConnectionError(context ? `${context}: ${message}` : message, { cause });
  }

  return new SungrowError(context ? `${context}: ${message}` : message, { cause });
}
