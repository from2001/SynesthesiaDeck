import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { startServer } from './app.js';
import { MidiProfileSchema } from './midi.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const env = process.env;
const port = (value: string | undefined, fallback: number) => {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error('Ports must be integers from 1 to 65535');
  return result;
};
try {
  if (!!env.TLS_CERT !== !!env.TLS_KEY) throw new Error('Set both TLS_CERT and TLS_KEY; insecure fallback is disabled');
  const server = await startServer({
    host: env.HOST ?? '127.0.0.1', port: port(env.PORT, 8787), nativePort: port(env.NATIVE_PORT, 8788),
    controlToken: env.CONTROL_TOKEN ?? '', nativeToken: env.NATIVE_TOKEN ?? '',
    publicOrigin: env.PUBLIC_ORIGIN, allowedOrigins: env.ALLOWED_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean),
    trustedProxy: env.TRUSTED_PROXY === '1',
    tls: env.TLS_CERT && env.TLS_KEY ? { cert: await readFile(env.TLS_CERT), key: await readFile(env.TLS_KEY) } : undefined,
    production: process.argv.includes('--production'), vite: !process.argv.includes('--production'),
    synthetic: process.argv.includes('--synthetic') || env.SHOW_SYNTHETIC === '1',
    midiProfile: env.MIDI_PROFILE ? MidiProfileSchema.parse(JSON.parse(await readFile(env.MIDI_PROFILE, 'utf8'))) : undefined,
  });
  console.info(`Show server: ${server.url}`);
  console.info(`Native bridge: http://127.0.0.1:${server.nativePort} (authenticated)`);
  console.info(`Source: ${server.authority.source.capture}; initial transport is stopped`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.close().then(() => process.exit(0)); });
} catch (reason) {
  console.error(`Show server could not start: ${reason instanceof Error ? reason.message : 'Unknown startup error'}`);
  process.exitCode = 1;
}
