import { hash } from './fs.js';
import { collectReferences } from './pixso/normalize.js';
import type { Asset, Capture, DesignNode, ScreenIndex, SnapshotManifest } from './types.js';

export interface ScreenChangelogOptions {
  capture: Capture;
  screens: ScreenIndex[];
  previous?: { capture: Capture; manifest: SnapshotManifest };
  createdAt: string;
  summary?: string;
}
export interface ScreenChangelog { relativePath: string; text: string }

type Category = 'layout' | 'style' | 'text' | 'structure' | 'assets' | 'other';
const labels: Record<Category, string> = { layout: 'геометрия', style: 'оформление', text: 'текст', structure: 'структура', assets: 'ресурсы', other: 'прочее' };

function fingerprint(value: unknown): string {
  return hash(JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) ?? 'undefined');
}

function safeLine(value: string, limit = 240): string {
  const chars = Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim());
  const bounded = chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join('');
  return bounded.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&');
}

function category(key: string): Category {
  if (/^(characters|textRuns|textSegments|styledTextSegments)$/.test(key)) return 'text';
  if (/^(id|name|type|parentId|children|component.*|variant.*|reactions)$/.test(key)) return 'structure';
  if (/^(x|y|width|height|rotation|relativeTransform|absoluteTransform|absoluteBoundingBox|absoluteRenderBounds|constraints|constrainProportions|layout.*|padding.*|itemSpacing|counterAxis.*|primaryAxis.*|(?:min|max)(?:Width|Height))$/.test(key)) return 'layout';
  if (/^(image.*|assetId|assetHash|vector.*|fillGeometry|strokeGeometry)$/.test(key)) return 'assets';
  if (/^(fills|backgrounds|strokes|stroke.*|fillStyleId|effects|effectStyleId|opacity|blendMode|visible|hidden|isMask|maskType|clipsContent|corner.*|.*Radius|font.*|text.*|lineHeight|letterSpacing|paragraph.*|boundVariables|.*VariableModes|_resolvedReferences)$/.test(key)) return 'style';
  return 'other';
}

function assetIndex(assets: Asset[]) {
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const byNode = new Map<string, string[]>();
  for (const asset of assets) if (asset.nodeId) byNode.set(asset.nodeId, [...(byNode.get(asset.nodeId) ?? []), asset.id]);
  return { byId, byNode };
}

function mediaFingerprint(node: DesignNode, assets: ReturnType<typeof assetIndex>): string {
  const refs = collectReferences(node.raw);
  const ids = new Set([...(assets.byNode.get(node.id) ?? []), ...refs.images, ...refs.vectors]);
  return fingerprint([...ids].sort().map(id => {
    const asset = assets.byId.get(id);
    return { id, sha256: asset?.sha256, mimeType: asset?.mimeType, ...(asset && !asset.sha256 ? { path: asset.path } : {}) };
  }));
}

function screenNodes(nodes: Map<string, DesignNode>, screen: ScreenIndex): Map<string, DesignNode> {
  return new Map(screen.nodeIds.map(id => {
    const node = nodes.get(id);
    if (!node) throw new Error(`Changelog screen ${screen.id} refers to missing node ${id}`);
    return [id, node];
  }));
}

/** One small file per screen; the caller writes it only into the new immutable version. */
export function buildScreenChangelogs(options: ScreenChangelogOptions): ScreenChangelog[] {
  const { capture, screens, previous, summary } = options;
  const date = new Date(options.createdAt);
  if (!Number.isFinite(date.getTime())) throw new Error('Changelog createdAt must be a valid date');
  const sameScope = previous && capture.source.fileKey === previous.capture.source.fileKey
    && fingerprint([...capture.roots].sort()) === fingerprint([...previous.capture.roots].sort());
  const currentAssets = assetIndex(capture.assets), previousAssets = assetIndex(previous?.capture.assets ?? []);
  const currentNodes = new Map(capture.nodes.map(node => [node.id, node]));
  const previousNodes = new Map(previous?.capture.nodes.map(node => [node.id, node]) ?? []);
  return screens.map(screen => {
    const lines = ['# Изменения экрана', `Дата: ${date.toISOString()}`, `Экран: ${safeLine(screen.name, 100)} (ID: ${safeLine(screen.id, 100)})`];
    const beforeScreen = sameScope ? previous!.manifest.screens.find(item => item.id === screen.id) : undefined;
    const after = screenNodes(currentNodes, screen);
    if (!beforeScreen) {
      lines.push('Начальная версия: сопоставимой предыдущей версии этого экрана и выборки нет.', `Узлов: ${after.size}.`);
    } else {
      const before = screenNodes(previousNodes, beforeScreen);
      const added = [...after.keys()].filter(id => !before.has(id)).length;
      const removed = [...before.keys()].filter(id => !after.has(id)).length;
      const counts: Record<Category, number> = { layout: 0, style: 0, text: 0, structure: added + removed, assets: 0, other: 0 };
      let edited = 0;
      for (const [id, node] of after) {
        const old = before.get(id); if (!old) continue;
        const changes = new Set<Category>();
        if (fingerprint(node.bounds) !== fingerprint(old.bounds)) changes.add('layout');
        if (fingerprint([node.name, node.type, node.parentId, node.children]) !== fingerprint([old.name, old.type, old.parentId, old.children])) changes.add('structure');
        for (const key of new Set([...Object.keys(node.raw), ...Object.keys(old.raw)])) if (fingerprint(node.raw[key]) !== fingerprint(old.raw[key])) changes.add(category(key));
        if (mediaFingerprint(node, currentAssets) !== mediaFingerprint(old, previousAssets)) changes.add('assets');
        if (changes.size) edited++;
        for (const change of changes) counts[change]++;
      }
      lines.push(`Предыдущая версия: ${safeLine(previous!.manifest.id, 100)}`);
      lines.push(added || removed || edited ? `Узлы: добавлено ${added}, удалено ${removed}, изменено ${edited}.` : 'Изменений узлов и их ресурсов не обнаружено.');
      const categories = (Object.keys(counts) as Category[]).filter(key => counts[key]).map(key => `${labels[key]} ${counts[key]}`);
      if (categories.length) lines.push(`Категории по узлам (могут пересекаться): ${categories.join('; ')}.`);
      const reference = capture.screenshots.find(item => item.nodeId === screen.id), oldReference = previous!.capture.screenshots.find(item => item.nodeId === screen.id);
      if (reference?.sha256 && oldReference?.sha256 && reference.sha256 !== oldReference.sha256) lines.push('Эталонный снимок изменён.');
    }
    if (summary?.trim()) lines.push(`Примечание: ${safeLine(summary)}`);
    return { relativePath: `${screen.path}/CHANGELOG.md`, text: lines.join('\n') + '\n' };
  });
}
