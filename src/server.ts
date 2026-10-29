import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { startJob, jobStatus } from './jobs.js';
import { importOperation, inspectPixso } from './operations.js';
import { generateBaseline, plan, applyRun } from './pipeline.js';
import { diffSnapshots, loadSnapshot } from './artifacts.js';
import { inside, writeJson } from './fs.js';
import { acceptRun } from './accept.js';
import { createScopedSnapshot } from './scope.js';

export async function serve(configPath: string) {
  const server = new McpServer({ name: 'pixso-react', version: '1.2.0' });
  const reply = async (fn: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await fn()) }] }; }
    catch (error: any) { return { isError: true, content: [{ type: 'text' as const, text: error.message }] }; }
  };
  server.tool('pixso_status', 'Check local configuration and artifact root. No design content is sent to this tool response.', {}, () => reply(async () => {
    const c = await loadConfig(configPath); return { projectRoot: c.projectRoot, artifactsDir: c.artifactsDir, outputDir: c.generation.outputDir, workers: c.gigacode.concurrency, pixsoTransport: c.pixso.transport, validationMode: c.validation.mode, designSystem: c.generation.designSystem, next: 'pixso_inspect, then pixso_start_job action=capture; report all component-plan blockers explicitly' };
  }));
  server.tool('pixso_inspect', 'Discover actual Pixso tool names and required arguments. Full schemas are retained in raw/tools.json during capture.', {}, () => reply(async () => {
    const info=await inspectPixso((await loadConfig(configPath)).pixso);
    return {...info,tools:info.tools.map(t=>({name:t.name,arguments:Object.keys(t.inputSchema?.properties??{}),required:t.inputSchema?.required??[]}))};
  }));
  server.tool('pixso_start_job', 'Start a background capture, GigaCode agent swarm, or local screenshot verification. Poll pixso_job_status. Data and logs stay on disk.', {
    action: z.enum(['capture', 'run', 'verify', 'transfer']), snapshot: z.string().optional(), runDir: z.string().optional(), resume: z.boolean().optional(), screenId: z.string().optional(), url: z.string().optional(), repairReport: z.string().optional(), iterations:z.number().int().min(1).max(5).optional(),
    nodeIds: z.array(z.string().min(1)).min(1).optional(), scopeName: z.string().min(1).optional(), changeNote: z.string().optional(), previousSnapshot: z.string().optional(),
  }, args => reply(() => startJob({ ...args, config: configPath })));
  server.tool('pixso_job_status', 'Read compact job state; read resultPath in chunks using pixso_read_artifact.', { jobId: z.string() }, args => reply(() => jobStatus(configPath, args.jobId)));
  server.tool('pixso_import', 'Import a complete canonical export bundle; rejects missing nodes or incomplete captures. Optional dated per-screen changelog.', { file: z.string(), changeNote: z.string().optional(), previousSnapshot: z.string().optional() }, args => reply(async () => importOperation(await loadConfig(configPath), path.resolve(args.file), args)));
  server.tool('pixso_scope', 'Create an immutable version for selected microfrontend roots and descendants; host ancestors remain context only. Requires independent PNG references for selected roots; otherwise recapture using nodeIds.', { snapshot: z.string(), nodeIds: z.array(z.string().min(1)).min(1), scopeName: z.string().optional(), changeNote: z.string().optional(), previousSnapshot: z.string().optional() }, args => reply(async () => ({ snapshot: await createScopedSnapshot(args.snapshot, args.nodeIds, await loadConfig(configPath), { name: args.scopeName, changeNote: args.changeNote, previousSnapshot: args.previousSnapshot }) })));
  server.tool('pixso_snapshot', 'Check snapshot integrity and page through screen IDs. Follow nextOffset until null.', { snapshot: z.string(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(50).default(25) }, args => reply(async () => {
    const { manifest, capture } = await loadSnapshot(args.snapshot);const end=Math.min(manifest.screens.length,args.offset+args.limit);
    return { id: manifest.id, nodeCount: manifest.nodeCount, completeness: manifest.completeness, scope: capture.scope ? { kind: capture.scope.kind, rootIds: capture.scope.rootIds, name: capture.scope.name, ancestorCount: capture.scope.ancestors.length } : undefined, screenCount:manifest.screens.length,nextOffset:end<manifest.screens.length?end:null, screens: manifest.screens.slice(args.offset,end).map(s => ({ id: s.id, namePreview: s.name.slice(0,200), path: s.path, nodeCount: s.nodeIds.length, tasks: s.widgets.length, changelog: manifest.files[`${s.path}/CHANGELOG.md`] ? path.join(args.snapshot, s.path, 'CHANGELOG.md') : undefined })) };
  }));
  server.tool('pixso_plan', 'Index project CSS/components and persist disjoint analysis tasks.', { snapshot: z.string() }, args => reply(async () => {
    const result = await plan(args.snapshot, await loadConfig(configPath)); return { runDir: result.runDir, tasks: result.tasks.length, plan: path.join(result.runDir, 'plan.json') };
  }));
  server.tool('pixso_baseline', 'Generate React+TS+CSS baseline for every screen, preserving node IDs. Baseline is not a completed transfer.', { snapshot: z.string() }, args => reply(async () => {
    const r = await generateBaseline(args.snapshot, await loadConfig(configPath)); return { runDir: r.runDir, report: path.join(r.runDir, 'baseline.json'), status: r.status };
  }));
  server.tool('pixso_apply', 'Apply a successful staged swarm run to the configured generated-code directory; protects user edits. Mount screens and validate afterwards.', { runDir: z.string() }, args => reply(async () => {const r=await applyRun(args.runDir, await loadConfig(configPath));return {outputDir:r.outputDir,fileCount:r.files.length,reportPath:path.join(args.runDir,'applied.json'),next:r.next};}));
  server.tool('pixso_accept', 'Require verified component compatibility and project data bindings, typecheck installed code, and prove exact RGBA equality for EVERY captured screen in the installed-code harness. Report all component/data gaps. Tolerant mode cannot complete a transfer.', { runDir:z.string() }, args => reply(async () => {const r=await acceptRun(args.runDir,await loadConfig(configPath));return {status:r.status,complete:r.complete,pixelPerfect:r.pixelPerfect,componentPlan:r.componentPlan,dataPlan:r.dataPlan,reportPath:r.reportPath,screenCount:r.screens.length,issueCount:r.issues.length};}));
  server.tool('pixso_diff', 'Compare stable IDs; persist all changes and return counts so large diffs cannot be truncated.', { before: z.string(), after: z.string() }, args => reply(async () => {const r=await diffSnapshots(args.before,args.after);const reportPath=path.join(args.after,'runs',`diff-${Date.now()}.json`);await writeJson(reportPath,r);return {reportPath,added:r.added.length,removed:r.removed.length,changed:r.changed.length};}));
  server.tool('pixso_read_artifact', 'Read exact text ranges from artifact files. Always follow nextOffset until null; files are never silently truncated. Binary images should be opened by file path.', {
    file: z.string(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(24000).default(12000),
  }, args => reply(async () => {
    const config = await loadConfig(configPath), root = await realpath(config.artifactsDir), target = await realpath(path.resolve(root, args.file));
    inside(root, path.relative(root, target));
    if (!/\.(json|jsonl|txt|log|md|css|tsx?|html|svg)$/.test(target)) throw new Error('Binary artifact: use local file path');
    const content = await readFile(target, 'utf8');
    if (args.offset > content.length) throw new Error('offset exceeds file length');
    let end = Math.min(content.length, args.offset + args.limit);
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
    if (end === args.offset && end < content.length) end += 2;
    return { file: target, offset: args.offset, totalCharacters: content.length, content: content.slice(args.offset, end), nextOffset: end < content.length ? end : null };
  }));
  await server.connect(new StdioServerTransport());
}
