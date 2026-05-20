import { describe, it, expect, vi } from 'vitest';
import {
  parseHexRegisters, buildRegisterMap,
  HttpTransport,
  type HttpTransportDeps, type WebSocketLike, type HttpResponse,
} from './http-transport.js';
import { BusyError, ConnectionError, InvalidResponseError, TokenExpiredError, TooManyRetriesError } from '../core/errors.js';

describe('parseHexRegisters', () => {
  it('parses space-separated hex bytes into 16-bit registers', () => {
    expect(parseHexRegisters('00 0A 01 F4')).toEqual([10, 500]);
  });

  it('strips trailing null byte', () => {
    expect(parseHexRegisters('00 0A 01 F4 00')).toEqual([10, 500]);
  });

  it('handles empty string', () => {
    expect(parseHexRegisters('')).toEqual([]);
  });

  it('handles single register', () => {
    expect(parseHexRegisters('FF FF')).toEqual([0xFFFF]);
  });

  it('ignores odd trailing byte after null removal', () => {
    expect(parseHexRegisters('00 0A 01')).toEqual([10]);
  });
});

describe('buildRegisterMap', () => {
  it('maps registers with 1-based addresses', () => {
    const map = buildRegisterMap(5000, [0xE12, 42]);
    expect(map.get(5000)).toBe(0xE12);
    expect(map.get(5001)).toBe(42);
    expect(map.size).toBe(2);
  });
});

function createMockWs(responses: Record<string, unknown>): WebSocketLike {
  let handler: ((data: string) => void) | null = null;
  return {
    send(data: string) {
      const msg = JSON.parse(data);
      const key = msg.service as string;
      if (handler && responses[key]) {
        setTimeout(() => handler!(JSON.stringify(responses[key])), 0);
      }
    },
    close: vi.fn(),
    onMessage(h) { handler = h; },
  };
}

function createMockDeps(options: {
  wsResponses?: Record<string, unknown>;
  httpResponses?: Map<string, HttpResponse> | ((url: string) => HttpResponse);
}): HttpTransportDeps {
  const ws = createMockWs(options.wsResponses ?? {
    connect: { result_code: 0, result_msg: 'ok', result_data: { token: 'test-token-123' } },
    devicelist: { result_code: 0, result_msg: 'ok', result_data: [{ dev_id: 1, dev_type: 35, dev_code: 8726 }] },
  });

  return {
    openWebSocket: vi.fn(async () => ws),
    httpGet: vi.fn(async (url: string) => {
      if (typeof options.httpResponses === 'function') {
        return options.httpResponses(url);
      }
      if (options.httpResponses) {
        for (const [pattern, resp] of options.httpResponses) {
          if (url.includes(pattern)) return resp;
        }
      }
      return { result_code: 1, result_msg: 'ok', result_data: { param_value: '00 00' } };
    }),
  };
}

