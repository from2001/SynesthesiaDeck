import { resolveServerUrl } from './server-url';

export interface SettingsStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface ShowSelection { serverUrl: string; token: string; persisted: boolean }
export interface InitialShowOptions {
  pageOrigin: string;
  hosted: boolean;
  audience: boolean;
  queryServer: string | null;
  configuredServer?: string;
}
const SERVER_KEY = 'nanokon-server-url';
const LEGACY_TOKEN_KEY = 'nanokon-control-token';

export function publicShowOrigin(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  return url.origin;
}

/** Credentials use the canonical endpoint, so spelling and default ports do not create aliases. */
export function controlTokenKey(serverUrl: string): string {
  return `${LEGACY_TOKEN_KEY}:${resolveServerUrl(serverUrl, publicShowOrigin(serverUrl))}`;
}

/** Links contain only the selected public endpoint and audience mode, never credentials or old query fields. */
export function showPageLink(pageOrigin: string, serverUrl: string, audience: boolean, hosted: boolean): URL {
  const url = new URL('/', pageOrigin);
  if (audience) url.searchParams.set('view', 'hmd');
  if (serverUrl) {
    const serverOrigin = publicShowOrigin(resolveServerUrl(serverUrl, url.origin));
    if (hosted || serverOrigin !== url.origin) url.searchParams.set('server', serverOrigin);
  }
  return url;
}

/** An explicitly empty scoped credential represents a logged-out desk and defeats legacy fallback. */
export function restoreControlToken(input: {
  serverUrl: string; pageOrigin: string; hosted: boolean; audience: boolean; hasServerQuery: boolean;
  scopedToken: string | null; legacyToken: string | null;
}): { token: string; migrateLegacy: boolean } {
  if (!input.serverUrl || input.audience) return { token: '', migrateLegacy: false };
  if (input.scopedToken !== null) return { token: input.scopedToken, migrateLegacy: false };
  const mayMigrate = !input.hosted && !input.hasServerQuery && publicShowOrigin(input.serverUrl) === new URL(input.pageOrigin).origin;
  return mayMigrate && input.legacyToken ? { token: input.legacyToken, migrateLegacy: true } : { token: '', migrateLegacy: false };
}

/** Storage access is optional; a blocked store must never break the same-origin local preview. */
export function readSetting(store: SettingsStore | null, key: string): string | null {
  try { return store?.getItem(key) ?? null; } catch { return null; }
}

/** Prepare a complete selection before a caller replaces its current connection or credential. */
export function prepareShowSelection(requested: string, pageOrigin: string, audience: boolean, store: SettingsStore | null): ShowSelection {
  const serverUrl = resolveServerUrl(requested, pageOrigin);
  let token = '', persisted = false;
  try {
    if (store) {
      if (!audience) token = store.getItem(controlTokenKey(serverUrl)) ?? '';
      store.setItem(SERVER_KEY, serverUrl);
      persisted = true;
    }
  } catch {
    // A partially available store cannot lend a stale credential to a newly selected endpoint.
    token = '';
  }
  return { serverUrl, token, persisted };
}

export function initialShowSelection(options: InitialShowOptions, store: SettingsStore | null): ShowSelection {
  const requested = options.queryServer ?? readSetting(store, SERVER_KEY) ?? options.configuredServer;
  if (!requested && options.hosted) return { serverUrl: '', token: '', persisted: false };
  const serverUrl = resolveServerUrl(requested, options.pageOrigin);
  let token = '', persisted = false;
  try {
    if (store) {
      const restored = restoreControlToken({
        serverUrl, pageOrigin: options.pageOrigin, hosted: options.hosted, audience: options.audience,
        hasServerQuery: options.queryServer !== null,
        scopedToken: options.audience ? null : store.getItem(controlTokenKey(serverUrl)),
        legacyToken: options.audience ? null : store.getItem(LEGACY_TOKEN_KEY),
      });
      token = restored.token;
      if (options.queryServer !== null) store.setItem(SERVER_KEY, serverUrl);
      if (restored.migrateLegacy) {
        store.setItem(controlTokenKey(serverUrl), token);
        store.removeItem(LEGACY_TOKEN_KEY);
      }
      persisted = true;
    }
  } catch { token = ''; }
  return { serverUrl, token, persisted };
}

/** A manually entered credential may still be used for this connection when persistence is unavailable. */
export function persistControlToken(serverUrl: string, token: string, store: SettingsStore | null): boolean {
  try {
    if (!store) return false;
    store.setItem(controlTokenKey(serverUrl), token);
    return true;
  } catch { return false; }
}
