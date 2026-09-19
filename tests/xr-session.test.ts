import { afterEach, describe, expect, it, vi } from 'vitest';
import { endActiveMRSession, MR_EXIT_TIMEOUT_MS } from '../web/visuals/xr-session';

afterEach(() => { vi.useRealTimers(); });

describe('MR exit session ownership', () => {
  it('ends the presenting manager session even when the cached handle is missing', async () => {
    const active = { end: vi.fn().mockResolvedValue(undefined) };
    const manager = { isPresenting: true, getSession: () => active };
    const report = vi.fn();
    await endActiveMRSession(manager, null, report);
    expect(active.end).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith('Exiting MR...');
    expect(manager.isPresenting).toBe(true);
  });

  it('prefers the active manager session over a stale cached session', async () => {
    const active = { end: vi.fn().mockResolvedValue(undefined) };
    const stale = { end: vi.fn().mockRejectedValue(new Error('Old session already ended')) };
    await endActiveMRSession({ isPresenting: true, getSession: () => active }, stale, vi.fn());
    expect(active.end).toHaveBeenCalledOnce();
    expect(stale.end).not.toHaveBeenCalled();
  });

  it('can close a requested session before the manager has adopted it', async () => {
    const requested = { end: vi.fn().mockResolvedValue(undefined) };
    await endActiveMRSession({ isPresenting: false, getSession: () => null }, requested, vi.fn());
    expect(requested.end).toHaveBeenCalledOnce();
  });

  it('rejects an inconsistent presenting state instead of silently doing nothing', async () => {
    await expect(endActiveMRSession({ isPresenting: true, getSession: () => null }, null, vi.fn()))
      .rejects.toThrow('no active XR session handle');
  });

  it('leaves an already inactive renderer alone', async () => {
    const report = vi.fn();
    await endActiveMRSession({ isPresenting: false, getSession: () => null }, null, report);
    expect(report).not.toHaveBeenCalled();
  });

  it('propagates browser rejection without claiming the session ended', async () => {
    vi.useFakeTimers();
    const rejection = new Error('Browser refused to end the active session');
    const active = { end: vi.fn().mockRejectedValue(rejection) };
    const manager = { isPresenting: true, getSession: () => active };
    const report = vi.fn();
    await expect(endActiveMRSession(manager, null, report)).rejects.toBe(rejection);
    expect(manager.isPresenting).toBe(true);
    expect(report.mock.calls).toEqual([['Exiting MR...']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a hung browser end request after five seconds without forcing XR teardown', async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const active = { end: vi.fn(() => new Promise<void>(resolve => { complete = resolve; })) };
    const manager = { isPresenting: true, getSession: () => active };
    const report = vi.fn();
    const pending = endActiveMRSession(manager, null, report);
    const rejected = expect(pending).rejects.toThrow('still pending in the browser after 5 seconds');
    await vi.advanceTimersByTimeAsync(MR_EXIT_TIMEOUT_MS);
    await rejected;
    expect(active.end).toHaveBeenCalledOnce();
    expect(manager.isPresenting).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    complete();
    await Promise.resolve();
    expect(report.mock.calls).toEqual([['Exiting MR...']]);
  });
});
