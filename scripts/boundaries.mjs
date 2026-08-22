import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoots = [
  'packages/domain',
  'packages/contracts',
  'packages/catalogue',
  'packages/fixtures',
];
const forbiddenForPurePackages = new Set(['react', 'react-native', 'expo', 'fastify', 'node:']);

function packageJson(relativeRoot) {
  return JSON.parse(fs.readFileSync(path.join(root, relativeRoot, 'package.json'), 'utf8'));
}

function sourceFiles(relativeRoot) {
  const sourceRoot = path.join(root, relativeRoot, 'src');
  return fs
    .readdirSync(sourceRoot, { recursive: true })
    .filter(
      (file) =>
        typeof file === 'string' &&
        /\.(ts|tsx|mts|cts)$/.test(file) &&
        !file.endsWith('.test.ts') &&
        !file.endsWith('contract-check.ts'),
    )
    .map((file) => path.join(sourceRoot, file));
}

export function checkBoundaries() {
  const failures = [];
  for (const relativeRoot of packageRoots) {
    const manifest = packageJson(relativeRoot);
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    for (const dependency of dependencies) {
      if (forbiddenForPurePackages.has(dependency) || dependency.startsWith('node:')) {
        failures.push(`${relativeRoot} declares forbidden dependency ${dependency}`);
      }
      if (dependency.startsWith('@alyte/')) {
        failures.push(`${relativeRoot} must not depend on another Alyte package (${dependency})`);
      }
    }

    for (const file of sourceFiles(relativeRoot)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const forbidden of forbiddenForPurePackages) {
        const importPattern = new RegExp(
          `(?:from|import\\s*\\()\\s*['"]${forbidden.replace(':', '\\:')}`,
        );
        if (importPattern.test(source)) {
          failures.push(`${path.relative(root, file)} imports forbidden dependency ${forbidden}`);
        }
      }
      if (/from\s*['"]@alyte\//.test(source)) {
        failures.push(`${path.relative(root, file)} imports another Alyte package`);
      }
    }
  }
  return failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const failures = checkBoundaries();
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    process.stdout.write('Package boundaries are valid.\n');
  }
}
