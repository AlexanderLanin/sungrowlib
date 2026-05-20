declare module 'modbus-serial' {
  class ModbusRTU {
    connectTCP(host: string, options: { port: number }): Promise<void>;
    setID(id: number): void;
    setTimeout(ms: number): void;
    readInputRegisters(addr: number, count: number): Promise<{ data: number[] }>;
    readHoldingRegisters(addr: number, count: number): Promise<{ data: number[] }>;
    close(cb: () => void): void;
    isOpen?: boolean;
  }
  export default ModbusRTU;
}
