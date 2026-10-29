import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, access, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runSwarm, detectPromptArgs, runLoggedProcess } from '../src/agents/swarm.js';
import type { BridgeConfig } from '../src/types.js';

async function setup(t: { after(fn: () => Promise<void>): void }, script: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixso-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, 'fixture.mjs');
  await writeFile(fixture, script);
  const config: BridgeConfig['gigacode'] = {
    command: process.execPath, args: [fixture, '{outputDir}', '{taskId}', '{promptFile}'], concurrency: 2, retries: 0, timeoutMs: 10_000,
  };
  return { root, config, options: { config, projectRoot: root, runDir: path.join(root, 'run') } };
}

const writer = `import {writeFile,readFile} from 'node:fs/promises'; import path from 'node:path';
const [out,id,prompt] = process.argv.slice(2);
const started = Date.now(); await new Promise(r=>setTimeout(r,180));
await writeFile(path.join(out,'result.json'),JSON.stringify({id,started,ended:Date.now(),prompt:await readFile(prompt,'utf8')}));
process.stdout.write('x'.repeat(150000)); process.stderr.write('diagnostic');`;

test('bounded swarm writes independent bundles and preserves complete logs', async t => {
  const { options } = await setup(t, writer);
  const tasks = ['one', 'two', 'three', 'four'].map(id => ({ id, prompt: `Render screen ${id}`, expectedFiles: ['result.json'] }));
  const result = await runSwarm(tasks, options);
  assert.equal(result.status, 'succeeded');
  const timings: { started: number; ended: number }[] = [];
  for (const task of result.tasks) {
    assert.equal((await readFile(task.stdoutPath)).length, 150000);
    assert.equal(await readFile(task.stderrPath, 'utf8'), 'diagnostic');
    const output = JSON.parse(await readFile(path.join(task.outputDir, 'result.json'), 'utf8'));
    assert.equal(output.id, task.id);
    assert.match(output.prompt, /ordinary CSS classes/);
    timings.push(output);
  }
  let maximum = 0;
  for (const event of timings) maximum = Math.max(maximum, timings.filter(other => other.started <= event.started && other.ended > event.started).length);
  assert.equal(maximum, 2);
});

test('resume checks fingerprints and output content; corrupt output is regenerated', async t => {
  const { options, root } = await setup(t, writer);
  const input = path.join(root, 'design.json'); await writeFile(input, '{"revision":1}');
  const tasks = [{ id: 'screen', prompt: 'Render', inputPaths: [input], expectedFiles: ['result.json'] }];
  const first = await runSwarm(tasks, options);
  const second = await runSwarm(tasks, { ...options, resume: true });
  assert.equal(second.tasks[0].status, 'skipped');
  assert.equal(second.tasks[0].attempts, 1);
  await writeFile(path.join(first.tasks[0].outputDir, 'result.json'), 'corrupt');
  const third = await runSwarm(tasks, { ...options, resume: true });
  assert.equal(third.tasks[0].status, 'succeeded'); assert.equal(third.tasks[0].attempts, 2);
  await writeFile(input, '{"revision":2}');
  const fourth = await runSwarm(tasks, { ...options, resume: true });
  assert.equal(fourth.tasks[0].attempts, 3);
});

test('retries use a fresh output directory and cannot accept stale partial files', async t => {
  const script = `import {writeFile} from 'node:fs/promises'; import path from 'node:path';
const [out] = process.argv.slice(2); if(out.includes('attempt-0001')) { await writeFile(path.join(out,'required.tsx'),'partial'); process.exitCode=1; }
else await writeFile(path.join(out,'unrelated.txt'),'not complete');`;
  const { options } = await setup(t, script);
  options.config.retries = 1;
  const result = await runSwarm([{ id: 'screen', prompt: 'Render', expectedFiles: ['required.tsx'] }], options);
  assert.equal(result.status, 'failed'); assert.equal(result.tasks[0].attempts, 2);
  assert.match(result.tasks[0].error!, /Required output was not produced/);
});

