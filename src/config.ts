import path from 'node:path';
import { access, mkdir } from 'node:fs/promises';
import { json, writeJson } from './fs.js';
import type { BridgeConfig } from './types.js';

export function defaultConfig(projectRoot: string): BridgeConfig {
  return {
    schemaVersion: 1, projectRoot: path.resolve(projectRoot), artifactsDir: '.pixso-artifacts',
    pixso: { transport: 'http', url: 'http://127.0.0.1:3667/mcp', nodeIds: [] },
    gigacode: { command: 'gigacode', args: [], concurrency: 4, timeoutMs: 900000, retries: 1 },
    generation: { outputDir: 'src/pixso-generated', cssFiles: [], componentFiles: [], maxNodesPerTask: 180, maxChunkBytes: 24576 },
    validation: { mode: 'pixel-perfect', maxPixelDiffRatio: 0, geometryTolerancePx: 0.01, commands: [] },
    versioning: { screenChangelog: false },
  };
}
export async function initConfig(projectRoot: string, artifactsDir?: string): Promise<string> {
  const root = path.resolve(projectRoot); await mkdir(root, { recursive: true });
  const filename = path.join(root, 'pixso-react.config.json');
  try { await access(filename); throw new Error(`Configuration already exists: ${filename}`); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const config = defaultConfig(root);
  if (artifactsDir) config.artifactsDir = artifactsDir;
  await writeJson(filename, config); return filename;
}
export async function loadConfig(filename: string): Promise<BridgeConfig> {
  const c = await json<BridgeConfig>(filename);
  if (c.schemaVersion !== 1 || !c.projectRoot || !c.artifactsDir || !c.pixso || !c.gigacode || !c.generation || !c.validation) throw new Error('Invalid pixso-react.config.json; run init to see the schema');
  c.projectRoot = path.resolve(path.dirname(filename), c.projectRoot);
  c.artifactsDir = path.resolve(c.projectRoot, c.artifactsDir);
  c.generation.outputDir = path.resolve(c.projectRoot, c.generation.outputDir);
  for (const [name, value, min, max] of [
    ['gigacode.concurrency', c.gigacode.concurrency, 1, 32], ['gigacode.timeoutMs', c.gigacode.timeoutMs, 100, 86400000],
    ['gigacode.retries', c.gigacode.retries, 0, 10], ['generation.maxNodesPerTask', c.generation.maxNodesPerTask, 1, 100000],
    ['generation.maxChunkBytes', c.generation.maxChunkBytes, 1024, 1048576],
  ] as const) if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  if (!['stdio', 'http', 'sse'].includes(c.pixso.transport)) throw new Error('Unknown MCP transport');
  if (!c.gigacode.command || !Array.isArray(c.gigacode.args) || c.gigacode.args.some(x => typeof x !== 'string')) throw new Error('Invalid GigaCode command/args');
  for (const ratio of [c.validation.maxPixelDiffRatio]) if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error('Pixel diff ratio must be 0..1');
  if (!Number.isFinite(c.validation.geometryTolerancePx) || c.validation.geometryTolerancePx < 0) throw new Error('Invalid geometry tolerance');
  c.validation.mode ??= 'pixel-perfect';
  if (!['pixel-perfect', 'tolerant'].includes(c.validation.mode)) throw new Error('validation.mode must be pixel-perfect or tolerant');
  if (c.generation.designSystem && (typeof c.generation.designSystem.name !== 'string' || !c.generation.designSystem.name.trim() || (c.generation.designSystem.packageName !== undefined && (typeof c.generation.designSystem.packageName !== 'string' || !c.generation.designSystem.packageName.trim())))) throw new Error('generation.designSystem requires a name and an optional packageName');
  for (const key of ['cssFiles', 'componentFiles'] as const) if (!Array.isArray(c.generation[key]) || c.generation[key].some(x => typeof x !== 'string')) throw new Error(`Invalid generation.${key}`);
  if (!Array.isArray(c.validation.commands)) throw new Error('validation.commands must be an array');
  if (c.versioning !== undefined && (!c.versioning || typeof c.versioning.screenChangelog !== 'boolean')) throw new Error('versioning.screenChangelog must be a boolean');
  if (c.generation.data !== undefined && (!c.generation.data || typeof c.generation.data !== 'object' || Array.isArray(c.generation.data))) throw new Error('generation.data must be an object');
  for (const [name, value] of [['validation.setupFile', c.validation.setupFile], ['generation.data.setupFile', c.generation.data?.setupFile], ['generation.data.instructions', c.generation.data?.instructions]] as const) if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new Error(`Invalid ${name}`);
  if (c.generation.data?.mockFiles !== undefined && (!Array.isArray(c.generation.data.mockFiles) || c.generation.data.mockFiles.some(value => typeof value !== 'string' || !value.trim()))) throw new Error('generation.data.mockFiles must contain project-relative file paths');
  return c;
}
