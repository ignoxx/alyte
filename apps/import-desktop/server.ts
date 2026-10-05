import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { modelsAvailable } from './paddle';
const directory = fileURLToPath(new URL('.', import.meta.url));
const repository = resolve(directory, '../..');
export function authorized(request: IncomingMessage, host: string, token: string) {
  return (
    request.headers.host === host &&
    (!request.headers.origin || request.headers.origin === `http://${host}`) &&
    request.headers['x-local-token'] === token
  );
}
export async function startServer(port = 4317) {
  const token = randomBytes(32).toString('hex');
  const host = `127.0.0.1:${port}`;
  let root: string | null = null;
  let child: ChildProcess | null = null;
  let status: Record<string, unknown> = { state: 'empty' };
  let busy = false;
  const clear = async () => {
    const running = child;
    child = null;
    if (running?.pid && running.exitCode === null) {
      const closed = new Promise<void>((resolve) => running.once('close', () => resolve()));
      try {
        process.kill(-running.pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
      await closed;
    }
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
    status = { state: 'empty' };
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self' blob: chrome-extension:; object-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
    );
    const send = (code: number, value: unknown) => {
      response.writeHead(code, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    try {
      if (request.headers.host !== host) return send(403, { error: 'Access denied' });
      const path = new URL(request.url ?? '/', `http://${host}`).pathname;
      if (request.method === 'GET' && ['/', '/app.js', '/style.css'].includes(path)) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        response.setHeader(
          'Content-Type',
          file.endsWith('html')
            ? 'text/html; charset=utf-8'
            : file.endsWith('js')
              ? 'text/javascript'
              : 'text/css',
        );
        const content = await readFile(join(directory, 'public', file), 'utf8');
        response.end(content.replace('LOCAL_SESSION_TOKEN', token));
        return;
      }
      if (!authorized(request, host, token)) return send(403, { error: 'Access denied' });
      if (request.method === 'GET' && path === '/api/status')
        return send(200, { ...status, modelAvailable: modelsAvailable() });
      if (request.method === 'GET' && path === '/api/source' && root) {
        response.setHeader('Content-Type', 'application/pdf');
        response.end(await readFile(join(root, 'source.pdf')));
        return;
      }
      if (request.method === 'DELETE' && path === '/api/import') {
        if (busy) return send(409, { error: 'Please wait for the file transfer to finish.' });
        busy = true;
        try {
          await clear();
        } finally {
          busy = false;
        }
        return send(200, { state: 'empty' });
      }
      if (request.method === 'POST' && path === '/api/import') {
        if (busy || child) return send(409, { error: 'An import is already running.' });
        busy = true;
        try {
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of request) {
            bytes += chunk.length;
            if (bytes > 25 * 1024 * 1024)
              return send(413, { error: 'Choose a PDF smaller than 25 MB.' });
            chunks.push(chunk);
          }
          const pdf = Buffer.concat(chunks);
          if (!pdf.subarray(0, 1024).includes(Buffer.from('%PDF-')))
            return send(400, { error: 'Choose a PDF document.' });
          await clear();
          const sessions = join(homedir(), 'Library', 'Caches', 'AlyteImportLab', 'sessions');
          await mkdir(sessions, { recursive: true, mode: 0o700 });
          root = await realpath(await mkdtemp(join(sessions, 'session-')));
          await writeFile(join(root, 'source.pdf'), pdf, { mode: 0o600 });
          const mode = modelsAvailable() ? 'hybrid' : 'deterministic';
          status = { state: 'running', mode, startedAt: Date.now() };
          const jobRoot = root;
          const processHandle = spawn(
            process.execPath,
            ['--import', 'tsx', join(directory, 'worker.ts'), jobRoot, mode],
            { cwd: repository, stdio: 'ignore', detached: true },
          );
          child = processHandle;
          const timeout = setTimeout(() => {
            if (child === processHandle && processHandle.pid) {
              try {
                process.kill(-processHandle.pid, 'SIGKILL');
              } catch {}
            }
          }, 300000);
          processHandle.once('error', () => {
            if (child === processHandle) {
              child = null;
              status = { state: 'failed', error: 'Could not start the local extractor.' };
            }
          });
          processHandle.once('close', async (code) => {
            clearTimeout(timeout);
            if (child !== processHandle) return;
            child = null;
            try {
              if (code !== 0) throw new Error();
              const result = JSON.parse(await readFile(join(jobRoot, 'result.json'), 'utf8'));
              if (root !== jobRoot) return;
              status = {
                state: result.diagnostics.counts.extractionFailed ? 'failed' : 'complete',
                mode,
                result,
                error: result.diagnostics.counts.extractionFailed
                  ? 'Extraction could not finish. You can inspect any recovered rows or retry.'
                  : null,
              };
            } catch {
              if (root === jobRoot)
                status = {
                  state: 'failed',
                  error:
                    'Could not read this PDF. Encrypted PDFs are not supported in this tester yet. Try an unlocked PDF.',
                };
            }
          });
          return send(202, status);
        } finally {
          busy = false;
        }
      }
      send(404, { error: 'Not found' });
    } catch {
      if (!response.headersSent)
        send(500, { error: 'The local operation failed. Clear and retry.' });
      else response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    server,
    token,
    clear,
    close: async () => {
      await clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startServer();
  process.stdout.write('Local import tester: http://127.0.0.1:4317\n');
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void app.close().then(() => process.exit());
    });
}
