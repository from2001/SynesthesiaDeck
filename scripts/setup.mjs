import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) {
  console.log('Existing .env preserved. See .env.example for available settings.');
} else {
  const secret = () => randomBytes(24).toString('hex');
  writeFileSync('.env', `HOST=127.0.0.1\nPORT=8787\nNATIVE_PORT=8788\nCONTROL_TOKEN=${secret()}\nNATIVE_TOKEN=${secret()}\nSHOW_SYNTHETIC=0\n`, { mode: 0o600, flag: 'wx' });
  console.log('Created private .env credentials. Copy CONTROL_TOKEN into the VJ desk to unlock controls.');
  console.log('Use npm run dev -- --synthetic for a labeled synthetic-audio demonstration.');
}
