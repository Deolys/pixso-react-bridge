import type { Bounds, DesignNode, Raw } from '../types.js';

export function boundsOf(raw: Raw): Bounds | undefined {
  const b = raw.absoluteBoundingBox ?? raw.bounds ?? raw.box ?? raw;
  const values = { x: b.x, y: b.y, width: b.width ?? b.w, height: b.height ?? b.h };
  return Object.values(values).every(x => typeof x === 'number' && Number.isFinite(x)) ? values as Bounds : undefined;
}

export function normalizeNode(raw: Raw, ids?: Set<string>): DesignNode {
  const id = raw.id ?? raw.guid;
  if (typeof id !== 'string' || !id || typeof raw.type !== 'string') throw new Error('Unrecognized Pixso node shape: id/type required');
  if (raw.children !== undefined && !Array.isArray(raw.children)) throw new Error(`Node ${id}: children is not an array`);
  const children = (raw.children ?? []).map((n: unknown) => typeof n === 'string' ? n : (n as Raw)?.id ?? (n as Raw)?.guid);
  if (children.some((n: unknown) => typeof n !== 'string')) throw new Error(`Node ${id}: malformed child reference`);
  return { id, name: typeof raw.name === 'string' ? raw.name : id, type: raw.type, parentId: typeof raw.parentId === 'string' && (!ids || ids.has(raw.parentId)) ? raw.parentId : null, children, bounds: boundsOf(raw), raw };
}

export function extractDslNodes(data: unknown): DesignNode[] {
  const output: DesignNode[] = [];
  const seen = new Set<string>();
  function visit(value: unknown, parentId: string | null): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const child of value) visit(child, parentId); return; }
    const raw = value as Raw;
    if (typeof (raw.id ?? raw.guid) === 'string' && typeof raw.type === 'string') {
      const node = normalizeNode({ ...raw, parentId });
      if (seen.has(node.id)) throw new Error(`DSL repeats node ID ${node.id}`);
      seen.add(node.id); output.push(node);
      for (const child of raw.children ?? []) if (typeof child !== 'string') visit(child, node.id);
    } else {
      for (const key of ['roots', 'root', 'node', 'nodes', 'data', 'document']) if (raw[key]) visit(raw[key], parentId);
    }
  }
  visit(data, null);
  if (!output.length) throw new Error('Unknown full DSL response shape; retained raw data requires a version adapter');
  return output;
}

export interface References { components: Set<string>; variables: Set<string>; styles: Set<string>; images: Set<string>; vectors: Set<string> }
export function collectReferences(value: unknown, refs: References = { components: new Set(), variables: new Set(), styles: new Set(), images: new Set(), vectors: new Set() }): References {
  function visit(v: unknown, key = ''): void {
    if (typeof v === 'string') {
      if (!v) return;
      if (v.startsWith('variable:')) refs.variables.add(v.slice(9).split('$')[0]!);
      else if (v.startsWith('style:')) refs.styles.add(v.slice(6));
      else if (key === 'componentRef') refs.components.add(v);
      else if (/StyleId$/.test(key)) refs.styles.add(v);
      else if (['imageHash', 'imageRef', 'assetId', 'assetHash'].includes(key)) refs.images.add(v);
      else if (key === 'vectorRef') refs.vectors.add(v);
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const child of v) visit(child, key); return; }
    const obj = v as Raw;
    if (obj.type === 'VARIABLE_ALIAS' && typeof obj.id === 'string') refs.variables.add(obj.id);
    if (obj.type === 'asset' && typeof obj.id === 'string') refs.images.add(obj.id);
    for (const [k, child] of Object.entries(obj)) visit(child, k);
  }
  visit(value); return refs;
}

export function explicitTruncation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(explicitTruncation);
  for (const [key, child] of Object.entries(value)) {
    if (['truncated', 'isTruncated', 'hasMore', 'incomplete'].includes(key) && child === true) return true;
    if (['nextCursor', 'next_cursor'].includes(key) && child) return true;
    // Text content may legitimately contain the word truncated; never inspect ordinary strings.
    if (['stats', 'metadata', '_meta', 'pagination'].includes(key) && explicitTruncation(child)) return true;
  }
  return false;
}

export function verifyInventory(rows: Raw[], nodes: DesignNode[], roots: string[], expected: number): string[] {
  const issues: string[] = [];
  const rowMap = new Map(rows.map(n => [n.id, n]));
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  if (rows.length !== expected || rowMap.size !== expected) issues.push(`Inventory expected ${expected}, received ${rows.length} rows / ${rowMap.size} unique IDs`);
  if (nodes.length !== expected || nodeMap.size !== expected) issues.push(`Node coverage expected ${expected}, received ${nodes.length} nodes / ${nodeMap.size} unique IDs`);
  for (const [id, row] of rowMap) {
    const node = nodeMap.get(id);
    if (!node) { issues.push(`Missing node ${id}`); continue; }
    if (JSON.stringify(row.children) !== JSON.stringify(node.children)) issues.push(`Child order/coverage changed for ${id}`);
    if (row.parentId !== node.raw.parentId) issues.push(`Parent changed for ${id}`);
    for (const child of node.children) {
      if (!nodeMap.has(child)) issues.push(`Missing child ${child} referenced by ${id}`);
      else if (nodeMap.get(child)!.raw.parentId !== id) issues.push(`Parent/child mismatch ${id} -> ${child}`);
    }
  }
  const reached = new Set<string>(); const visiting = new Set<string>();
  function walk(id: string): void {
    if (visiting.has(id)) { issues.push(`Cycle at ${id}`); return; }
    if (reached.has(id)) return;
    reached.add(id); visiting.add(id);
    const node = nodeMap.get(id);
    if (!node) issues.push(`Missing root ${id}`);
    else for (const child of node.children) walk(child);
    visiting.delete(id);
  }
  for (const root of roots) walk(root);
  if (reached.size !== nodeMap.size) issues.push(`${nodeMap.size - reached.size} nodes are unreachable from roots`);
  return issues;
}

export function screenshotNodes(nodes: DesignNode[], roots: string[]): DesignNode[] {
  const map = new Map(nodes.map(n => [n.id, n])); const found = new Map<string, DesignNode>();
  const visit = (id: string) => {
    const node = map.get(id); if (!node) return;
    if (['DOCUMENT', 'PAGE', 'CANVAS', 'FOLDER', 'SECTION'].includes(node.type.toUpperCase())) for (const child of node.children) visit(child);
    else found.set(id, node);
  };
  for (const id of roots) visit(id);
  return [...found.values()];
}
