import { describe, expect, it } from 'vitest';
import { isLoopbackHostname, resolveServerUrl } from '../web/server-url';

const LOCAL_PAGE = 'http://127.0.0.1:8787';
const SECURE_PAGE = 'https://desk.example';

describe('explicit show-server URL validation', () => {
  it('uses the same-origin endpoint when configuration is absent or blank', () => {
    expect(resolveServerUrl(undefined, LOCAL_PAGE)).toBe('ws://127.0.0.1:8787/ws');
    expect(resolveServerUrl('', SECURE_PAGE)).toBe('wss://desk.example/ws');
    expect(resolveServerUrl('  ', SECURE_PAGE)).toBe('wss://desk.example/ws');
  });
  it('normalizes secure HTTP origins and explicit WSS endpoints', () => {
    for (const [input, output] of [
      ['https://mac.example', 'wss://mac.example/ws'],
      ['https://mac.example/', 'wss://mac.example/ws'],
      [' HTTPS://MAC.EXAMPLE:443/ ', 'wss://mac.example/ws'],
      ['https://mac.example:8787', 'wss://mac.example:8787/ws'],
      ['wss://mac.example/ws', 'wss://mac.example/ws'],
      ['wss://mac.example:443/ws', 'wss://mac.example/ws'],
      ['https://192.168.10.20:8787', 'wss://192.168.10.20:8787/ws'],
      ['https://[::1]:8787', 'wss://[::1]:8787/ws'],
    ]) expect(resolveServerUrl(input, SECURE_PAGE)).toBe(output);
  });
  it('permits insecure loopback only on an HTTP page', () => {
    expect(resolveServerUrl('http://localhost:8787', LOCAL_PAGE)).toBe('ws://localhost:8787/ws');
    expect(resolveServerUrl('ws://127.0.0.1:8787/ws', LOCAL_PAGE)).toBe('ws://127.0.0.1:8787/ws');
    expect(resolveServerUrl('http://[::1]:8787', LOCAL_PAGE)).toBe('ws://[::1]:8787/ws');
    for (const endpoint of ['http://localhost:8787', 'ws://127.0.0.1:8787/ws', 'ws://[::1]/ws', 'http://mac.example']) {
      expect(() => resolveServerUrl(endpoint, SECURE_PAGE)).toThrow(/HTTPS page requires/);
    }
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) expect(isLoopbackHostname(hostname)).toBe(true);
    for (const hostname of ['localhost.evil.example', '127.0.0.1.evil.example', '192.168.1.2', '0.0.0.0', 'mac.local']) expect(isLoopbackHostname(hostname)).toBe(false);
  });
  it('rejects every remote insecure endpoint including LAN addresses', () => {
    for (const endpoint of ['http://mac.example', 'ws://mac.example/ws', 'http://192.168.10.20:8787', 'ws://0.0.0.0:8787/ws', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example']) {
      expect(() => resolveServerUrl(endpoint, LOCAL_PAGE)).toThrow(/Remote show servers require/);
    }
    expect(() => resolveServerUrl(undefined, 'http://192.168.1.20')).toThrow(/Remote show servers require/);
  });
  it('rejects credentials, query and fragment delimiters before normalization', () => {
    for (const endpoint of ['https://user@mac.example', 'https://user:secret@mac.example', 'https://@mac.example', 'wss://mac.example/ws?token=secret', 'https://mac.example?', 'wss://mac.example/ws#', 'https://mac.example/#server']) {
      expect(() => resolveServerUrl(endpoint, LOCAL_PAGE)).toThrow(/credentials|query string or fragment/);
    }
  });
  it('rejects paths and ambiguous URL forms instead of silently rewriting them', () => {
    for (const endpoint of ['https://mac.example/dashboard', 'https://mac.example/ws', 'wss://mac.example', 'wss://mac.example/', 'wss://mac.example/ws/', 'wss://mac.example/WS', 'wss://mac.example/a/../ws', 'wss://mac.example/%77s', 'https://mac.example/a/..', '//mac.example/ws', '/ws', 'mac.example', 'ftp://mac.example', 'https:\\mac.example', 'https://mac.exa\nmple', 'https://mac.example:99999']) {
      expect(() => resolveServerUrl(endpoint, LOCAL_PAGE)).toThrow();
    }
  });
  it('requires an explicit HTTP(S) page origin and never reads ambient globals', () => {
    for (const origin of ['file:///tmp/index.html', 'null', 'wss://desk.example/ws', 'https://desk.example/path', 'https://user@desk.example', 'https://desk.example?']) {
      expect(() => resolveServerUrl('https://mac.example', origin)).toThrow();
    }
    expect(resolveServerUrl('https://mac.example', 'https://desk.example:443/')).toBe('wss://mac.example/ws');
  });
});