describe('HttpTransport', () => {
  describe('connect', () => {
    it('authenticates via WebSocket and discovers device', async () => {
      const deps = createMockDeps({});
      const transport = new HttpTransport({ host: '192.168.1.100', deps });

      await transport.connect();

      expect(transport.connected).toBe(true);
      expect(transport.token).toBe('test-token-123');
      expect(transport.device).toEqual({ dev_id: 1, dev_type: 35, dev_code: 8726 });
    });

    it('throws ConnectionError when WebSocket fails', async () => {
      const deps: HttpTransportDeps = {
        openWebSocket: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
        httpGet: vi.fn(),
      };
      const transport = new HttpTransport({ host: '192.168.1.100', deps });

      await expect(transport.connect()).rejects.toBeInstanceOf(ConnectionError);
      expect(transport.connected).toBe(false);
    });

    it('throws when auth returns error code', async () => {
      const deps = createMockDeps({
        wsResponses: {
          connect: { result_code: 1, result_msg: 'auth failed', result_data: {} },
          devicelist: { result_code: 0, result_msg: 'ok', result_data: [{ dev_id: 1, dev_type: 35, dev_code: 8726 }] },
        },
      });
      const transport = new HttpTransport({ host: '192.168.1.100', deps });

      await expect(transport.connect()).rejects.toBeInstanceOf(ConnectionError);
    });

    it('throws when no devices found', async () => {
      const deps = createMockDeps({
        wsResponses: {
          connect: { result_code: 0, result_msg: 'ok', result_data: { token: 'tok' } },
          devicelist: { result_code: 0, result_msg: 'ok', result_data: [] },
        },
      });
      const transport = new HttpTransport({ host: '192.168.1.100', deps });

      await expect(transport.connect()).rejects.toBeInstanceOf(InvalidResponseError);
    });
  });

  describe('disconnect', () => {
    it('clears token and closes WebSocket', async () => {
      const deps = createMockDeps({});
      const transport = new HttpTransport({ host: '192.168.1.100', deps });
      await transport.connect();

      await transport.disconnect();

      expect(transport.connected).toBe(false);
      expect(transport.token).toBeNull();
      expect(transport.device).toBeNull();
    });
  });

  describe('readInputRegisters', () => {
    it('reads registers via HTTP GET', async () => {
      const deps = createMockDeps({
        httpResponses: vi.fn(() => ({
          result_code: 1,
          result_msg: 'ok',
          result_data: { param_value: '0E 12 00 2A' },
        })),
      });
      const transport = new HttpTransport({ host: '192.168.1.100', deps });
      await transport.connect();

      const result = await transport.readInputRegisters(5000, 2);

      expect(result.get(5000)).toBe(0x0E12);
      expect(result.get(5001)).toBe(42);
    });

    it('includes correct query parameters', async () => {
      const deps = createMockDeps({});
      const transport = new HttpTransport({ host: '192.168.1.100', deps });
      await transport.connect();

      await transport.readInputRegisters(5000, 1);

      const url = (deps.httpGet as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('token=test-token-123');
      expect(url).toContain('type=0');
      expect(url).toContain('param_addr=5000');
      expect(url).toContain('param_num=1');
      expect(url).toContain('dev_id=1');
    });

    it('uses type=1 for holding registers', async () => {
      const deps = createMockDeps({});
      const transport = new HttpTransport({ host: '192.168.1.100', deps });
      await transport.connect();

      await transport.readHoldingRegisters(33500, 1);

      const url = (deps.httpGet as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('type=1');
      expect(url).toContain('param_addr=33500');
    });
  });

  describe('error handling', () => {
    it('throws TokenExpiredError on code 106', async () => {
      const deps = createMockDeps({
        httpResponses: vi.fn(() => ({
          result_code: 106,
          result_msg: 'token expired',
          result_data: null,
        })),
      });
      const transport = new HttpTransport({ host: '192.168.1.100', deps });
      await transport.connect();

      await expect(transport.readInputRegisters(5000, 1)).rejects.toBeInstanceOf(TokenExpiredError);
      expect(transport.connected).toBe(false);
    });

    it('retries on busy (code 301) then throws BusyError', async () => {
      const httpGet = vi.fn(async () => ({
        result_code: 301,
        result_msg: 'busy',
        result_data: null,
      }));
      const deps = createMockDeps({});
      deps.httpGet = httpGet;
      const transport = new HttpTransport({
        host: '192.168.1.100',
        deps,
        maxRetries: 2,
        busyDelayMs: 0,
      });
      await transport.connect();

      await expect(transport.readInputRegisters(5000, 1)).rejects.toBeInstanceOf(BusyError);
      expect(httpGet).toHaveBeenCalledTimes(2);
    });

    it('succeeds after busy retry', async () => {
      let calls = 0;
      const httpGet = vi.fn(async () => {
        calls++;
        if (calls === 1) return { result_code: 301, result_msg: 'busy', result_data: null };
        return { result_code: 1, result_msg: 'ok', result_data: { param_value: '00 0A' } };
      });
      const deps = createMockDeps({});
      deps.httpGet = httpGet;
      const transport = new HttpTransport({
        host: '192.168.1.100',
        deps,
        maxRetries: 3,
        busyDelayMs: 0,
      });
      await transport.connect();

      const result = await transport.readInputRegisters(5000, 1);
      expect(result.get(5000)).toBe(10);
      expect(httpGet).toHaveBeenCalledTimes(2);
    });

    it('throws InvalidResponseError on unexpected code', async () => {
      const deps = createMockDeps({
        httpResponses: vi.fn(() => ({
          result_code: 999,
          result_msg: 'unknown',
          result_data: null,
        })),
      });
      const transport = new HttpTransport({ host: '192.168.1.100', deps });
      await transport.connect();

      await expect(transport.readInputRegisters(5000, 1)).rejects.toBeInstanceOf(InvalidResponseError);
    });

    it('throws InvalidResponseError when param_value missing', async () => {
      const deps = createMockDeps({
        httpResponses: vi.fn(() => ({
          result_code: 1,
          result_msg: 'ok',
          result_data: {},
        })),
      });
      const transport = new HttpTransport({ host: '192.168.1.100', deps });
      await transport.connect();

      await expect(transport.readInputRegisters(5000, 1)).rejects.toBeInstanceOf(InvalidResponseError);
    });

    it('throws ConnectionError when HTTP request fails', async () => {
      const deps = createMockDeps({});
      deps.httpGet = vi.fn(async () => { throw new Error('network error'); });
      const transport = new HttpTransport({ host: '192.168.1.100', deps });
      await transport.connect();

      await expect(transport.readInputRegisters(5000, 1)).rejects.toBeInstanceOf(ConnectionError);
    });

    it('throws ConnectionError when not connected', async () => {
      const deps = createMockDeps({});
      const transport = new HttpTransport({ host: '192.168.1.100', deps });

      await expect(transport.readInputRegisters(5000, 1)).rejects.toBeInstanceOf(ConnectionError);
    });
  });
});
