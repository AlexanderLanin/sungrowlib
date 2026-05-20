export interface Transport {
  readonly connected: boolean;
  disconnect(): Promise<void>;
  setSlaveId(id: number): void;
  /** Read input registers (FC04). Addresses are 1-based (catalog). */
  readInputRegisters(start: number, count: number): Promise<Map<number, number>>;
  /** Read holding registers (FC03). Addresses are 1-based (catalog). */
  readHoldingRegisters(start: number, count: number): Promise<Map<number, number>>;
}
