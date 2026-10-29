import { mkdir, readFile, writeFile, copyFile, rename, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, inside, json, slug, writeJson } from './fs.js';
import type { Capture, DesignNode, ScreenIndex, SnapshotManifest } from './types.js';
import { buildScreenChangelogs } from './changelog.js';

export function assertCapture(c: Capture): void {
  if (c.schemaVersion !== 1 || !c.source?.fileKey || !Array.isArray(c.nodes) || !Array.isArray(c.roots) || !c.roots.length || !Array.isArray(c.assets) || !Array.isArray(c.screenshots)) throw new Error('Invalid canonical Capture schema');
  if (c.completeness?.status !== 'complete' || c.completeness.issues.length) throw new Error(`Capture completeness is not proven: ${c.completeness?.status}; ${(c.completeness?.issues ?? []).join('; ')}`);
  const ids = new Map<string, DesignNode>();
  for (const n of c.nodes) {
    if (!n.id || ids.has(n.id)) throw new Error(`Duplicate or empty node ID: ${n.id}`);
    if (!Array.isArray(n.children) || new Set(n.children).size !== n.children.length || !n.raw || typeof n.raw !== 'object') throw new Error(`Invalid node: ${n.id}`);
    if (n.bounds && !Object.values(n.bounds).every(Number.isFinite)) throw new Error(`Invalid geometry: ${n.id}`);
    ids.set(n.id, n);
  }
  if (c.completeness.receivedNodeCount !== ids.size || c.completeness.expectedNodeCount !== ids.size) throw new Error('Node count mismatch: expected, received and actual must agree');
  if (new Set(c.roots).size !== c.roots.length) throw new Error('Duplicate roots');
  for (const n of c.nodes) {
    if (n.parentId !== null && (!ids.has(n.parentId) || !ids.get(n.parentId)!.children.includes(n.id))) throw new Error(`Missing parent relationship: ${n.id}`);
    for (const id of n.children) if (!ids.has(id) || ids.get(id)!.parentId !== n.id) throw new Error(`Missing child relationship: ${n.id} -> ${id}`);
  }
  const seen = new Set<string>();
  const stack = [...c.roots];
  while (stack.length) {
    const id = stack.pop()!; if (seen.has(id)) throw new Error(`Cycle or overlapping roots: ${id}`);
    const node = ids.get(id); if (!node) throw new Error(`Missing root: ${id}`);
    if (c.roots.includes(id) && node.parentId !== null) throw new Error(`Root must not have a parent: ${id}`);
    seen.add(id); stack.push(...node.children);
  }
  if (seen.size !== ids.size) throw new Error(`Unreachable nodes: ${ids.size - seen.size}`);
  const assetIds = new Set<string>();
  for (const a of c.assets) {
    if (!a.id || assetIds.has(a.id) || !a.path || !a.mimeType || (a.nodeId && !ids.has(a.nodeId))) throw new Error(`Invalid/duplicate asset: ${a.id}`);
    assetIds.add(a.id);
  }
  for (const s of c.screenshots) if (!ids.has(s.nodeId) || !s.path || !(s.width > 0 && s.height > 0 && s.scale > 0)) throw new Error(`Invalid reference image: ${s.nodeId}`);
  if (c.scope !== undefined) {
    const scope = c.scope;
    if (!scope || scope.kind !== 'selection' || !Array.isArray(scope.rootIds) || scope.rootIds.length !== c.roots.length || new Set(scope.rootIds).size !== scope.rootIds.length || scope.rootIds.some(id => !c.roots.includes(id)) || !Array.isArray(scope.ancestors) || (scope.name !== undefined && (typeof scope.name !== 'string' || !scope.name.trim()))) throw new Error('Invalid selection scope metadata');
    const ancestors = new Map<string, DesignNode>();
    for (const node of scope.ancestors) {
      if (!node?.id || ids.has(node.id) || ancestors.has(node.id) || !Array.isArray(node.children) || new Set(node.children).size !== node.children.length || !node.raw || typeof node.raw !== 'object' || (node.parentId !== null && typeof node.parentId !== 'string') || (node.bounds && !Object.values(node.bounds).every(Number.isFinite))) throw new Error('Invalid or duplicate scope ancestor');
      ancestors.set(node.id, node);
    }
    const reached = new Set<string>();
    for (const root of c.roots) {
      let child = ids.get(root)!; const chain = new Set([root]);
      while (true) {
        const candidates = [...ancestors.values()].filter(node => node.children.includes(child.id));
        if (candidates.length > 1) throw new Error(`Ambiguous scope ancestor for ${child.id}`);
        const parentId = typeof child.raw.parentId === 'string' ? child.raw.parentId : child.parentId ?? candidates[0]?.id;
        if (!parentId) break;
        const parent = ancestors.get(parentId);
        if (!parent || !parent.children.includes(child.id)) throw new Error(`Missing scope ancestor relationship: ${child.id} -> ${parentId}`);
        if (chain.has(parentId)) throw new Error(`Cycle in scope ancestor context: ${parentId}`);
        chain.add(parentId); reached.add(parentId); child = parent;
      }
    }
    if (reached.size !== ancestors.size) throw new Error('Unreachable scope ancestor context');
  }
}

