import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import type { Asset, Capture, DesignNode, Raw } from '../types.js';
import { connectPixso, type PixsoConfig, type PixsoConnection } from './client.js';
import { collectReferences, explicitTruncation, extractDslNodes, normalizeNode, verifyInventory, screenshotNodes } from './normalize.js';
import { imageScript, inventoryChunkScript, nodeScript, referenceScript } from './scripts.js';

export { decodeToolResult } from './client.js';
export { collectReferences, extractDslNodes, verifyInventory } from './normalize.js';
export { screenshotNodes } from './normalize.js';

export async function inspectPixso(config: PixsoConfig) {
  const connection = await connectPixso(config);
  try {
    return { tools: connection.tools, completeCaptureSupported: connection.tools.some(t => t.name === 'eval_script'),
      recommendation: 'Use current Pixso local/new remote MCP with eval_script. Legacy DSL-only servers require an independently verified export.' };
  } finally { await connection.close(); }
}

export async function capturePixso(config: PixsoConfig, rawDir: string): Promise<Capture> {
  const connection = await connectPixso(config, rawDir);
  try { return await captureConnected(connection, config, resolve(rawDir)); }
  finally { await connection.close(); }
}

/** Public for integration tests with an MCP-shaped, deterministic fake. */
export async function captureConnected(connection: PixsoConnection, config: PixsoConfig, rawDir: string): Promise<Capture> {
  await mkdir(rawDir, { recursive: true });
  const issues: string[] = [];
  const capture: Capture = {
    schemaVersion: 1, source: { provider: 'pixso-mcp', fileKey: config.fileKey ?? 'unknown', name: 'Pixso design', capturedAt: new Date().toISOString() },
    roots: [], nodes: [], assets: [], screenshots: [], completeness: { status: 'unverified', receivedNodeCount: 0, issues },
  };
  const evalTool = connection.tools.find(t => t.name === 'eval_script');
  if (!evalTool) return captureDslOnly(connection, config, capture);
  const parameters = evalTool.inputSchema?.properties ?? {};
  const scriptKey = ['script', 'code', 'javascript'].find(key => key in parameters);
  if (!scriptKey) { issues.push('Unknown eval_script schema; no supported script/code parameter. Upgrade the version adapter.'); return capture; }
  const concurrency = integer(config.concurrency, 4, 1, 16);
  const chunkSize = integer(config.chunkChars, 24_000, 256, 1_000_000);
  const requested = [...new Set(config.nodeIds ?? [])];
  const invoke = async (script: string): Promise<Raw> => {
    const result = await connection.call('eval_script', { [scriptKey]: script, file_key: config.fileKey, fileKey: config.fileKey });
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('eval_script returned an unknown envelope');
    if (explicitTruncation(result)) throw new Error('Pixso explicitly reported truncated/paginated script output');
    const data = result as Raw;
    if (data.fileKey && capture.source.fileKey !== 'unknown' && data.fileKey !== capture.source.fileKey) throw new Error('Active Pixso file changed or does not match configured fileKey');
    return data;
  };
  const readInventory = async () => {
    const rows: Raw[] = []; let total = -1; let roots: string[] = [];
    do {
      const result = await readChunks((offset, size) => inventoryChunkScript(requested, rows.length, 150, offset, size));
      const data = JSON.parse(result.content);
      if (!Number.isSafeInteger(data.total) || data.total < 0 || data.offset !== rows.length || !Array.isArray(data.rows) || !Array.isArray(data.roots)) throw new Error('Malformed inventory pagination envelope');
      if (!data.fileKey) throw new Error('Pixso fileKey is unavailable: cannot verify the active document');
      capture.source.fileKey = data.fileKey;
      if (total >= 0 && (total !== data.total || JSON.stringify(roots) !== JSON.stringify(data.roots))) throw new Error('Pixso inventory changed during pagination');
      total = data.total; roots = data.roots; capture.source.name = data.name ?? capture.source.name;
      if (!data.rows.length && rows.length < total) throw new Error('Inventory pagination stopped before total');
      rows.push(...data.rows);
    } while (rows.length < total);
    if (rows.length !== total) throw new Error('Inventory pagination exceeded total');
    return { rows, total, roots };
  };
  const readChunks = async (script: (offset: number, size: number) => string) => {
    let content = ''; let total = -1; let fingerprint: string | undefined; let size = chunkSize;
    do {
      let part: Raw;
      try { part = await invoke(script(content.length, size)); }
      catch (error) {
        if (size <= 256 || /quota|daily|rate.?limit|permission|auth/i.test(String(error)) || !/JSON|truncat|too large|(?:output|response|payload).*(?:limit|exceed|size)/i.test(String(error))) throw error;
        size = Math.max(256, Math.floor(size / 2)); continue;
      }
      if (!Number.isSafeInteger(part.total) || part.total < 0 || part.offset !== content.length || typeof part.chunk !== 'string' || typeof part.fingerprint !== 'string') throw new Error('Malformed chunk envelope');
      if (total >= 0 && (part.total !== total || part.fingerprint !== fingerprint)) throw new Error('Design content changed between chunks; recapture a stable version');
      total = part.total; fingerprint = part.fingerprint;
      if (!part.chunk.length && content.length < total) throw new Error('Chunk transfer stopped early');
      content += part.chunk;
    } while (content.length < total);
    if (content.length !== total) throw new Error('Chunk length does not match declared total');
    return { content, fingerprint: fingerprint! };
  };
  const before = await readInventory();
  capture.roots = before.roots;
  capture.completeness.expectedNodeCount = before.total;
  if (!before.total) { issues.push('Requested scope contains no nodes'); return capture; }
  const ids = new Set(before.rows.map(row => row.id));
  const fingerprints = new Map<string, string>();
  await parallel(before.rows, concurrency, async row => {
    try {
      const result = await readChunks((offset, size) => nodeScript(row.id, offset, size));
      const data = JSON.parse(result.content);
      if (!data.raw || data.raw.id !== row.id || !Array.isArray(data.errors)) throw new Error('Node serialization envelope is malformed');
      issues.push(...data.errors.map((error: string) => `Property unavailable: ${error}`));
      capture.nodes.push(normalizeNode(data.raw, ids)); fingerprints.set(row.id, result.fingerprint);
    } catch (error) { issues.push(`Node ${row.id}: ${message(error)}`); }
  });
  // Stable ordering makes content hashes and downstream diffs deterministic.
  const order = new Map(before.rows.map((n, i) => [n.id, i]));
  capture.nodes.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  issues.push(...verifyInventory(before.rows, capture.nodes, capture.roots, before.total));
  capture.completeness.receivedNodeCount = capture.nodes.length;

  if (requested.length) {
    const ancestors = new Map<string, DesignNode>();
    const attempted = new Set<string>();
    let pending = [...new Set(capture.nodes.filter(node => capture.roots.includes(node.id)).map(node => node.raw.parentId).filter((id): id is string => typeof id === 'string' && !ids.has(id)))];
    while (pending.length) {
      const next = new Set<string>();
      await parallel(pending, concurrency, async id => {
        attempted.add(id);
        try {
          const result = await readChunks((offset, size) => nodeScript(id, offset, size));
          const data = JSON.parse(result.content);
          if (!data.raw || data.raw.id !== id || !Array.isArray(data.errors)) throw new Error('Ancestor serialization envelope is malformed');
          issues.push(...data.errors.map((error: string) => `Ancestor property unavailable: ${error}`));
          const ancestor = normalizeNode(data.raw);
          ancestors.set(id, ancestor); fingerprints.set(id, result.fingerprint);
          if (ancestor.parentId && !ids.has(ancestor.parentId)) next.add(ancestor.parentId);
        } catch (error) { issues.push(`Ancestor ${id}: ${message(error)}`); }
      });
      pending = [...next].filter(id => !attempted.has(id));
    }
    for (const root of capture.nodes.filter(node => capture.roots.includes(node.id))) {
      const chain = new Set([root.id]); let parentId = root.raw.parentId;
      while (typeof parentId === 'string') {
        if (chain.has(parentId)) { issues.push(`Ancestor cycle for selected root ${root.id}`); break; }
        chain.add(parentId); parentId = ancestors.get(parentId)?.parentId;
      }
    }
    capture.scope = { kind: 'selection', rootIds: [...capture.roots], ...(typeof config.scopeName === 'string' ? { name: config.scopeName } : {}), ancestors: [...ancestors.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  }

  const refs = collectReferences(capture.nodes.map(n => n.raw));
  const definitions: Raw = { components: {}, variables: {}, styles: {} };
  const referenceFingerprints = new Map<string, string>();
  const seenComponents = new Set<string>();
  // Component masters are dependencies, not additional screen nodes.
  while ([...refs.components].some(id => !seenComponents.has(id))) {
    const pending = [...refs.components].filter(id => !seenComponents.has(id));
    await parallel(pending, concurrency, async id => {
      seenComponents.add(id);
      try {
        const tree: Raw[] = []; const pendingIds = [id]; const seen = new Set<string>();
        while (pendingIds.length) {
          const nodeId = pendingIds.shift()!; if (seen.has(nodeId)) continue; seen.add(nodeId);
          const result = await readChunks((offset, size) => nodeScript(nodeId, offset, size));
          const data = JSON.parse(result.content);
          fingerprints.set(nodeId, result.fingerprint);
          if (data.errors?.length) issues.push(...data.errors.map((error: string) => `Component ${id}: ${error}`));
          tree.push(data.raw); collectReferences(data.raw, refs); pendingIds.push(...(data.raw.children ?? []));
        }
        definitions.components[id] = tree;
      } catch (error) { issues.push(`Unresolved component ${id}: ${message(error)}`); }
    });
  }
  for (const kind of ['styles', 'variables'] as const) {
    const visited = new Set<string>();
    while ([...refs[kind]].some(id => !visited.has(id))) {
      const pending = [...refs[kind]].filter(id => !visited.has(id));
      await parallel(pending, concurrency, async id => {
        visited.add(id);
        try {
          const result = await readChunks((offset, size) => referenceScript(kind === 'styles' ? 'style' : 'variable', id, offset, size));
          const data = JSON.parse(result.content);
          if (!data.raw || data.errors?.length) throw new Error(`Reference data unavailable: ${JSON.stringify(data.errors ?? [])}`);
          referenceFingerprints.set(`${kind}:${id}`, result.fingerprint);
          definitions[kind][id] = data.raw; collectReferences(data.raw, refs);
        } catch (error) { issues.push(`Unresolved ${kind} ${id}: ${message(error)}`); }
      });
    }
  }
  await writeFile(join(rawDir, 'references.json'), JSON.stringify(definitions, null, 2));
  for (const node of capture.nodes) {
    const own = collectReferences(node.raw);
    for (const id of own.styles) if (definitions.styles[id]) collectReferences(definitions.styles[id], own);
    const resolved = new Set<string>();
    while ([...own.variables].some(id => !resolved.has(id))) {
      for (const id of [...own.variables].filter(id => !resolved.has(id))) { resolved.add(id); if (definitions.variables[id]) collectReferences(definitions.variables[id], own); }
    }
    node.raw._resolvedReferences = {
      variables: Object.fromEntries([...own.variables].filter(id => definitions.variables[id]).map(id => [id, definitions.variables[id]])),
      styles: Object.fromEntries([...own.styles].filter(id => definitions.styles[id]).map(id => [id, definitions.styles[id]])),
    };
  }

  const mediaDir = join(rawDir, 'media'); await mkdir(mediaDir, { recursive: true });
  const exportMedia = async (id: string, format: 'PNG' | 'SVG' | 'ORIGINAL', nodeId?: string): Promise<Asset> => {
    const result = await readChunks((offset, size) => imageScript(id, format, offset, size));
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.content)) throw new Error('Invalid media base64');
    const bytes = Buffer.from(result.content, 'base64');
    if (!bytes.length) throw new Error('Empty exported media');
    const type = mediaType(bytes, format);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const path = join(mediaDir, `${sha256}.${type.extension}`); await writeFile(path, bytes);
    return { id, nodeId, path, mimeType: type.mime, sha256 };
  };
  await parallel([...refs.images], concurrency, async id => {
    try { capture.assets.push(await exportMedia(id, 'ORIGINAL')); }
    catch (error) { issues.push(`Missing image ${id}: ${message(error)}`); }
  });
  const vectorTypes = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON']);
  for (const node of capture.nodes) if (vectorTypes.has(node.type.toUpperCase())) refs.vectors.add(node.id);
  await parallel([...refs.vectors], concurrency, async id => {
    try { capture.assets.push(await exportMedia(id, 'SVG', ids.has(id) ? id : undefined)); }
    catch (error) { issues.push(`Missing vector ${id}: ${message(error)}`); }
  });
  const screens = screenshotNodes(capture.nodes, capture.roots);
  await parallel(screens, concurrency, async node => {
    try {
      const asset = await exportMedia(node.id, 'PNG', node.id);
      const { readFile } = await import('node:fs/promises');
      const png = PNG.sync.read(await readFile(asset.path));
      capture.screenshots.push({ nodeId: node.id, path: asset.path, width: png.width, height: png.height, scale: 1 });
    } catch (error) { issues.push(`Missing reference screenshot ${node.id}: ${message(error)}`); }
  });
  // Full tree DSL is supplemental: the Plugin API capture is independently verified below.
  if (connection.tools.some(t => t.name === 'get_node_dsl')) {
    await parallel(screens, concurrency, async node => {
      try { await connection.call('get_node_dsl', { guid: node.id, nodeId: node.id, simplify: false, file_key: config.fileKey, fileKey: config.fileKey }); }
      catch (error) { await writeFile(join(rawDir, `dsl-${safe(node.id)}-error.txt`), message(error)); }
    });
  }
  const after = await readInventory();
  if (JSON.stringify(before) !== JSON.stringify(after)) issues.push('Design inventory changed while capturing; take a new version');
  await parallel([...fingerprints.keys()], concurrency, async id => {
    try {
      const check = await invoke(nodeScript(id, 0, 0));
      if (check.fingerprint !== fingerprints.get(id)) issues.push(`Node ${id} changed while capturing; take a new version`);
    } catch (error) { issues.push(`Cannot verify final state of ${id}: ${message(error)}`); }
  });
  for (const kind of ['styles', 'variables'] as const) {
    await parallel(Object.keys(definitions[kind]), concurrency, async id => {
      try {
        const check = await invoke(referenceScript(kind === 'styles' ? 'style' : 'variable', id, 0, 0));
        if (check.fingerprint !== referenceFingerprints.get(`${kind}:${id}`)) issues.push(`${kind} ${id} changed while capturing`);
      } catch (error) { issues.push(`Cannot verify final ${kind} ${id}: ${message(error)}`); }
    });
  }
  capture.assets.sort((a, b) => a.id.localeCompare(b.id));
  capture.screenshots.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  capture.completeness.status = issues.length ? 'incomplete' : 'complete';
  await writeFile(join(rawDir, 'capture-evidence.json'), JSON.stringify({ method: 'plugin-api-independent-inventory-and-properties', inventoryBefore: before, inventoryAfter: after, fingerprints: Object.fromEntries(fingerprints), issues }, null, 2));
  return capture;
}

