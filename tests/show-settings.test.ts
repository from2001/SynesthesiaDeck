import { describe, expect, it } from 'vitest';
import { controlTokenKey, initialShowSelection, persistControlToken, prepareShowSelection, restoreControlToken,
  showPageLink, type SettingsStore } from '../web/show-settings';

const LOCAL = 'http://127.0.0.1:8787', HOSTED = 'https://nanokon.example', MAC_A = 'wss://mac-a.example/ws', MAC_B = 'wss://mac-b.example/ws';
class MemoryStore implements SettingsStore {
  values = new Map<string, string>();
  writes: [string, string][] = [];
  failReads = false;
  failWrites = false;
  getItem(key: string) { if (this.failReads) throw new Error('Storage unavailable'); return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failWrites) throw new Error('Quota exceeded'); this.values.set(key, value); this.writes.push([key, value]); }
  removeItem(key: string) { if (this.failWrites) throw new Error('Storage unavailable'); this.values.delete(key); }
}
const options = { pageOrigin: HOSTED, hosted: true, audience: false, queryServer: null };

describe('show endpoint selection and credential scope', () => {
  it('keeps hosted startup idle without a configured endpoint and keeps the local default', () => {
    const store = new MemoryStore();
    expect(initialShowSelection(options, store).serverUrl).toBe('');
    expect(initialShowSelection({ ...options, hosted: false, pageOrigin: LOCAL }, store).serverUrl).toBe('ws://127.0.0.1:8787/ws');
    expect(initialShowSelection({ ...options, configuredServer: 'https://mac-a.example' }, store).serverUrl).toBe(MAC_A);
  });

  it('canonicalizes credential keys without mixing hosts, ports or transports', () => {
    expect(controlTokenKey(' HTTPS://MAC-A.EXAMPLE:443/ ')).toBe(controlTokenKey(MAC_A));
    expect(controlTokenKey('wss://mac-a.example:8787/ws')).not.toBe(controlTokenKey(MAC_A));
    expect(controlTokenKey(MAC_B)).not.toBe(controlTokenKey(MAC_A));
    expect(controlTokenKey('http://localhost:8787')).not.toBe(controlTokenKey('https://localhost:8787'));
  });

  it('restores only the newly selected endpoint credential and never migrates legacy credentials through a query', () => {
    const store = new MemoryStore();
    store.values.set('nanokon-server-url', MAC_A);
    store.values.set(controlTokenKey(MAC_A), 'token-a');
    store.values.set('nanokon-control-token', 'legacy-secret');
    const selected = initialShowSelection({ ...options, queryServer: 'https://mac-b.example' }, store);
    expect(selected).toEqual({ serverUrl: MAC_B, token: '', persisted: true });
    expect(store.getItem(controlTokenKey(MAC_B))).toBeNull();
    expect(store.getItem('nanokon-control-token')).toBe('legacy-secret');
    expect(store.getItem('nanokon-server-url')).toBe(MAC_B);
    store.values.set(controlTokenKey(MAC_B), 'token-b');
    expect(initialShowSelection(options, store).token).toBe('token-b');
  });

  it('migrates the local legacy token once and never overrides an explicit scoped logout', () => {
    const store = new MemoryStore(); store.values.set('nanokon-control-token', 'legacy-secret');
    const local = { ...options, pageOrigin: LOCAL, hosted: false };
    const selected = initialShowSelection(local, store);
    expect(selected.token).toBe('legacy-secret');
    expect(store.getItem('nanokon-control-token')).toBeNull();
    expect(store.getItem(controlTokenKey(selected.serverUrl))).toBe('legacy-secret');
    store.values.set(controlTokenKey(selected.serverUrl), '');
    store.values.set('nanokon-control-token', 'old-client-token');
    expect(initialShowSelection(local, store).token).toBe('');
  });

  it('does not migrate legacy credentials for hosted, audience, cross-origin or explicit same-origin query selections', () => {
    const base = { serverUrl: 'ws://127.0.0.1:8787/ws', pageOrigin: LOCAL, hosted: false, audience: false, hasServerQuery: false, scopedToken: null, legacyToken: 'legacy-secret' };
    for (const variation of [{ hosted: true }, { audience: true }, { hasServerQuery: true }, { serverUrl: MAC_B }]) {
      expect(restoreControlToken({ ...base, ...variation })).toEqual({ token: '', migrateLegacy: false });
    }
    expect(restoreControlToken({ ...base, audience: true, scopedToken: 'scoped-secret' }).token).toBe('');
  });

  it('respects an explicitly blank hosted query and does not fall back to remembered credentials', () => {
    const store = new MemoryStore(); store.values.set('nanokon-server-url', MAC_A); store.values.set(controlTokenKey(MAC_A), 'token-a');
    expect(initialShowSelection({ ...options, queryServer: '' }, store)).toEqual({ serverUrl: '', token: '', persisted: false });
  });

  it('rejects invalid endpoints before storage changes or credential selection', () => {
    const store = new MemoryStore(); store.values.set('nanokon-server-url', MAC_A); store.values.set(controlTokenKey(MAC_A), 'token-a');
    expect(() => prepareShowSelection('https://user:secret@mac-b.example', HOSTED, false, store)).toThrow();
    expect(store.getItem('nanokon-server-url')).toBe(MAC_A);
    expect(store.writes).toHaveLength(0);
  });

  it('returns a complete read-only candidate when storage reads or writes fail', () => {
    for (const failure of ['failReads', 'failWrites'] as const) {
      const store = new MemoryStore(); store.values.set('nanokon-server-url', MAC_A); store.values.set(controlTokenKey(MAC_A), 'token-a'); store.values.set(controlTokenKey(MAC_B), 'token-b'); store[failure] = true;
      expect(prepareShowSelection('https://mac-b.example', HOSTED, false, store)).toEqual({ serverUrl: MAC_B, token: '', persisted: false });
      expect(store.values.get(controlTokenKey(MAC_A))).toBe('token-a');
      expect(store.writes.some(([key, token]) => key === controlTokenKey(MAC_B) && token === 'token-a')).toBe(false);
    }
    const blocked = new MemoryStore(); blocked.failReads = true;
    expect(initialShowSelection({ ...options, hosted: false, pageOrigin: LOCAL }, blocked).serverUrl).toBe('ws://127.0.0.1:8787/ws');
  });

  it('allows an explicitly entered token without requiring browser storage', () => {
    const store = new MemoryStore(); store.failWrites = true;
    expect(persistControlToken(MAC_B, 'manually-entered-token', store)).toBe(false);
    expect(store.values.has(controlTokenKey(MAC_B))).toBe(false);
    expect(persistControlToken(MAC_B, 'manually-entered-token', null)).toBe(false);
  });
});

describe('shareable show links', () => {
  it('carries the selected server between hosted audience and desk views without credentials', () => {
    for (const audience of [false, true]) {
      const link = showPageLink(`${HOSTED}/hmd?token=old-secret&extra=1#token`, MAC_A, audience, true);
      expect(link.origin).toBe(HOSTED); expect(link.pathname).toBe('/');
      expect(link.searchParams.get('server')).toBe('https://mac-a.example');
      expect(link.searchParams.get('view')).toBe(audience ? 'hmd' : null);
      expect(link.href).not.toContain('secret'); expect(link.hash).toBe('');
      expect([...link.searchParams.keys()].every(key => key === 'server' || key === 'view')).toBe(true);
    }
  });

  it('keeps the original local link clean and preserves explicit cross-origin selections', () => {
    expect(showPageLink(LOCAL, 'ws://127.0.0.1:8787/ws', true, false).href).toBe(`${LOCAL}/?view=hmd`);
    expect(showPageLink(LOCAL, MAC_B, false, false).searchParams.get('server')).toBe('https://mac-b.example');
    expect(showPageLink(HOSTED, '', true, true).searchParams.get('server')).toBeNull();
  });
});
