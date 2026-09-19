import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, type RawData } from 'ws';
import { expect, it } from 'vitest';
import { startServer } from '../server/app';
import { SCENE_COUNT, ServerMessageSchema, VERSION, type ServerMessage } from '../shared/protocol';

function receive<T extends ServerMessage['type']>(socket: WebSocket, type: T): Promise<Extract<ServerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => onError(new Error(`Socket closed before ${type}`));
    const onMessage = (data: RawData) => {
      try {
        const message = ServerMessageSchema.parse(JSON.parse(data.toString()));
        if (message.type !== type) return;
        cleanup();
        resolve(message as Extract<ServerMessage, { type: T }>);
      } catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
    };
    const timer = setTimeout(() => onError(new Error(`Timed out waiting for ${type}`)), 3000);
    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

it('serves the production audience entry points and Vercel target while rejecting Preview HMD commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanokon-preview-route-'));
  const index = '<!doctype html><html><body><div id="app">Preview production entry</div></body></html>';
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let socket: WebSocket | undefined;
  try {
    await writeFile(join(directory, 'index.html'), index);
    server = await startServer({
      port: 0, nativePort: 0, production: true, distDirectory: directory,
      controlToken: 'preview-route-test-control-12345678',
      nativeToken: 'preview-route-test-native-12345678',
    });

    const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8')) as {
      rewrites: { source: string; destination: string }[];
    };
    const mappings = vercel.rewrites.filter(rewrite => rewrite.source === '/preview');
    expect(mappings).toEqual([{ source: '/preview', destination: '/index.html' }]);

    // Only index.html exists: these responses must come from production routing, not Vite.
    for (const path of ['/preview', '/?view=preview', mappings[0].destination]) {
      const response = await fetch(`${server.url}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toContain('text/html');
      expect(response.headers.get('cache-control'), path).toBe('no-cache');
      expect(await response.text(), path).toBe(index);
    }
    const head = await fetch(`${server.url}/preview`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(index)));
    expect(await head.text()).toBe('');

    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin: server.url });
    await once(socket, 'open');
    const snapshotReceived = receive(socket, 'snapshot');
    socket.send(JSON.stringify({ version: VERSION, type: 'hello', role: 'hmd', name: 'Preview route test' }));
    const snapshot = await snapshotReceived;
    expect(snapshot.clientId).not.toBe('');
    expect(snapshot.state.epoch).toBe(server.authority.epoch);

    const rejectionReceived = receive(socket, 'error');
    socket.send(JSON.stringify({
      version: VERSION, type: 'command', requestId: 'preview-forbidden-scene',
      command: { type: 'scene', scene: (snapshot.state.scene + 1) % SCENE_COUNT },
    }));
    const rejection = await rejectionReceived;
    expect(rejection.requestId).toBe('preview-forbidden-scene');
    expect(rejection.message).toContain('read-only');
    expect(server.authority.state.revision).toBe(snapshot.state.revision);
    expect(server.authority.state.scene).toBe(snapshot.state.scene);
    expect(server.authority.pending).toHaveLength(0);

    // Rejected control attempts must not interrupt the audience's live subscription.
    const frame = await receive(socket, 'frame');
    expect(frame.state.scene).toBe(snapshot.state.scene);
    expect(frame.state.revision).toBe(snapshot.state.revision);
  } finally {
    socket?.terminate();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
