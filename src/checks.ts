import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runLoggedProcess } from './agents/index.js';
import { writeJson } from './fs.js';
import type { BridgeConfig } from './types.js';

export interface ProjectCheck {
  command: string;
  args: string[];
  status: 'passed' | 'failed';
  stdoutPath: string;
  stderrPath: string;
  durationMs: number;
  error?: string;
}
export interface ProjectChecksReport {
  status: 'passed' | 'failed' | 'not-configured';
  checks: ProjectCheck[];
  reportPath: string;
}

/** Run project checks sequentially: build and typecheck may share generated caches. */
export async function runProjectChecks(config: BridgeConfig, outputDir: string): Promise<ProjectChecksReport> {
  const directory = path.resolve(outputDir);
  await mkdir(directory, { recursive: true });
  const report: ProjectChecksReport = { status: 'not-configured', checks: [], reportPath: path.join(directory, 'project-checks.json') };
  if (!Array.isArray(config.validation.commands)) throw new Error('validation.commands must be an array');
  for (const [index, spec] of config.validation.commands.entries()) {
    const checkDir = path.join(directory, `check-${String(index + 1).padStart(3, '0')}`);
    await mkdir(checkDir, { recursive: true });
    const started = Date.now();
    const check: ProjectCheck = {
      command: spec?.command, args: spec?.args, status: 'failed',
      stdoutPath: path.join(checkDir, 'stdout.log'), stderrPath: path.join(checkDir, 'stderr.log'), durationMs: 0,
    };
    try {
      if (!spec || typeof spec.command !== 'string' || !spec.command || !Array.isArray(spec.args) || spec.args.some(arg => typeof arg !== 'string')) throw new Error(`Invalid validation command ${index + 1}`);
      if (spec.env && (typeof spec.env !== 'object' || Array.isArray(spec.env) || Object.values(spec.env).some(value => typeof value !== 'string'))) throw new Error(`Invalid environment for validation command ${index + 1}`);
      await runLoggedProcess(spec.command, spec.args, config.projectRoot, config.gigacode.timeoutMs, check.stdoutPath, check.stderrPath, spec.env);
      check.status = 'passed';
    } catch (error) { check.error = error instanceof Error ? error.message : String(error); }
    check.durationMs = Date.now() - started;
    report.checks.push(check);
    report.status = report.checks.some(item => item.status === 'failed') ? 'failed' : 'passed';
    await writeJson(report.reportPath, report);
  }
  await writeJson(report.reportPath, report);
  return report;
}