async function captureDslOnly(connection: PixsoConnection, config: PixsoConfig, capture: Capture): Promise<Capture> {
  const issues = capture.completeness.issues;
  issues.push('This Pixso MCP lacks eval_script: full DSL is retained, but independent node/property coverage and original image export are unverified. Use current local MCP or a complete export bundle.');
  if (!config.nodeIds?.length) { issues.push('Legacy MCP requires explicit pixso.nodeIds'); return capture; }
  const nodes = new Map<string, DesignNode>();
  for (const id of config.nodeIds) {
    try {
      const data = await connection.call('get_node_dsl', { guid: id, nodeId: id, simplify: false, file_key: config.fileKey, fileKey: config.fileKey });
      if (explicitTruncation(data)) issues.push(`Explicitly incomplete DSL response for ${id}`);
      for (const node of extractDslNodes(data)) nodes.set(node.id, node);
      capture.roots.push(id);
    } catch (error) { issues.push(`DSL ${id}: ${message(error)}`); }
  }
  capture.nodes = [...nodes.values()]; capture.completeness.receivedNodeCount = nodes.size;
  return capture;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Expected integer between ${min} and ${max}`);
  return Number(value);
}
async function parallel<T>(items: T[], count: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => { while (next < items.length) { const item = items[next++]!; await work(item); } }));
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function safe(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 20); }
function mediaType(bytes: Buffer, format: string): { mime: string; extension: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', extension: 'png' };
  if (bytes[0] === 255 && bytes[1] === 216) return { mime: 'image/jpeg', extension: 'jpg' };
  if (bytes.toString('ascii', 0, 6).startsWith('GIF8')) return { mime: 'image/gif', extension: 'gif' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', extension: 'webp' };
  if (/<svg[\s>]/i.test(bytes.toString('utf8', 0, Math.min(bytes.length, 1024)))) return { mime: 'image/svg+xml', extension: 'svg' };
  if (format === 'ORIGINAL') return { mime: 'application/octet-stream', extension: 'bin' };
  throw new Error(`Exported ${format} bytes have an unexpected format`);
}
