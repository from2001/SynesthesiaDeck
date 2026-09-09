/** Parse explicit endpoint configuration without reading browser state or environment variables. */
function parseAbsolute(value: string, label: string): { url: URL; path: string } {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u0020\u007f\\]/.test(trimmed)) throw new Error(`${label} must be a complete URL without spaces or control characters.`);
  if (/[?#]/.test(trimmed)) throw new Error(`${label} must not contain a query string or fragment.`);
  const parts = /^(https?|wss?):\/\/([^/]+)(\/.*)?$/i.exec(trimmed);
  if (!parts) throw new Error(`${label} must use http://, https://, ws://, or wss://.`);
  if (parts[2].includes('@')) throw new Error(`${label} must not contain credentials.`);
  let url: URL;
  try { url = new URL(trimmed); }
  catch { throw new Error(`${label} is not a valid absolute URL.`); }
  if (url.username || url.password) throw new Error(`${label} must not contain credentials.`);
  return { url, path: parts[3] ?? '' };
}

/** Exact loopback hostnames accepted for the local HTTP development workflow. */
export function isLoopbackHostname(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname.toLowerCase());
}

/**
 * Return a canonical WebSocket endpoint. HTTP(S) inputs must be origins; WS(S)
 * inputs must use exactly /ws. Empty input selects the page's own origin.
 * The caller must separately authorize endpoint changes before reusing a token.
 */
export function resolveServerUrl(endpoint: string | undefined, pageOrigin: string): string {
  const page = parseAbsolute(pageOrigin, 'Page origin');
  if (!['http:', 'https:'].includes(page.url.protocol) || (page.path !== '' && page.path !== '/')) {
    throw new Error('Page origin must be an HTTP(S) origin without a path.');
  }
  const target = parseAbsolute(endpoint?.trim() || page.url.origin, 'Show server');
  const webSocketInput = target.url.protocol === 'ws:' || target.url.protocol === 'wss:';
  if (webSocketInput ? target.path !== '/ws' : target.path !== '' && target.path !== '/') {
    throw new Error('Enter an HTTP(S) server origin or a WebSocket URL ending exactly in /ws.');
  }
  const secure = target.url.protocol === 'https:' || target.url.protocol === 'wss:';
  if (!secure && page.url.protocol === 'https:') {
    throw new Error('An HTTPS page requires a secure WSS show server, including for loopback connections.');
  }
  if (!secure && !isLoopbackHostname(target.url.hostname)) {
    throw new Error('Remote show servers require HTTPS/WSS. HTTP/WS is available only for local loopback development.');
  }
  target.url.protocol = secure ? 'wss:' : 'ws:';
  target.url.pathname = '/ws';
  return target.url.href;
}
