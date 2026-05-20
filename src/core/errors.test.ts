import { describe, it, expect } from 'vitest';
import {
  SungrowError, ConnectionError, TimeoutError,
  ModbusProtocolError, UnsupportedRegisterError, wrapModbusError,
} from './errors.js';

describe('error hierarchy', () => {
  it('ConnectionError extends SungrowError', () => {
    const err = new ConnectionError('conn failed');
    expect(err).toBeInstanceOf(SungrowError);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.name).toBe('ConnectionError');
  });

  it('TimeoutError extends ConnectionError', () => {
    const err = new TimeoutError('timed out');
    expect(err).toBeInstanceOf(SungrowError);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.name).toBe('TimeoutError');
  });

  it('ModbusProtocolError extends SungrowError', () => {
    const err = new ModbusProtocolError('slave failure');
    expect(err).toBeInstanceOf(SungrowError);
    expect(err.name).toBe('ModbusProtocolError');
  });

  it('UnsupportedRegisterError has address info', () => {
    const err = new UnsupportedRegisterError(5000, 10);
    expect(err).toBeInstanceOf(SungrowError);
    expect(err.startAddress).toBe(5000);
    expect(err.count).toBe(10);
    expect(err.message).toContain('5000');
    expect(err.message).toContain('5009');
  });

  it('preserves cause chain', () => {
    const original = new Error('raw modbus error');
    const wrapped = new ConnectionError('connection lost', { cause: original });
    expect(wrapped.cause).toBe(original);
  });
});

describe('wrapModbusError', () => {
  it('wraps illegal address as UnsupportedRegisterError', () => {
    const err = wrapModbusError(new Error('Illegal data address'));
    expect(err).toBeInstanceOf(UnsupportedRegisterError);
  });

  it('wraps slave failure as ModbusProtocolError', () => {
    const err = wrapModbusError(new Error('Gateway target device failed to respond'));
    expect(err).toBeInstanceOf(ModbusProtocolError);
  });

  it('wraps gateway no response as ModbusProtocolError', () => {
    const err = wrapModbusError(new Error('Gateway no response'));
    expect(err).toBeInstanceOf(ModbusProtocolError);
  });

  it('wraps timeout as TimeoutError', () => {
    const err = wrapModbusError(new Error('Connection timed out'));
    expect(err).toBeInstanceOf(TimeoutError);
  });

  it('wraps ECONNREFUSED as ConnectionError', () => {
    const err = wrapModbusError(new Error('connect ECONNREFUSED 192.168.1.1:502'));
    expect(err).toBeInstanceOf(ConnectionError);
  });

  it('wraps ECONNRESET as ConnectionError', () => {
    const err = wrapModbusError(new Error('read ECONNRESET'));
    expect(err).toBeInstanceOf(ConnectionError);
  });

  it('wraps port not open as ConnectionError', () => {
    const err = wrapModbusError(new Error('Port Not Open'));
    expect(err).toBeInstanceOf(ConnectionError);
  });

  it('wraps unknown error as SungrowError', () => {
    const err = wrapModbusError(new Error('something unexpected'));
    expect(err).toBeInstanceOf(SungrowError);
    expect(err).not.toBeInstanceOf(ConnectionError);
    expect(err).not.toBeInstanceOf(ModbusProtocolError);
  });

  it('passes through existing SungrowError', () => {
    const original = new ConnectionError('already wrapped');
    const result = wrapModbusError(original);
    expect(result).toBe(original);
  });

  it('includes context in message', () => {
    const err = wrapModbusError(new Error('timed out'), 'readInput@5000+10');
    expect(err.message).toContain('readInput@5000+10');
  });

  it('handles non-Error values', () => {
    const err = wrapModbusError('string error');
    expect(err).toBeInstanceOf(SungrowError);
    expect(err.message).toContain('string error');
  });
});
