export interface ConnectionStats {
  connections: number;
  readCallsSuccess: number;
  readCallsFailed: number;
  retrievedSignalsSuccess: number;
  retrievedSignalsFailed: number;
  reconnects: number;
  lastReadTimestamp: string | null;
}

export function createStats(): ConnectionStats {
  return {
    connections: 0,
    readCallsSuccess: 0,
    readCallsFailed: 0,
    retrievedSignalsSuccess: 0,
    retrievedSignalsFailed: 0,
    reconnects: 0,
    lastReadTimestamp: null,
  };
}
