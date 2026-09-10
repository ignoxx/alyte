import { lstatSync } from 'node:fs';
import { assertPrivatePath, readExpectedResults, verifyReportAndGroundTruth } from './contract';

function argument(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || value === undefined || value.startsWith('--'))
    throw new Error('evaluation-preflight-arguments-invalid');
  return value;
}

function existingPrivateFile(path: string, privateRoot: string): void {
  const absolute = assertPrivatePath(path, privateRoot);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    throw new Error('evaluation-preflight-input-missing');
  }
  if (!stat.isFile()) throw new Error('evaluation-preflight-input-not-file');
}

function newPrivatePath(path: string, privateRoot: string): void {
  const absolute = assertPrivatePath(path, privateRoot);
  try {
    lstatSync(absolute);
    throw new Error('evaluation-preflight-output-exists');
  } catch (error) {
    if (error instanceof Error && error.message === 'evaluation-preflight-output-exists')
      throw error;
  }
}

export type PreflightPaths = {
  readonly privateRoot: string;
  readonly report: string;
  readonly reportId: string;
  readonly expected: string;
  readonly vision: string;
  readonly binding: string;
  readonly output: string;
  readonly rawOutput: string;
  readonly groundedOutput: string;
  readonly excludedOutput: string;
  readonly modelProposalsOutput: string;
  readonly metadataOutput: string;
  readonly scoreOutput: string;
  readonly aggregateOutput: string;
  readonly runnerLog: string;
  readonly groundingLog: string;
  readonly scoreLog: string;
};

function verifyGroundTruth(paths: PreflightPaths): void {
  let expected;
  try {
    expected = readExpectedResults(paths.expected);
  } catch {
    throw new Error('evaluation-preflight-ground-truth-invalid');
  }
  try {
    verifyReportAndGroundTruth(paths.report, expected, paths.reportId);
  } catch (error) {
    if (error instanceof Error && error.message === 'ground truth is not source-checked') {
      throw new Error('evaluation-preflight-ground-truth-not-source-checked');
    }
    if (error instanceof Error && error.message === 'evaluation report identity mismatch') {
      throw new Error('evaluation-preflight-report-id-mismatch');
    }
    if (error instanceof Error && error.message === 'report hash does not match ground truth') {
      throw new Error('evaluation-preflight-report-hash-mismatch');
    }
    throw new Error('evaluation-preflight-ground-truth-invalid');
  }
}

export function validatePreflightPaths(paths: PreflightPaths): void {
  const { privateRoot } = paths;
  assertPrivatePath(privateRoot, privateRoot);
  existingPrivateFile(paths.report, privateRoot);
  existingPrivateFile(paths.expected, privateRoot);
  existingPrivateFile(paths.vision, privateRoot);
  existingPrivateFile(paths.binding, privateRoot);
  verifyGroundTruth(paths);
  for (const path of [
    paths.output,
    paths.rawOutput,
    paths.groundedOutput,
    paths.excludedOutput,
    paths.modelProposalsOutput,
    paths.metadataOutput,
    paths.scoreOutput,
    paths.aggregateOutput,
    paths.runnerLog,
    paths.groundingLog,
    paths.scoreLog,
  ]) {
    newPrivatePath(path, privateRoot);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const paths: PreflightPaths = {
    privateRoot: argument(args, '--private-root'),
    report: argument(args, '--report'),
    reportId: argument(args, '--report-id'),
    expected: argument(args, '--expected'),
    vision: argument(args, '--vision'),
    binding: argument(args, '--binding'),
    output: argument(args, '--output'),
    rawOutput: argument(args, '--raw-output'),
    groundedOutput: argument(args, '--grounded-output'),
    excludedOutput: argument(args, '--excluded-output'),
    modelProposalsOutput: argument(args, '--model-proposals-output'),
    metadataOutput: argument(args, '--metadata-output'),
    scoreOutput: argument(args, '--score-output'),
    aggregateOutput: argument(args, '--aggregate-output'),
    runnerLog: argument(args, '--runner-log'),
    groundingLog: argument(args, '--grounding-log'),
    scoreLog: argument(args, '--score-log'),
  };
  validatePreflightPaths(paths);
  process.stdout.write('evaluation-preflight-ok\n');
}

if (process.argv[1]?.endsWith('/evaluation-preflight.ts') === true) {
  try {
    main();
  } catch {
    process.stderr.write('evaluation-preflight-failed\n');
    process.exitCode = 1;
  }
}