test('process timeout kills descendants and records failure', async t => {
  const script = `import {spawn} from 'node:child_process'; import {writeFile} from 'node:fs/promises'; import path from 'node:path';
const [out] = process.argv.slice(2);
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
await writeFile(path.join(out,'child.pid'),String(child.pid)); setInterval(()=>{},1000);`;
  const { options } = await setup(t, script); options.config.timeoutMs = 800;
  const result = await runSwarm([{ id: 'screen', prompt: 'Render' }], options);
  assert.equal(result.status, 'failed'); assert.match(result.tasks[0].error!, /timed out/);
  const childPid = Number(await readFile(path.join(result.tasks[0].outputDir, 'child.pid'), 'utf8'));
  assert.throws(() => process.kill(childPid, 0));
});

test('arguments remain literal without shell evaluation', async t => {
  const { options, root } = await setup(t, `import {writeFile} from 'node:fs/promises'; import path from 'node:path';
const [out,id,prompt,literal] = process.argv.slice(2); await writeFile(path.join(out,'args.json'),JSON.stringify({literal,prompt}));`);
  const literal = 'a space & echo $(whoami) `calc` ; "quoted"'; options.config.args.push(literal);
  const result = await runSwarm([{ id: 'screen', prompt: 'Render' }], options);
  assert.equal(JSON.parse(await readFile(path.join(result.tasks[0].outputDir, 'args.json'), 'utf8')).literal, literal);
  assert.ok(result.tasks[0].workspace.startsWith(root));
});

test('rejects unsafe task IDs, output traversal, duplicates, and unsupported help flags', async t => {
  const { options } = await setup(t, writer);
  for (const id of ['../escape', 'CON', 'bad.', 'bad/path']) await assert.rejects(runSwarm([{ id, prompt: '' }], options), /Unsafe task id/);
  await assert.rejects(runSwarm([{ id: 'ok', prompt: '', expectedFiles: ['../secret'] }], options), /Unsafe output path/);
  await assert.rejects(runSwarm([{ id: 'same', prompt: '' }, { id: 'SAME', prompt: '' }], options), /Duplicate/);
  assert.deepEqual(detectPromptArgs(' --prompt-file <path> Read prompt file'), ['--prompt-file', '{promptFile}']);
  assert.deepEqual(detectPromptArgs(' -p, --prompt <text> Non-interactive prompt'), ['--prompt', '{prompt}']);
  assert.throws(() => detectPromptArgs(' -p, --port <port> TCP port'), /does not advertise/);
});

test('empty successful process is not treated as completed implementation', async t => {
  const { options } = await setup(t, 'process.stdout.write("Done")');
  const result = await runSwarm([{ id: 'empty', prompt: 'Render' }], options);
  assert.equal(result.status, 'failed'); assert.match(result.tasks[0].error!, /no output files/);
});

test('inherited object property names cannot satisfy required output files', async t => {
  const { options } = await setup(t, `import {writeFile} from 'node:fs/promises'; import path from 'node:path';
await writeFile(path.join(process.argv[2],'unrelated.txt'),'done');`);
  const result = await runSwarm([{ id: 'required', prompt: 'Render', expectedFiles: ['toString'] }], options);
  assert.equal(result.status, 'failed'); assert.match(result.tasks[0].error!, /Required output/);
});

test('missing executable reports a concrete setup error without hanging', async t => {
  const { options, root } = await setup(t, writer);
  options.config.command = path.join(root, 'missing-gigacode.exe');
  const result = await runSwarm([{ id: 'missing', prompt: 'Render' }], options);
  assert.equal(result.status, 'failed'); assert.match(result.tasks[0].error!, /executable not found/i);
});