export function descendants(id: string, nodes: Map<string, DesignNode>): string[] {
  const result: string[] = [], stack = [id];
  while (stack.length) { const next = stack.pop()!; result.push(next); stack.push(...[...nodes.get(next)!.children].reverse()); }
  return result;
}
export function indexScreens(c: Capture, maxNodes: number, maxTaskBytes = 131072): ScreenIndex[] {
  const nodes = new Map(c.nodes.map(n => [n.id, n]));
  const result: ScreenIndex[] = [];
  const queue = c.roots.map(id => ({ id, pageId: null as string | null }));
  while (queue.length) {
    const { id, pageId } = queue.shift()!, n = nodes.get(id)!;
    if (['DOCUMENT', 'PAGE', 'CANVAS', 'FOLDER', 'SECTION'].includes(n.type.toUpperCase())) {
      queue.push(...n.children.map(child => ({ id: child, pageId: n.type.toUpperCase() === 'DOCUMENT' ? pageId : n.id })));
      continue;
    }
    const nodeIds = descendants(id, nodes);
    const sizes = new Map<string, number>();
    const ownBytes=new Map(nodeIds.map(childId=>[childId,Buffer.byteLength(JSON.stringify(nodes.get(childId)))]));
    const subtreeBytes=new Map<string,number>();
    for (const childId of [...nodeIds].reverse()) {
      sizes.set(childId, 1 + nodes.get(childId)!.children.reduce((sum, key) => sum + sizes.get(key)!, 0));
      subtreeBytes.set(childId,ownBytes.get(childId)!+nodes.get(childId)!.children.reduce((sum,key)=>sum+subtreeBytes.get(key)!,0));
    }
    const dir = `pages/${slug(pageId ?? 'selection')}/screens/${slug(`${n.name}-${id}`)}`;
    const widgets: ScreenIndex['widgets'] = [];
    // Partition every node exactly once; a large widget recursively becomes smaller tasks.
    const pending = [id]; let residual: string[] = [], residualBytes=0;
    const flush=()=>{if(residual.length)widgets.push({id:residual[0],nodeIds:residual,path:''});residual=[];residualBytes=0;};
    while (pending.length) {
      const root = pending.pop()!;
      if (sizes.get(root)! <= maxNodes && subtreeBytes.get(root)! <= maxTaskBytes) {
        const group = descendants(root, nodes);
        if (residual.length + group.length > maxNodes || residualBytes+subtreeBytes.get(root)!>maxTaskBytes) flush();
        residual.push(...group);residualBytes+=subtreeBytes.get(root)!;
      } else {
        if(residualBytes+ownBytes.get(root)!>maxTaskBytes)flush();
        residual.push(root);residualBytes+=ownBytes.get(root)!;pending.push(...[...nodes.get(root)!.children].reverse());
      }
      if (residual.length >= maxNodes || residualBytes>=maxTaskBytes) flush();
    }
    flush();
    for (const [i, w] of widgets.entries()) w.path = `${dir}/widgets/${String(i + 1).padStart(4, '0')}-${slug(w.id)}.json`;
    result.push({ id, name: n.name, pageId, path: dir, nodeIds, widgets });
  }
  return result;
}

export interface SnapshotSaveOptions { maxNodesPerTask?: number; maxChunkBytes?: number; baseDir?: string; rawDir?: string; changelog?: { enabled?: boolean; summary?: string; previousSnapshot?: string } }

async function previousCompatibleSnapshot(designDir: string, capture: Capture): Promise<{capture: Capture; manifest: SnapshotManifest} | undefined> {
  const roots = JSON.stringify([...capture.roots].sort());
  const directories = (await readdir(designDir, {withFileTypes: true})).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort().reverse();
  for (const directory of directories) {
    const full = inside(designDir, directory), manifest = await json<SnapshotManifest>(path.join(full, 'manifest.json'));
    if (manifest.source.fileKey === capture.source.fileKey && JSON.stringify([...manifest.roots].sort()) === roots) return loadSnapshot(full);
  }
  return undefined;
}

