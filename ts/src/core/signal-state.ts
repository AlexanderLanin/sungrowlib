export enum SupportState {
  NEVER_ATTEMPTED = 0,
  UNKNOWN_FROM_MULTI_SIGNAL_QUERY = 1,
  CONFIRMED_UNKNOWN = 2,
  YES = 3,
  NO = 4,
}

export type QueryType = 'single' | 'multi';

export class SignalStateTracker {
  private readonly states = new Map<string, SupportState>();

  update(signalName: string, value: number | null, queryType: QueryType, wasUnsupportedError = false): SupportState {
    const current = this.states.get(signalName) ?? SupportState.NEVER_ATTEMPTED;

    let next: SupportState;

    if (wasUnsupportedError) {
      next = SupportState.NO;
    } else if (value !== null && value !== 0) {
      next = SupportState.YES;
    } else if (value === 0) {
      next = queryType === 'single'
        ? SupportState.CONFIRMED_UNKNOWN
        : SupportState.UNKNOWN_FROM_MULTI_SIGNAL_QUERY;
    } else {
      next = current;
    }

    if (rankOf(next) >= rankOf(current)) {
      this.states.set(signalName, next);
    }

    return this.states.get(signalName)!;
  }

  getState(signalName: string): SupportState {
    return this.states.get(signalName) ?? SupportState.NEVER_ATTEMPTED;
  }

  getPendingVerifications(): string[] {
    const result: string[] = [];
    for (const [name, state] of this.states) {
      if (state === SupportState.UNKNOWN_FROM_MULTI_SIGNAL_QUERY) {
        result.push(name);
      }
    }
    return result;
  }

  isSupported(signalName: string): boolean | undefined {
    const state = this.states.get(signalName);
    if (state === SupportState.YES) return true;
    if (state === SupportState.NO || state === SupportState.CONFIRMED_UNKNOWN) return false;
    return undefined;
  }

  clear(): void {
    this.states.clear();
  }
}

function rankOf(state: SupportState): number {
  switch (state) {
    case SupportState.NEVER_ATTEMPTED: return 0;
    case SupportState.UNKNOWN_FROM_MULTI_SIGNAL_QUERY: return 1;
    case SupportState.CONFIRMED_UNKNOWN: return 2;
    case SupportState.YES: return 3;
    case SupportState.NO: return 3;
    default: return 0;
  }
}
