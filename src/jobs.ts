import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { json, writeJson, inside } from './fs.js';
import { captureOperation, validateCaptureOptions, verifyOperation, type CaptureOptions } from './operations.js';
import { runPipeline } from './pipeline.js';

export interface JobRequest extends CaptureOptions { action: 'capture' | 'run' | 'verify' | 'transfer'; config: string; snapshot?: string; runDir?: string; resume?: boolean; screenId?: string; url?: string; repairReport?: string; iterations?: number }
export async function startJob(request: JobRequest) {
  if (!['capture', 'run', 'verify', 'transfer'].includes(request.action)) throw new Error('Unknown job action');
  validateCaptureOptions(request);
  if (request.action !== 'capture' && ['nodeIds', 'scopeName', 'changeNote', 'previousSnapshot'].some(key => request[key as keyof JobRequest] !== undefined)) throw new Error('nodeIds, scopeName, changeNote and previousSnapshot are capture-only job options');
  if (request.action !== 'capture' && !request.snapshot) throw new Error('snapshot is required');
  if (request.action === 'verify' && !request.screenId) throw new Error('screenId is required');
  request = {
    ...request, config: path.resolve(request.config),
    ...(request.snapshot ? { snapshot: path.resolve(request.snapshot) } : {}),
    ...(request.runDir ? { runDir: path.resolve(request.runDir) } : {}),
    ...(request.repairReport ? { repairReport: path.resolve(request.repairReport) } : {}),
    ...(request.previousSnapshot ? { previousSnapshot: path.resolve(request.previousSnapshot) } : {}),
  };
  const config = await loadConfig(request.config);
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`, dir = path.join(config.artifactsDir, 'jobs', id);
  await mkdir(dir, { recursive: true }); await writeJson(path.join(dir, 'request.json'), { ...request, config: path.resolve(request.config) });
  const stdout = await open(path.join(dir, 'stdout.log'), 'wx'), stderr = await open(path.join(dir, 'stderr.log'), 'wx');
  try {
    const sourceMode = import.meta.url.endsWith('.ts');
    const cli = fileURLToPath(new URL(sourceMode ? './cli.ts' : './cli.js', import.meta.url));
    const loader = sourceMode ? ['--import', import.meta.resolve('tsx')] : [];
    const child = spawn(process.execPath, [...loader, cli, 'job-execute', '--job', dir], { cwd: config.projectRoot, detached: true, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd] });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); await writeJson(path.join(dir, 'process.json'), { pid: child.pid, startedAt: new Date().toISOString() });
    return { jobId: id, directory: dir, pid: child.pid, status: 'started' };
  } finally { await stdout.close(); await stderr.close(); }
}
export async function executeJob(dir: string) {
  const request = await json<JobRequest>(path.join(dir, 'request.json'));
  await writeJson(path.join(dir, 'status.json'), { status: 'running', startedAt: new Date().toISOString() });
  try {
    const config = await loadConfig(request.config);
    let result: unknown;
    if (request.action === 'capture') result = await captureOperation(config, request);
    else if (request.action === 'run') { if (!request.snapshot) throw new Error('snapshot is required'); result = await runPipeline(request.snapshot, config, request); }
    else if (request.action === 'verify') { if (!request.snapshot || !request.screenId) throw new Error('snapshot and screenId required'); result = await verifyOperation(config, request.snapshot, request.screenId, request.url, request.runDir); }
    else if (request.action === 'transfer') { if (!request.snapshot) throw new Error('snapshot is required'); const { runTransfer } = await import('./transfer.js'); result = await runTransfer(request.snapshot, config, request); }
    else throw new Error('Unknown job action');
    const outcome = jobOutcome(result, request.action);
    await writeJson(path.join(dir, 'result.json'), result);
    await writeJson(path.join(dir, 'status.json'), { ...outcome, finishedAt: new Date().toISOString(), resultPath: path.join(dir, 'result.json') });
    if (outcome.status === 'failed') process.exitCode = 1;
  } catch (error: any) { await writeJson(path.join(dir, 'status.json'), { status: 'failed', error: error.message, finishedAt: new Date().toISOString() }); throw error; }
}

export function jobOutcome(result: unknown, action?: JobRequest['action']): { status: 'succeeded' | 'failed'; resultStatus?: string; complete?: boolean } {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const resultStatus = typeof record.status === 'string' ? record.status : undefined;
  const failed = ((action === 'transfer' || action === 'verify') && record.complete !== true) || (resultStatus !== undefined && ['analysis-failed', 'generation-failed', 'failed', 'generated-with-gaps', 'geometry-only', 'blocked-design-system', 'blocked-project-data'].includes(resultStatus));
  return { status: failed ? 'failed' : 'succeeded', ...(resultStatus ? { resultStatus } : {}), ...(typeof record.complete === 'boolean' ? { complete: record.complete } : {}) };
}
export async function jobStatus(configPath: string, jobId: string) {
  const config = await loadConfig(configPath), directory = inside(path.join(config.artifactsDir, 'jobs'), jobId);
  let status: any = { status: 'starting' };
  try { status = await json(path.join(directory, 'status.json')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  if (['starting', 'running'].includes(status.status)) {
    try { const { pid } = await json<{pid:number}>(path.join(directory, 'process.json')); process.kill(pid, 0); }
    catch (e: any) { if (e.code === 'ESRCH') status = { ...status, status: 'interrupted', error: 'Process exited without a final report; inspect logs and resume.' }; else if (e.code !== 'ENOENT') throw e; }
  }
  if (status.resultPath) {
    const result = await json<any>(status.resultPath);
    if (result.componentPlan) status.componentPlan = result.componentPlan;
    if (result.dataPlan) status.dataPlan = result.dataPlan;
    if (typeof result.reason === 'string') status.reason = result.reason;
    if (typeof result.pixelPerfect === 'boolean') status.pixelPerfect = result.pixelPerfect;
  }
  return { jobId, directory, ...status };
}
