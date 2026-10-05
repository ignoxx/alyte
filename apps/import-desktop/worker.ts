import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { run } from '../../scripts/import-evaluation/alyte-service-baseline';
const root = resolve(process.argv[2]!);
try {
  const result = await run({
    report: join(root, 'source.pdf'),
    reportId: 'desktop',
    output: join(root, 'result.json'),
    privateRoot: root,
    skipVision: false,
    forceVision: false,
    modelEnabled: process.argv[3] === 'hybrid',
    modelModule: fileURLToPath(new URL('./paddle.ts', import.meta.url)),
    experiment: null,
    currentTime: new Date().toISOString(),
  });
  writeFileSync(join(root, 'result.json'), JSON.stringify(result), { mode: 0o600 });
} catch {
  process.exitCode = 1;
}