test('run lock rejects concurrent coordinators for the same artifact directory', async t => {
  const { options } = await setup(t, writer);
  await mkdir(options.runDir); await writeFile(path.join(options.runDir, '.swarm.lock'), String(process.pid));
  await assert.rejects(runSwarm([{ id: 'screen', prompt: 'Render' }], options), /Another swarm/);
  await access(path.join(options.runDir, '.swarm.lock'));
});

test('logged processes inherit real files, preserve large binary logs and release handles after failure', async t => {
  const { root } = await setup(t, '');
  const stdout = path.join(root, 'process.stdout.log'), stderr = path.join(root, 'process.stderr.log');
  const script = `const fs = require('node:fs');
if(!fs.fstatSync(1).isFile() || !fs.fstatSync(2).isFile()) process.exit(9);
fs.writeSync(1,Buffer.alloc(1024*1024,0x41)); fs.writeSync(2,Buffer.from([0,1,2,255])); process.exitCode=7;`;
  await assert.rejects(runLoggedProcess(process.execPath, ['-e', script], root, 10_000, stdout, stderr), /code 7/);
  assert.deepEqual(await readFile(stdout), Buffer.alloc(1024*1024, 0x41));
  assert.deepEqual(await readFile(stderr), Buffer.from([0, 1, 2, 255]));
  await rename(stdout, `${stdout}.previous`); await rename(stderr, `${stderr}.previous`);
  await runLoggedProcess(process.execPath, ['-e', 'process.stdout.write("next")'], root, 10_000, stdout, stderr);
  assert.equal(await readFile(stdout, 'utf8'), 'next'); assert.equal((await readFile(stderr)).length, 0);
});

test('deep artifact runs launch from a short independent workspace root', async t => {
  const { options, root } = await setup(t, writer);
  const runDir = path.join(root, ...Array.from({ length: 8 }, (_, index) => `deep-${index}-${'x'.repeat(36)}`));
  const workspaceRoot = path.join(root, 'w');
  assert.ok(runDir.length > 330);
  const result = await runSwarm([{ id: 'screen', prompt: 'Render', expectedFiles: ['result.json'] }], { ...options, runDir, workspaceRoot });
  assert.equal(result.status, 'succeeded');
  const task = result.tasks[0];
  assert.ok(task.workspace.startsWith(`${workspaceRoot}${path.sep}`));
  assert.ok(task.workspace.length < 240);
  const attempt = path.dirname(task.stdoutPath);
  const invocation = JSON.parse(await readFile(path.join(attempt, 'invocation.json'), 'utf8'));
  assert.equal(invocation.cwd, task.workspace);
  assert.equal(invocation.args[3], path.join(task.workspace, 'prompt.md'));
  assert.equal(await readFile(path.join(attempt, 'prompt.md'), 'utf8'), await readFile(path.join(task.workspace, 'prompt.md'), 'utf8'));
  assert.equal((await readFile(task.stdoutPath)).length, 150000);
  const resumed = await runSwarm([{ id: 'screen', prompt: 'Render', expectedFiles: ['result.json'] }], { ...options, runDir, workspaceRoot, resume: true });
  assert.equal(resumed.tasks[0].status, 'skipped'); assert.equal(resumed.tasks[0].workspace, task.workspace);
});

test('missing cwd is not misdiagnosed as a missing executable', async t => {
  const { root } = await setup(t, '');
  await assert.rejects(runLoggedProcess(process.execPath, ['-e', ''], path.join(root, 'missing-cwd'), 10000, path.join(root, 'out'), path.join(root, 'err')), /working directory does not exist/);
});

test('Windows excessive cwd reports a short-path remedy before spawning', { skip: process.platform !== 'win32' }, async t => {
  const { root } = await setup(t, '');
  const cwd = path.join(root, ...Array.from({ length: 7 }, () => 'long-existing-directory-name-123456789'));
  await mkdir(cwd, { recursive: true });
  await assert.rejects(runLoggedProcess(process.execPath, ['-e', ''], cwd, 10000, path.join(root, 'out'), path.join(root, 'err')), /working directory is too long.*Choose a shorter/);
});
