#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { initConfig, loadConfig } from './config.js';
import { importOperation, captureOperation, inspectPixso, verifyOperation } from './operations.js';
import { generateBaseline, plan, runPipeline, applyRun } from './pipeline.js';
import { diffSnapshots, loadSnapshot } from './artifacts.js';
import { installGigacode } from './install.js';
import { executeJob, jobStatus, startJob } from './jobs.js';
import { serve } from './server.js';
import { acceptRun } from './accept.js';
import { runTransfer } from './transfer.js';
import { createScopedSnapshot } from './scope.js';

async function main() {
  const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string', default: 'pixso-react.config.json' }, project: { type: 'string', default: '.' },
    artifacts: { type: 'string' }, snapshot: { type: 'string' }, file: { type: 'string' }, screen: { type: 'string' }, url: { type: 'string' },
    output: { type: 'string' }, run: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' },
    job: { type: 'string' }, action: { type: 'string' }, repair: { type: 'string' }, resume: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    iterations: { type: 'string', default: '2' },
    nodes: { type: 'string' }, 'scope-name': { type: 'string' }, 'change-note': { type: 'string' }, 'previous-snapshot': { type: 'string' },
  } });
  const command = positionals[0] ?? 'help', configPath = path.resolve(o.config!);
  const required = (name: keyof typeof o) => { const value = o[name]; if (typeof value !== 'string' || !value) throw new Error(`--${name} is required`); return value; };
  const versionOptions = { changeNote: o['change-note'], previousSnapshot: o['previous-snapshot'] ? path.resolve(o['previous-snapshot']) : undefined };
  const nodeIds = o.nodes?.split(',').map(id => id.trim());
  const captureOptions = { ...versionOptions, nodeIds, scopeName: o['scope-name'] };
  if (o.help || command === 'help') {
    console.log(`Pixso React Bridge — local Node MCP + GigaCode CLI\n\ninit --project DIR [--artifacts DIR]\ninstall --config FILE\nserve --config FILE\ninspect --config FILE\ncapture [--nodes ID1,ID2 --scope-name NAME] [--change-note TEXT --previous-snapshot DIR] --config FILE\nimport --file capture.json [--change-note TEXT --previous-snapshot DIR] --config FILE\nscope --snapshot DIR --nodes ID1,ID2 [--scope-name NAME --change-note TEXT --previous-snapshot DIR] --config FILE\nsnapshot --snapshot DIR\nplan --snapshot DIR --config FILE\ngenerate --snapshot DIR [--output DIR] --config FILE\nrun --snapshot DIR [--run DIR --resume] [--repair report.json] --config FILE\napply --run DIR --config FILE\naccept --run DIR --config FILE\ntransfer --snapshot DIR [--iterations 2] --config FILE\nverify --snapshot DIR --screen ID --url http://127.0.0.1:5173 --config FILE\ndiff --before DIR --after DIR\nstart --action capture|run|verify|transfer [--snapshot DIR] --config FILE\nstatus --job ID --config FILE\n\nNo command treats an unverified capture or baseline as a finished transfer.`); return;
  }
  if ((nodeIds !== undefined || o['scope-name'] !== undefined) && !['capture', 'scope', 'start'].includes(command)) throw new Error('--nodes and --scope-name apply only to capture, scope or start --action capture');
  if ((o['change-note'] !== undefined || o['previous-snapshot'] !== undefined) && !['capture', 'import', 'scope', 'start'].includes(command)) throw new Error('Version notes apply only to capture, import, scope or start --action capture');
  let result: unknown;
  if (command === 'init') result = { config: await initConfig(o.project!, o.artifacts) };
  else if (command === 'serve') { await serve(configPath); return; }
  else if (command === 'job-execute') { await executeJob(required('job')); return; }
  else if (command === 'diff') result = await diffSnapshots(required('before'), required('after'));
  else if (command === 'snapshot') { const { manifest } = await loadSnapshot(required('snapshot')); result = { id: manifest.id, completeness: manifest.completeness, nodeCount: manifest.nodeCount, screens: manifest.screens.map(s => ({ id: s.id, name: s.name, path: s.path, nodeCount: s.nodeIds.length })) }; }
  else {
    const c = await loadConfig(configPath);
    if (command === 'install') result = await installGigacode(c.projectRoot, configPath);
    else if (command === 'inspect') result = await inspectPixso(c.pixso);
    else if (command === 'capture') result = await captureOperation(c, captureOptions);
    else if (command === 'import') result = await importOperation(c, path.resolve(required('file')), versionOptions);
    else if (command === 'scope') { required('nodes'); result = { snapshot: await createScopedSnapshot(required('snapshot'), nodeIds!, c, { ...versionOptions, name: o['scope-name'] }) }; }
    else if (command === 'generate') result = await generateBaseline(required('snapshot'), c, o.output);
    else if (command === 'plan') { const r = await plan(required('snapshot'), c, o.run); result = { runDir: r.runDir, tasks: r.tasks.length }; }
    else if (command === 'run') result = await runPipeline(required('snapshot'), c, { runDir: o.run, resume: o.resume, repairReport: o.repair });
    else if (command === 'apply') result = await applyRun(required('run'), c);
    else if (command === 'accept') result = await acceptRun(required('run'), c);
    else if (command === 'transfer') result = await runTransfer(required('snapshot'), c, { runDir:o.run, resume:o.resume, iterations:Number(o.iterations) });
    else if (command === 'verify') result = await verifyOperation(c, required('snapshot'), required('screen'), o.url, o.output);
    else if (command === 'start') {
      const action = required('action'); if (!['capture', 'run', 'verify', 'transfer'].includes(action)) throw new Error('Unknown job action');
      result = await startJob({ action: action as 'capture' | 'run' | 'verify' | 'transfer', config: configPath, snapshot: o.snapshot, screenId: o.screen, url: o.url, runDir: o.run, resume: o.resume, repairReport: o.repair, iterations:Number(o.iterations), ...captureOptions });
    } else if (command === 'status') result = await jobStatus(configPath, required('job'));
    else throw new Error(`Unknown command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result && typeof result === 'object' && (('status' in result && ['failed', 'analysis-failed', 'generation-failed', 'generated-with-gaps', 'geometry-only', 'blocked-design-system', 'blocked-project-data'].includes(String(result.status))) || (command === 'verify' && 'complete' in result && result.complete !== true))) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
