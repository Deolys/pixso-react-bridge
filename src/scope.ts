import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { absoluteAssets, assertCapture, descendants, loadSnapshot, saveSnapshot } from './artifacts.js';
import type { BridgeConfig, Capture, DesignNode } from './types.js';

export interface ScopeOptions { name?: string; changeNote?: string; previousSnapshot?: string }

/** Selection changes ownership only: original raw properties and document coordinates stay intact. */
export function selectCapture(capture: Capture, nodeIds: string[], options: Pick<ScopeOptions, 'name'> = {}): Capture {
  assertCapture(capture);
  if (!Array.isArray(nodeIds) || !nodeIds.length || nodeIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Select at least one nonempty Pixso node ID');
  const nodes = new Map(capture.nodes.map(node => [node.id, node]));
  const requested = [...new Set(nodeIds)];
  for (const id of requested) {
    const node = nodes.get(id);
    if (!node) throw new Error(`Selected Pixso node ${id} does not exist in this snapshot`);
    if (['DOCUMENT', 'PAGE', 'CANVAS', 'FOLDER', 'SECTION'].includes(node.type.toUpperCase())) throw new Error(`Select a frame, group, instance or another rendered node instead of ${node.type} ${id}`);
  }
  const requestedIds = new Set(requested);
  const roots = requested.filter(id => {
    let parentId = nodes.get(id)!.parentId;
    while (parentId) {
      if (requestedIds.has(parentId)) return false;
      parentId = nodes.get(parentId)!.parentId;
    }
    return true;
  });
  for (const id of roots) {
    if (!capture.screenshots.some(reference => reference.nodeId === id && reference.scale === 1)) {
      throw new Error(`Selected node ${id} has no independent PNG reference at scale 1. Recapture through Pixso MCP with nodeIds ${JSON.stringify(roots)} (CLI: capture --nodes ${JSON.stringify(roots.join(','))}), or import an exact selected-node PNG export. A crop of the host screen is not a standalone reference.`);
    }
  }
  const selected = new Set(roots.flatMap(id => descendants(id, nodes)));
  const context = new Map([...(capture.scope?.ancestors ?? []), ...capture.nodes].map(node => [node.id, node]));
  const ancestors = new Map<string, DesignNode>();
  for (const id of roots) {
    const visited = new Set([id]);
    let node = nodes.get(id)!;
    let parentId = originalParent(node, context);
    while (parentId) {
      if (visited.has(parentId)) throw new Error(`Cycle in ancestor context of selected node ${id}`);
      visited.add(parentId);
      const parent = context.get(parentId);
      if (!parent) throw new Error(`Ancestor context ${parentId} for selected node ${id} is missing. Recapture the selected node through Pixso MCP to retain its host context.`);
      if (!selected.has(parentId)) ancestors.set(parentId, parent);
      node = parent; parentId = originalParent(node, context);
    }
  }
  const result = structuredClone(capture);
  result.roots = roots;
  result.nodes = result.nodes.filter(node => selected.has(node.id));
  for (const node of result.nodes) if (roots.includes(node.id)) node.parentId = null;
  // Shared assets may be used through component overrides; they are resources, never host nodes.
  for (const asset of result.assets) if (asset.nodeId && !selected.has(asset.nodeId)) delete asset.nodeId;
  result.screenshots = result.screenshots.filter(reference => selected.has(reference.nodeId));
  result.scope = { kind: 'selection', rootIds: [...roots], ...(options.name ? { name: options.name } : {}), ancestors: structuredClone([...ancestors.values()]) };
  result.completeness = { status: 'complete', expectedNodeCount: result.nodes.length, receivedNodeCount: result.nodes.length, issues: [] };
  assertCapture(result);
  return result;
}

function originalParent(node: DesignNode, context: Map<string, DesignNode>): string | null {
  return typeof node.raw.parentId === 'string' ? node.raw.parentId : node.parentId ?? [...context.values()].find(parent => parent.children.includes(node.id))?.id ?? null;
}

export async function createScopedSnapshot(snapshot: string, nodeIds: string[], config: BridgeConfig, options: ScopeOptions = {}): Promise<string> {
  const source = path.resolve(snapshot);
  const { capture } = await loadSnapshot(source);
  const selected = selectCapture(absoluteAssets(capture, source), nodeIds, options);
  const raw = path.join(source, 'raw');
  let rawDir: string | undefined;
  try { if ((await lstat(raw)).isDirectory()) rawDir = raw; }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  return saveSnapshot(selected, config.artifactsDir, {
    baseDir: source, rawDir, maxNodesPerTask: config.generation.maxNodesPerTask, maxChunkBytes: config.generation.maxChunkBytes,
    changelog: { enabled: config.versioning?.screenChangelog, summary: options.changeNote, previousSnapshot: options.previousSnapshot },
  });
}
