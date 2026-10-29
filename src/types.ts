// Unknown vendor properties remain intact in raw; only this boundary is open-ended.
export type Raw = Record<string, any>;
export interface Bounds { x: number; y: number; width: number; height: number }
export interface DesignNode {
  id: string; name: string; type: string; parentId: string | null;
  children: string[]; bounds?: Bounds; raw: Raw;
}
export interface Asset {
  id: string; nodeId?: string; path: string; mimeType: string; sha256?: string;
}
export interface ReferenceImage {
  nodeId: string; path: string; width: number; height: number; scale: number; sha256?: string;
}
export interface Capture {
  schemaVersion: 1;
  source: { provider: string; fileKey: string; name: string; revision?: string; capturedAt: string };
  roots: string[];
  nodes: DesignNode[];
  assets: Asset[];
  screenshots: ReferenceImage[];
  scope?: { kind: 'selection'; rootIds: string[]; name?: string; ancestors: DesignNode[] };
  completeness: { status: 'complete' | 'incomplete' | 'unverified'; expectedNodeCount?: number; receivedNodeCount: number; issues: string[] };
}
export interface ScreenIndex {
  id: string; name: string; pageId: string | null; path: string; nodeIds: string[];
  widgets: { id: string; nodeIds: string[]; path: string }[];
}
export interface SnapshotManifest {
  schemaVersion: 1; id: string; captureHash: string; source: Capture['source'];
  completeness: Capture['completeness']; roots: string[]; screens: ScreenIndex[];
  nodeCount: number; files: Record<string, string>;
}
export interface CommandSpec { command: string; args: string[]; env?: Record<string, string> }
export interface BridgeConfig {
  schemaVersion: 1; projectRoot: string; artifactsDir: string;
  pixso: {
    transport: 'stdio' | 'sse' | 'http'; command?: string; args?: string[]; url?: string;
    headersEnv?: Record<string, string>; fileKey?: string; nodeIds?: string[];
    [key: string]: unknown;
  };
  gigacode: CommandSpec & { concurrency: number; timeoutMs: number; retries: number };
  generation: { outputDir: string; cssFiles: string[]; componentFiles: string[]; designSystem?: { name: string; packageName?: string }; data?: { mockFiles?: string[]; setupFile?: string; instructions?: string }; maxNodesPerTask: number; maxChunkBytes: number };
  validation: { mode?: 'pixel-perfect' | 'tolerant'; url?: string; setupFile?: string; browserChannel?: 'chrome' | 'msedge'; executablePath?: string; maxPixelDiffRatio: number; geometryTolerancePx: number; commands: CommandSpec[] };
  versioning?: { screenChangelog: boolean };
}