export async function saveSnapshot(capture: Capture, artifactsDir: string, options: SnapshotSaveOptions = {}): Promise<string> {
  assertCapture(capture);
  const c: Capture = structuredClone(capture), chunkBytes = options.maxChunkBytes ?? 24576;
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1024) throw new Error('Chunk size must be >= 1024');
  const designDir = path.join(artifactsDir, 'designs', slug(c.source.fileKey), 'versions');
  await mkdir(designDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const staging = path.join(designDir, `.pending-${id}`), destination = path.join(designDir, id);
  await mkdir(staging);
  const files: Record<string, string> = Object.create(null);
  async function put(relative: string, data: string | Buffer) {
    const file = inside(staging, relative); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data, { flag: 'wx' }); files[relative] = hash(data);
  }
  async function putJson(relative: string, data: unknown) { await put(relative, JSON.stringify(data, null, 2) + '\n'); }
  const sourceRoot = await realpath(options.baseDir ?? '.');
  async function sourceFile(filename: string) {
    const source = await realpath(path.resolve(sourceRoot, filename));
    inside(sourceRoot, path.relative(sourceRoot, source));
    return source;
  }
  for (const asset of c.assets) {
    const source = await sourceFile(asset.path), data = await readFile(source);
    if (asset.sha256 && asset.sha256 !== hash(data)) throw new Error(`Asset hash mismatch: ${asset.id}`);
    const ext = path.extname(source).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
    asset.path = `assets/${slug(asset.id)}${ext}`; asset.sha256 = hash(data); await put(asset.path, data);
  }
  for (const [i, reference] of c.screenshots.entries()) {
    const data = await readFile(await sourceFile(reference.path));
    const sha256 = hash(data);
    if (reference.sha256 !== undefined && reference.sha256 !== sha256) throw new Error(`Reference image hash mismatch: ${reference.nodeId}`);
    reference.path = `references/${slug(reference.nodeId)}-${i}.png`; reference.sha256 = sha256; await put(reference.path, data);
  }
  if (options.rawDir) {
    const rawRoot=await realpath(options.rawDir);
    inside(sourceRoot,path.relative(sourceRoot,rawRoot));
    async function copyRaw(dir: string, relative: string) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('Raw capture cannot contain symlinks');
        const next = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await copyRaw(path.join(dir, entry.name), next);
        else await put(next, await readFile(path.join(dir, entry.name)));
      }
    }
    await copyRaw(rawRoot, 'raw');
  }
  const nodeIndex: Record<string, { path: string; name: string; type: string; children: string[]; chunks: string[]; sha256: string }> = Object.create(null);
  async function indexNode(node: DesignNode, prefix = '') {
    const filename = `${prefix}nodes/${slug(node.id)}.json`, data = Buffer.from(JSON.stringify(node, null, 2) + '\n');
    await put(filename, data); const chunks: string[] = [];
    for (let start = 0, index = 0; start < data.length; index++) {
      let end = Math.min(start + chunkBytes, data.length);
      while (end < data.length && (data[end] & 0xc0) === 0x80) end--;
      const name = `${prefix}chunks/${slug(node.id)}/${String(index + 1).padStart(5, '0')}.txt`;
      await put(name, data.subarray(start, end)); chunks.push(name); start = end;
    }
    return { path: filename, name: node.name, type: node.type, children: node.children, chunks, sha256: hash(data) };
  }
  for (const node of c.nodes) nodeIndex[node.id] = await indexNode(node);
  if (c.scope) {
    const contextIndex: typeof nodeIndex = Object.create(null);
    for (const node of c.scope.ancestors) contextIndex[node.id] = await indexNode(node, 'context/');
    await putJson('context-index.json', { kind: 'context-only', rootIds: c.scope.rootIds, name: c.scope.name, ancestors: contextIndex });
  }
  const screens = indexScreens(c, options.maxNodesPerTask ?? 180,chunkBytes*4);
  if (options.changelog?.enabled || options.changelog?.summary !== undefined) {
    const previous = options.changelog.previousSnapshot ? await loadSnapshot(path.resolve(options.changelog.previousSnapshot)) : await previousCompatibleSnapshot(designDir, c);
    for (const entry of buildScreenChangelogs({capture:c,screens,previous,createdAt,summary:options.changelog.summary})) await put(entry.relativePath,entry.text);
  }
  for (const screen of screens) {
    await putJson(`${screen.path}/index.json`, screen);
    for (const widget of screen.widgets) await putJson(widget.path, { screenId: screen.id, ...widget, nodes: widget.nodeIds.map(id => ({ id, ...nodeIndex[id] })) });
  }
  await putJson('node-index.json', nodeIndex);
  await putJson('capture.json', c);
  const manifest: SnapshotManifest = { schemaVersion: 1, id, captureHash: hash(JSON.stringify(c)), source: c.source, completeness: c.completeness, roots: c.roots, screens, nodeCount: c.nodes.length, files };
  await writeJson(path.join(staging, 'manifest.json'), manifest);
  await rename(staging, destination);
  return destination;
}

