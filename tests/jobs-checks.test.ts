import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProjectChecks } from '../src/checks.js';
import { defaultConfig } from '../src/config.js';
import { installGigacode } from '../src/install.js';
import { startJob, jobStatus, jobOutcome } from '../src/jobs.js';

async function workspace(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixso-job-checks-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

test('project checks preserve full logs, cwd, literal arguments and fail on a failing command', async t => {
  const root = await workspace(t), config = defaultConfig(root);
  const literal = 'literal & $(whoami) `calc` "quoted"';
  config.validation.commands = [
    { command: process.execPath, args: ['-e', 'process.stdout.write(process.cwd()+"\\n"+process.argv[1]+"\\n"+"x".repeat(100000));', literal] },
    { command: process.execPath, args: ['-e', 'process.stderr.write("build failed");process.exitCode=7;'] },
  ];
  const result = await runProjectChecks(config, path.join(root, 'checks'));
  assert.equal(result.status, 'failed'); assert.deepEqual(result.checks.map(check => check.status), ['passed', 'failed']);
  const log = await readFile(result.checks[0].stdoutPath, 'utf8');
  assert.ok(log.startsWith(`${root}\n${literal}\n`)); assert.ok(log.endsWith('x'.repeat(100000)));
  assert.equal(await readFile(result.checks[1].stderrPath, 'utf8'), 'build failed');
  assert.match(result.checks[1].error!, /code 7/);
});

test('unconfigured checks never report passed and a timeout fails', async t => {
  const root = await workspace(t), config = defaultConfig(root);
  assert.equal((await runProjectChecks(config, path.join(root, 'none'))).status, 'not-configured');
  config.gigacode.timeoutMs = 600;
  config.validation.commands = [{ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }];
  const result = await runProjectChecks(config, path.join(root, 'timeout'));
  assert.equal(result.status, 'failed'); assert.match(result.checks[0].error!, /timed out/);
});

test('project checks reject shell launchers and malformed specs without running them', async t => {
  const root = await workspace(t), config = defaultConfig(root);
  config.validation.commands = [
    { command: 'npm.cmd', args: ['run', 'build'] },
    { command: process.execPath, args: 'invalid' as unknown as string[] },
  ];
  const result = await runProjectChecks(config, path.join(root, 'invalid'));
  assert.equal(result.status, 'failed'); assert.equal(result.checks.length, 2);
  assert.match(result.checks[0].error!, /require a shell/); assert.match(result.checks[1].error!, /Invalid validation command/);
});

test('installer preserves malformed settings and conflicting server definitions', async t => {
  const root = await workspace(t), dir = path.join(root, '.gigacode'); await mkdir(dir);
  const settings = path.join(dir, 'settings.json');
  for (const content of ['[]', 'null', '{"mcpServers":[]}', '{"mcpServers":null}', '{"mcpServers":{"pixso-react":{"command":"custom"}}}']) {
    await writeFile(settings, content);
    await assert.rejects(installGigacode(root, path.join(root, 'pixso-react.config.json')));
    assert.equal(await readFile(settings, 'utf8'), content);
  }
});

test('installer merges a local MCP server and skill while preserving unrelated settings', async t => {
  const root = await workspace(t), dir = path.join(root, '.gigacode'); await mkdir(dir);
  const settings = path.join(dir, 'settings.json');
  await writeFile(settings, JSON.stringify({ custom: true, mcpServers: { existing: { command: 'keep-me' } } }));
  const result = await installGigacode(root, path.join(root, 'pixso-react.config.json'));
  const installed = JSON.parse(await readFile(settings, 'utf8'));
  assert.equal(installed.custom, true); assert.equal(installed.mcpServers.existing.command, 'keep-me');
  assert.equal(installed.mcpServers['pixso-react'].command, process.execPath);
  const skill = await readFile(path.join(result.skillDir, 'SKILL.md'), 'utf8');
  assert.match(skill, /pixso_start_job/); assert.match(skill, /\]\(reference\.md\)/);
  assert.match(await readFile(path.join(result.skillDir, 'reference.md'), 'utf8'), /GigaCode CLI/);
});

test('background job normalizes relative paths before switching to project cwd', async t => {
  const root = await workspace(t), project = path.join(root, 'different-cwd'); await mkdir(project);
  const config = defaultConfig(project); config.artifactsDir = path.join(root, 'artifacts');
  const configFile = path.join(root, 'config.json'); await writeFile(configFile, JSON.stringify(config));
  const snapshot = path.relative(process.cwd(), path.join(root, 'missing-snapshot'));
  const runDir = path.relative(process.cwd(), path.join(root, 'run'));
  const repairReport = path.relative(process.cwd(), path.join(root, 'repair.json'));
  const result = await startJob({ action: 'run', config: configFile, snapshot, runDir, repairReport });
  const request = JSON.parse(await readFile(path.join(result.directory, 'request.json'), 'utf8'));
  assert.equal(request.snapshot, path.resolve(snapshot)); assert.equal(request.runDir, path.resolve(runDir)); assert.equal(request.repairReport, path.resolve(repairReport));
  let status: { status: string } = { status: 'starting' };
  for (let i = 0; i < 120; i++) {
    status = await jobStatus(configFile, result.jobId);
    if (['failed', 'succeeded', 'interrupted'].includes(status.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(status.status, 'failed');
});

test('job state distinguishes a finished process from accepted implementation', () => {
  for (const status of ['failed', 'analysis-failed', 'generation-failed', 'generated-with-gaps', 'geometry-only', 'blocked-design-system', 'blocked-project-data']) assert.equal(jobOutcome({ status, complete: false }).status, 'failed');
  assert.equal(jobOutcome({status: 'passed', complete: false}, 'verify').status, 'failed');
  assert.deepEqual(jobOutcome({ status: 'awaiting-validation', complete: false }), { status: 'succeeded', resultStatus: 'awaiting-validation', complete: false });
  assert.equal(jobOutcome({ status: 'repair-limit', complete: false }, 'transfer').status, 'failed');
  assert.equal(jobOutcome({ status: 'accepted', complete: true }, 'transfer').status, 'succeeded');
});

test('background jobs reject silently ignored capture selection options and invalid node IDs', async () => {
  await assert.rejects(startJob({ action: 'run', config: 'unused.json', snapshot: 'unused', nodeIds: ['card'] }), /capture-only/);
  await assert.rejects(startJob({ action: 'capture', config: 'unused.json', nodeIds: [] }), /distinct nonempty/);
  await assert.rejects(startJob({ action: 'capture', config: 'unused.json', nodeIds: ['card', 'card'] }), /distinct nonempty/);
});
