import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import electron from 'electron';
import { startServer } from './server';
const desktop = await startServer();
const profile = await mkdtemp(join(tmpdir(), 'alyte-import-window-'));
const environment: NodeJS.ProcessEnv = { ...process.env, ALYTE_DESKTOP_PROFILE: profile };
delete environment.ELECTRON_RUN_AS_NODE;
const window = spawn(
  electron as unknown as string,
  [fileURLToPath(new URL('./main.cjs', import.meta.url))],
  { env: environment, stdio: 'ignore' },
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const exited =
    window.pid && window.exitCode === null && window.signalCode === null
      ? new Promise<void>((resolve) => window.once('close', () => resolve()))
      : Promise.resolve();
  window.kill();
  await exited;
  await desktop.close();
  await rm(profile, { recursive: true, force: true });
}
window.once('close', () => {
  void close();
});
window.once('error', () => {
  console.error('Could not launch the desktop window.');
  void close();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void close();
  });