export async function loadSnapshot(dir: string): Promise<{ capture: Capture; manifest: SnapshotManifest }> {
  const manifest = await json<SnapshotManifest>(path.join(dir, 'manifest.json'));
  const entries = Object.entries(manifest.files); let nextFile = 0;
  const verifiedHashes = new Map<string, string>();
  await Promise.all(Array.from({length:Math.min(16,entries.length)}, async () => {
    while(nextFile < entries.length) {
      const [relative, expected] = entries[nextFile++];
      const actual = hash(await readFile(inside(dir, relative)));
      if (actual !== expected) throw new Error(`Snapshot integrity check failed: ${relative}`);
      verifiedHashes.set(relative, actual);
    }
  }));
  const capture = await json<Capture>(path.join(dir, 'capture.json')); assertCapture(capture);
  if (hash(JSON.stringify(capture)) !== manifest.captureHash) throw new Error('Capture hash mismatch');
  for (const reference of capture.screenshots) {
    if (!reference.sha256 || !/^[a-f0-9]{64}$/.test(reference.sha256)) throw new Error(`Reference image ${reference.nodeId} has no canonical SHA-256; recapture or import the original export into a new snapshot before pixel-perfect acceptance`);
    if (!Object.hasOwn(manifest.files, reference.path)) throw new Error(`Unhashed reference image: ${reference.path}`);
    if (verifiedHashes.get(reference.path) !== reference.sha256) throw new Error(`Reference image integrity check failed: ${reference.path}`);
  }
  if (manifest.nodeCount !== capture.nodes.length || JSON.stringify(manifest.roots) !== JSON.stringify(capture.roots)) throw new Error('Manifest inventory mismatch');
  const expectedScreens = indexScreens(capture, 100000);
  if (manifest.screens.length !== expectedScreens.length || new Set(manifest.screens.map(s => s.id)).size !== manifest.screens.length) throw new Error('Manifest screen coverage mismatch');
  for (const expected of expectedScreens) {
    const actual = manifest.screens.find(s => s.id === expected.id);
    if (!actual || actual.path !== expected.path || actual.pageId !== expected.pageId || JSON.stringify(actual.nodeIds) !== JSON.stringify(expected.nodeIds)) throw new Error(`Manifest screen inventory mismatch: ${expected.id}`);
    const partition = actual.widgets.flatMap(w => w.nodeIds);
    const partitionIds = new Set(partition);
    if (partition.length !== expected.nodeIds.length || partitionIds.size !== partition.length || expected.nodeIds.some(id => !partitionIds.has(id))) throw new Error(`Manifest widget coverage mismatch: ${expected.id}`);
    for (const widget of actual.widgets) {
      if (!Object.hasOwn(manifest.files, widget.path)) throw new Error(`Unhashed widget index: ${widget.path}`);
      const stored = await json<{nodeIds:string[]}>(inside(dir,widget.path));
      if (JSON.stringify(stored.nodeIds) !== JSON.stringify(widget.nodeIds)) throw new Error('Widget index mismatch');
    }
  }
  return { capture, manifest };
}
export function absoluteAssets(c: Capture, snapshot: string): Capture {
  return { ...c, assets: c.assets.map(a => ({ ...a, path: inside(snapshot, a.path) })), screenshots: c.screenshots.map(s => ({ ...s, path: inside(snapshot, s.path) })) };
}
export async function diffSnapshots(before: string, after: string) {
  const [a, b] = await Promise.all([loadSnapshot(before), loadSnapshot(after)]);
  if (a.capture.source.fileKey !== b.capture.source.fileKey) throw new Error('Cannot diff different design files');
  const left = new Map(a.capture.nodes.map(n => [n.id, hash(JSON.stringify(n))]));
  const right = new Map(b.capture.nodes.map(n => [n.id, hash(JSON.stringify(n))]));
  return { before: a.manifest.id, after: b.manifest.id, added: [...right.keys()].filter(id => !left.has(id)), removed: [...left.keys()].filter(id => !right.has(id)), changed: [...right].filter(([id, value]) => left.has(id) && left.get(id) !== value).map(([id]) => id) };
}
