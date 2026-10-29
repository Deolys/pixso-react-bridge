import path from 'node:path';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { capturePixso, inspectPixso } from './pixso/index.js';
import { absoluteAssets, loadSnapshot, saveSnapshot } from './artifacts.js';
import { json, slug, writeJson } from './fs.js';
import { screenCapture } from './pipeline.js';
import { validateScreen } from './validate/index.js';
import type { BridgeConfig, Capture } from './types.js';

export interface VersionOptions { changeNote?: string; previousSnapshot?: string }
export interface CaptureOptions extends VersionOptions { nodeIds?: string[]; scopeName?: string }
export function validateCaptureOptions(options: CaptureOptions): void {
  if (options.nodeIds !== undefined && (!Array.isArray(options.nodeIds) || !options.nodeIds.length || options.nodeIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(options.nodeIds).size !== options.nodeIds.length)) throw new Error('nodeIds must contain distinct nonempty node IDs');
  if (options.scopeName !== undefined && (typeof options.scopeName !== 'string' || !options.scopeName.trim())) throw new Error('scopeName must be a nonempty string');
  for (const key of ['changeNote', 'previousSnapshot'] as const) if (options[key] !== undefined && typeof options[key] !== 'string') throw new Error(`${key} must be a string`);
  if (options.previousSnapshot !== undefined && !options.previousSnapshot.trim()) throw new Error('previousSnapshot must be a nonempty path');
}
export async function captureOperation(config: BridgeConfig, options: CaptureOptions = {}) {
  validateCaptureOptions(options);
  const rawDir = path.join(config.artifactsDir, 'captures', `${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(rawDir, { recursive: true });
  const capture = await capturePixso({ ...config.pixso, ...(options.nodeIds ? { nodeIds: options.nodeIds } : {}), ...(options.scopeName ? { scopeName: options.scopeName } : {}) }, rawDir);
  await writeJson(path.join(rawDir, 'capture.json'), capture);
  const snapshot = await saveSnapshot(capture, config.artifactsDir, { ...config.generation, rawDir, baseDir: rawDir, changelog: { enabled: config.versioning?.screenChangelog, summary: options.changeNote, previousSnapshot: options.previousSnapshot } });
  return { snapshot, nodes: capture.nodes.length, completeness: capture.completeness, scope: capture.scope ? { kind: capture.scope.kind, rootIds: capture.scope.rootIds, name: capture.scope.name, ancestorCount: capture.scope.ancestors.length } : undefined };
}
export async function importOperation(config: BridgeConfig, filename: string, options: VersionOptions = {}) {
  validateCaptureOptions(options);
  const capture = await json<Capture>(filename);
  const baseDir=path.dirname(filename), candidate=path.join(baseDir,'raw');
  let rawDir:string|undefined;
  try { if((await stat(candidate)).isDirectory()) rawDir=candidate; }
  catch(error:any){if(error.code!=='ENOENT')throw error;}
  const snapshot = await saveSnapshot(capture, config.artifactsDir, { ...config.generation, baseDir, rawDir, changelog: { enabled: config.versioning?.screenChangelog, summary: options.changeNote, previousSnapshot: options.previousSnapshot } });
  return { snapshot, nodes: capture.nodes.length, completeness: capture.completeness };
}
export async function verifyOperation(config: BridgeConfig, snapshot: string, screenId: string, url?: string, outputDir?: string) {
  const { capture, manifest } = await loadSnapshot(snapshot);
  const screen = manifest.screens.find(s => s.id === screenId); if (!screen) throw new Error(`Unknown screen: ${screenId}`);
  const subset = screenCapture(absoluteAssets(capture, snapshot), screen), root = subset.nodes.find(n => n.id === screenId)!;
  if (!root.bounds || !root.bounds.width || !root.bounds.height) throw new Error('Screen has no measurable viewport');
  const reference = subset.screenshots.find(r => r.nodeId === screenId);
  if (reference && reference.scale !== 1) throw new Error('Reference screenshot must have scale=1 for an exact viewport comparison');
  const target = url ?? config.validation.url; if (!target) throw new Error('Provide a local preview URL with --url or validation.url');
  const report = await validateScreen({
    ...config.validation,
    url: target, rootNodeId: screenId, nodes: subset.nodes,
    referencePath: reference?.path,
    viewport: { width: Math.ceil(root.bounds.width), height: Math.ceil(root.bounds.height) },
    outputDir: outputDir ?? path.join(snapshot, 'runs', `verify-${Date.now()}-${randomUUID().slice(0, 8)}`, slug(screenId)),
  });
  return report;
}
export { inspectPixso };
