import { describe, it, expect } from 'vitest';
import { SignalStateTracker, SupportState } from './signal-state.js';

describe('SignalStateTracker', () => {
  it('starts at NEVER_ATTEMPTED', () => {
    const tracker = new SignalStateTracker();
    expect(tracker.getState('test')).toBe(SupportState.NEVER_ATTEMPTED);
    expect(tracker.isSupported('test')).toBeUndefined();
  });

  it('transitions to YES on non-zero value', () => {
    const tracker = new SignalStateTracker();
    tracker.update('test', 42, 'multi');
    expect(tracker.getState('test')).toBe(SupportState.YES);
    expect(tracker.isSupported('test')).toBe(true);
  });

  it('transitions to UNKNOWN_FROM_MULTI on zero in multi-query', () => {
    const tracker = new SignalStateTracker();
    tracker.update('test', 0, 'multi');
    expect(tracker.getState('test')).toBe(SupportState.UNKNOWN_FROM_MULTI_SIGNAL_QUERY);
    expect(tracker.isSupported('test')).toBeUndefined();
  });

  it('transitions to CONFIRMED_UNKNOWN on zero in single-query', () => {
    const tracker = new SignalStateTracker();
    tracker.update('test', 0, 'single');
    expect(tracker.getState('test')).toBe(SupportState.CONFIRMED_UNKNOWN);
    expect(tracker.isSupported('test')).toBe(false);
  });

  it('transitions to NO on unsupported error', () => {
    const tracker = new SignalStateTracker();
    tracker.update('test', null, 'multi', true);
    expect(tracker.getState('test')).toBe(SupportState.NO);
    expect(tracker.isSupported('test')).toBe(false);
  });

  it('resolves UNKNOWN_FROM_MULTI → CONFIRMED_UNKNOWN via single-query', () => {
    const tracker = new SignalStateTracker();
    tracker.update('test', 0, 'multi');
    expect(tracker.getState('test')).toBe(SupportState.UNKNOWN_FROM_MULTI_SIGNAL_QUERY);

    tracker.update('test', 0, 'single');
    expect(tracker.getState('test')).toBe(SupportState.CONFIRMED_UNKNOWN);
  });

  it('resolves UNKNOWN_FROM_MULTI → YES via non-zero value', () => {
    const tracker = new SignalStateTracker();
    tracker.update('test', 0, 'multi');
    tracker.update('test', 100, 'multi');
    expect(tracker.getState('test')).toBe(SupportState.YES);
  });

  it('never transitions from higher rank to lower', () => {
    const tracker = new SignalStateTracker();
    tracker.update('test', 42, 'multi');
    expect(tracker.getState('test')).toBe(SupportState.YES);

    tracker.update('test', 0, 'multi');
    expect(tracker.getState('test')).toBe(SupportState.YES);
  });

  it('never transitions from YES to CONFIRMED_UNKNOWN', () => {
    const tracker = new SignalStateTracker();
    tracker.update('test', 42, 'multi');
    tracker.update('test', 0, 'single');
    expect(tracker.getState('test')).toBe(SupportState.YES);
  });

  it('getPendingVerifications returns only UNKNOWN_FROM_MULTI signals', () => {
    const tracker = new SignalStateTracker();
    tracker.update('a', 0, 'multi');
    tracker.update('b', 42, 'multi');
    tracker.update('c', 0, 'single');
    tracker.update('d', 0, 'multi');

    const pending = tracker.getPendingVerifications();
    expect(pending).toEqual(expect.arrayContaining(['a', 'd']));
    expect(pending).not.toContain('b');
    expect(pending).not.toContain('c');
    expect(pending).toHaveLength(2);
  });

  it('clears all state', () => {
    const tracker = new SignalStateTracker();
    tracker.update('a', 42, 'multi');
    tracker.clear();
    expect(tracker.getState('a')).toBe(SupportState.NEVER_ATTEMPTED);
    expect(tracker.getPendingVerifications()).toHaveLength(0);
  });
});
