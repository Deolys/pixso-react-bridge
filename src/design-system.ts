import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { loadSnapshot } from './artifacts.js';
import { hash, inside, json, rejectSymlinkPath, writeJson } from './fs.js';
import { inspectProject, type ProjectProfile } from './project.js';
import type { BridgeConfig } from './types.js';

export interface ComponentEvidence { projectPath: string; sha256: string; exportName?: string; excerpt: string }
export interface ComponentDecision {
  nodeId: string; decision: 'native' | 'reuse' | 'adapt' | 'create' | 'unknown';
  required: string; available: string; reason: string; changes: string[]; evidence: ComponentEvidence[];
}
export interface ComponentPlanReference {
  schemaVersion: 1; status: 'compatible' | 'blocked'; planPath: string; gapsPath: string;
  planSha256: string; gapsSha256: string; blockingCount: number; decisionCount: number;
}
export interface ComponentAnalysis { screenId: string; widgetId: string; nodeIds: string[]; analysisFile: string }
interface Finding { screenId?: string; nodeId?: string; message: string }
interface SourceEvidence { projectPath: string; sha256: string }
export interface ComponentPlan {
  schemaVersion: 1; status: 'compatible' | 'blocked'; snapshot: string; captureHash: string;
  projectRoot: string; profilePath: string; profileSha256: string; profileHash: string;
  designSystem?: { name: string; packageName?: string }; expectedNodeIds: string[];
  decisions: (ComponentDecision & { screenId: string; screenName: string; widgetId: string })[];
  findings: Finding[]; sourceEvidence: SourceEvidence[]; analysisEvidence: { path: string; sha256: string }[];
  inferenceLimit: string;
}

const nonempty = (value: unknown, max = 4000): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const sameIds = (actual: string[], expected: string[]) => actual.length === expected.length && new Set(actual).size === actual.length && expected.every(id => actual.includes(id));
const normalized = (value: string) => value.replaceAll('\\', '/');

function parseDecision(value: any): ComponentDecision {
  if (!value || !nonempty(value.nodeId, 1024) || !['native', 'reuse', 'adapt', 'create', 'unknown'].includes(value.decision)) throw new Error('Invalid nodeId or component decision');
  for (const key of ['required', 'available', 'reason']) if (!nonempty(value[key])) throw new Error(`${value.nodeId}: ${key} must be nonempty and bounded`);
  if (!Array.isArray(value.changes) || value.changes.length > 32 || value.changes.some((v: unknown) => !nonempty(v, 2000))) throw new Error(`${value.nodeId}: invalid changes`);
  if (!Array.isArray(value.evidence) || value.evidence.length > 12) throw new Error(`${value.nodeId}: evidence must be a bounded array`);
  if (['adapt', 'create', 'unknown'].includes(value.decision) && !value.changes.length) throw new Error(`${value.nodeId}: blocking decision requires concrete changes`);
  if (['native', 'reuse'].includes(value.decision) && value.changes.length) throw new Error(`${value.nodeId}: compatible decision cannot hide required changes`);
  for (const evidence of value.evidence) {
    if (!evidence || !nonempty(evidence.projectPath, 2048) || !/^[a-f0-9]{64}$/.test(evidence.sha256) || !nonempty(evidence.excerpt, 4096) || (evidence.exportName !== undefined && !nonempty(evidence.exportName, 256))) throw new Error(`${value.nodeId}: malformed source/API evidence`);
  }
  return { nodeId: value.nodeId, decision: value.decision, required: value.required, available: value.available, reason: value.reason, changes: value.changes, evidence: value.evidence.map((e: ComponentEvidence) => ({ projectPath: normalized(e.projectPath), sha256: e.sha256, ...(e.exportName ? { exportName: e.exportName } : {}), excerpt: e.excerpt })) };
}

export const componentDecisionInstructions = `For EVERY assigned node ID write exactly one componentDecisions entry: {nodeId,decision:"native"|"reuse"|"adapt"|"create"|"unknown",required:string,available:string,reason:string,changes:string[],evidence:[{projectPath:string,sha256:string,exportName?:string,excerpt:string}]}. required describes the actual design requirement; available describes the exact available API/component or states none. Native is only for justified ordinary layout/text/HTML without a missing design-system component; known INSTANCE/COMPONENT nodes cannot be native. Reuse requires an existing inventoried source file, its exact SHA-256, actual exported symbol, and an exact source excerpt proving the relevant API; inspect component implementation, imported types and CSS. Include relevant extra source/CSS evidence. Available but incompatible API/variant/style means adapt; absent component means create; uncertainty means unknown. Each adapt/create/unknown must list concrete changes and rationale and blocks implementation. Never substitute a closest-looking component, silently approximate, call a missing Button native, or clear a gap just to obtain a passing report. native/reuse require empty changes. Evidence snippets are bounded to 4096 characters each and at most 12 per node. This is an explicit project-component compatibility decision, separate from visual pixel checks.`;

export async function buildComponentPlan(options: { snapshot: string; runDir: string; config: BridgeConfig; profileFile: string; analyses: ComponentAnalysis[] }): Promise<ComponentPlanReference> {
  const { snapshot, runDir, config, profileFile, analyses } = options;
  const { capture, manifest } = await loadSnapshot(snapshot);
  const profileBytes = await readFile(profileFile), profile: ProjectProfile = JSON.parse(profileBytes.toString('utf8'));
  const currentProfile = await inspectProject(config);
  const findings: Finding[] = [], sourceEvidence = new Map<string, string>(), analysisEvidence: ComponentPlan['analysisEvidence'] = [], decisions: ComponentPlan['decisions'] = [];
  const expectedNodeIds = [...new Set(manifest.screens.flatMap(s => s.nodeIds))];
  if (hash(JSON.stringify(profile)) !== hash(JSON.stringify(currentProfile))) findings.push({ message: 'Project source inventory changed after analysis planning; analyze again.' });
  if (profile.truncatedDiscovery) findings.push({ message: 'Component/CSS discovery was truncated; provide explicit complete componentFiles and cssFiles inventories.' });
  if (config.generation.designSystem?.packageName) {
    const packageName = config.generation.designSystem.packageName, packagePath = `node_modules/${packageName}/package.json`;
    try {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName)) throw new Error('Invalid design-system package name');
      const installed = await json<{ name?: string }>(inside(config.projectRoot, packagePath));
      if (installed.name !== packageName || !profile.metadata.some(entry => normalized(entry.path) === packagePath)) throw new Error('Installed package identity or inventory evidence does not match');
    } catch (error) { findings.push({ message: `Design-system package ${packageName} is not installed or verified: ${String(error)}` }); }
  }
  const nodes = new Map(capture.nodes.map(node => [node.id, node]));
  const components = new Set(profile.components.map(file => normalized(file.path)));
  async function readSource(relative: string, expectedHash?: string): Promise<string> {
    relative = normalized(relative);
    const filename = inside(config.projectRoot, relative); await rejectSymlinkPath(config.projectRoot, filename);
    if (!(await stat(filename)).isFile()) throw new Error(`Not a source file: ${relative}`);
    const content = await readFile(filename), sha256 = hash(content);
    if (expectedHash && sha256 !== expectedHash) throw new Error(`Source SHA-256 does not match: ${relative}`);
    sourceEvidence.set(relative, sha256); return content.toString('utf8');
  }
  for (const file of [...profile.components, ...profile.css, ...(profile.metadata ?? [])]) {
    try { await readSource(file.path, file.sha256); } catch (error) { findings.push({ message: String(error) }); }
  }
  const exportsCache = new Map<string, Set<string>>();
  async function exportsOf(relative: string): Promise<Set<string>> {
    const cached = exportsCache.get(relative); if (cached) return cached;
    const filename = inside(config.projectRoot, relative);
    const program = ts.createProgram([filename], { noEmit: true, allowJs: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true });
    const checker = program.getTypeChecker(), source = program.getSourceFile(filename);
    const symbol = source && checker.getSymbolAtLocation(source), exports = new Set<string>();
    if (symbol) for (const item of checker.getExportsOfModule(symbol)) {
      const actual = item.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(item) : item;
      if (actual.declarations?.length) exports.add(item.name);
    }
    // Local imports/re-exports and their types affect the claimed component API too.
    for (const file of program.getSourceFiles()) {
      const relativeFile = normalized(path.relative(config.projectRoot, file.fileName));
      if (!path.isAbsolute(relativeFile) && relativeFile !== '..' && !relativeFile.startsWith('../') && !file.fileName.includes(`${path.sep}node_modules${path.sep}typescript${path.sep}`)) await readSource(relativeFile);
    }
    exportsCache.set(relative, exports); return exports;
  }
  for (const analysis of analyses) {
    const screen = manifest.screens.find(s => s.id === analysis.screenId), widget = screen?.widgets.find(w => w.id === analysis.widgetId);
    if (!screen || !widget || !sameIds(analysis.nodeIds, widget.nodeIds)) { findings.push({ screenId: analysis.screenId, message: 'Analysis assignment is not an exact snapshot widget.' }); continue; }
    let data: any;
    try { const bytes = await readFile(analysis.analysisFile); analysisEvidence.push({ path: path.resolve(analysis.analysisFile), sha256: hash(bytes) }); data = JSON.parse(bytes.toString('utf8')); }
    catch (error) { findings.push({ screenId: screen.id, message: `Unreadable component analysis: ${String(error)}` }); continue; }
    if (!Array.isArray(data.reviewedNodeIds) || !sameIds(data.reviewedNodeIds, widget.nodeIds)) findings.push({ screenId: screen.id, message: 'Analysis reviewedNodeIds must cover exactly the assigned IDs.' });
    if (!Array.isArray(data.unresolved)) findings.push({ screenId: screen.id, message: 'Analysis unresolved must be an explicit array.' });
    else for (const issue of data.unresolved) findings.push({ screenId: screen.id, message: `Unresolved analysis finding: ${typeof issue === 'string' ? issue : JSON.stringify(issue)}` });
    if (!Array.isArray(data.componentDecisions) || !sameIds(data.componentDecisions.map((d: any) => d?.nodeId), widget.nodeIds)) {
      findings.push({ screenId: screen.id, message: `componentDecisions must cover every assigned ID exactly once (${analysis.widgetId}).` }); continue;
    }
    for (const raw of data.componentDecisions) {
      try {
        const decision = parseDecision(raw), node = nodes.get(decision.nodeId)!;
        decisions.push({ ...decision, screenId: screen.id, screenName: screen.name, widgetId: widget.id });
        if (decision.decision === 'native' && /^(INSTANCE|COMPONENT|COMPONENT_SET)$/i.test(node.type)) findings.push({ screenId: screen.id, nodeId: node.id, message: 'Known Pixso component/instance cannot silently use native HTML; explicit reuse/adapt/create/unknown is required.' });
        if (['adapt', 'create', 'unknown'].includes(decision.decision)) findings.push({ screenId: screen.id, nodeId: node.id, message: `${decision.decision}: ${decision.required}; ${decision.reason}` });
        let verifiedExport = false;
        for (const evidence of decision.evidence) {
          const text = await readSource(evidence.projectPath, evidence.sha256);
          if (!text.includes(evidence.excerpt)) throw new Error(`API/source excerpt is absent from ${evidence.projectPath}`);
          if (evidence.exportName) {
            if (!components.has(evidence.projectPath)) throw new Error(`Component source is outside the declared inventory: ${evidence.projectPath}`);
            if (!(await exportsOf(evidence.projectPath)).has(evidence.exportName)) throw new Error(`Export ${evidence.exportName} does not exist in ${evidence.projectPath}`);
            verifiedExport = true;
          }
        }
        if (decision.decision === 'reuse' && !verifiedExport) throw new Error('Reuse requires a verified inventoried component export and source/API evidence');
      } catch (error) { findings.push({ screenId: screen.id, nodeId: nonempty(raw?.nodeId, 1024) ? raw.nodeId : undefined, message: String(error) }); }
    }
  }
  if (!sameIds(decisions.map(d => d.nodeId), expectedNodeIds)) findings.push({ message: 'Validated component decisions do not exactly cover all screen node IDs.' });
  const report: ComponentPlan = {
    schemaVersion: 1, status: findings.length ? 'blocked' : 'compatible', snapshot: path.resolve(snapshot), captureHash: manifest.captureHash,
    projectRoot: path.resolve(config.projectRoot), profilePath: path.resolve(profileFile), profileSha256: hash(profileBytes), profileHash: hash(JSON.stringify(profile)),
    ...(config.generation.designSystem ? { designSystem: config.generation.designSystem } : {}), expectedNodeIds, decisions, findings,
    sourceEvidence: [...sourceEvidence].map(([projectPath, sha256]) => ({ projectPath, sha256 })), analysisEvidence,
    inferenceLimit: 'Source hashes, exports, inventory and decision coverage are checked mechanically. Semantic API/visual suitability remains an explicit AI judgment and must pass implementation and visual acceptance.',
  };
  const planPath = path.join(runDir, 'component-plan.json'), gapsPath = path.join(runDir, 'component-gaps.md');
  await writeJson(planPath, report);
  const lines = ['# Соответствие компонентов проекта макету', '', `Статус: ${report.status === 'compatible' ? 'компоненты согласованы' : 'перенос заблокирован до доработки компонентов'}.`, `Дизайн-система: ${report.designSystem?.name ?? 'компоненты текущего проекта'}.`, '', 'Каждый узел требует явного решения. Близкий внешний вид не разрешает подмену отсутствующего API или варианта.', ''];
  for (const finding of findings) {
    const decision = decisions.find(d => d.nodeId === finding.nodeId), screen = manifest.screens.find(s => s.id === finding.screenId);
    lines.push(`## ${screen?.name ?? 'Проект'}${finding.nodeId ? ` — узел ${finding.nodeId}` : ''}`, '', `Причина: ${finding.message}`, `Требуется: ${decision?.required ?? 'полная проверенная инвентаризация и решения для всех узлов'}.`, `Доступно: ${decision?.available ?? 'не подтверждено'}.`, `Исходники: ${decision?.evidence.map(e => e.projectPath).join(', ') || 'нет подтверждённых исходников'}.`, `Изменения: ${decision?.changes.join('; ') || 'устранить указанную неопределённость и повторить анализ'}.`, '', 'Задание для ИИ:', '', `> В проекте ${config.projectRoot} проверь узел ${finding.nodeId ?? 'указанный в отчёте'} экрана ${screen?.name ?? 'всех экранов'} по версии ${snapshot}. Требование: ${decision?.required ?? finding.message}. Доступно: ${decision?.available ?? 'не подтверждено'}. ${decision?.changes.join('; ') || 'Дополнить инвентаризацию компонентов и дать проверенное решение'}. Прочитай реальные API и CSS, добавь или адаптируй компонент и необходимые варианты по паттернам проекта; сохрани обычные CSS-классы. Не заменяй ближайшим по виду компонентом и не скрывай разрыв. После доработки запусти новый анализ, затем полный transfer и визуальную проверку.`, '');
  }
  if (!findings.length) lines.push('Блокирующих разрывов не обнаружено. Это не доказательство визуального совпадения: обязательны дальнейшие проверки кода и всех экранов.', '');
  lines.push('Граница проверки: наличие файлов, хеши, экспорты и покрытие узлов проверены автоматически; смысловая совместимость API и внешнего вида остаётся решением ИИ и проверяется при реализации.', '');
  await writeFile(gapsPath, lines.join('\n'), 'utf8');
  return { schemaVersion: 1, status: report.status, planPath, gapsPath, planSha256: hash(await readFile(planPath)), gapsSha256: hash(await readFile(gapsPath)), blockingCount: findings.length, decisionCount: decisions.length };
}

export async function verifyComponentPlan(reference: ComponentPlanReference, config: BridgeConfig, expectedNodeIds?: string[], expectedCaptureHash?: string): Promise<ComponentPlan> {
  if (!reference || reference.schemaVersion !== 1 || reference.status !== 'compatible' || reference.blockingCount !== 0) throw new Error('Missing or blocked design-system component plan');
  for (const [filename, expectedHash] of [[reference.planPath, reference.planSha256], [reference.gapsPath, reference.gapsSha256]]) {
    await rejectSymlinkPath(path.resolve(config.artifactsDir), path.resolve(filename));
    if (hash(await readFile(filename)) !== expectedHash) throw new Error('Design-system report changed after analysis');
  }
  const report = await json<ComponentPlan>(reference.planPath);
  if (report.schemaVersion !== 1 || report.status !== 'compatible' || report.findings.length || path.resolve(report.projectRoot) !== path.resolve(config.projectRoot)) throw new Error('Invalid design-system report');
  if (expectedCaptureHash && report.captureHash !== expectedCaptureHash) throw new Error('Design-system report belongs to a different capture');
  if (!sameIds(report.decisions.map(d => d.nodeId), expectedNodeIds ?? report.expectedNodeIds) || report.decisions.length !== reference.decisionCount) throw new Error('Design-system report node coverage mismatch');
  for (const decision of report.decisions) if (!['native', 'reuse'].includes(parseDecision(decision).decision)) throw new Error('Blocking component decision cannot be accepted');
  if (hash(await readFile(report.profilePath)) !== report.profileSha256) throw new Error('Project profile changed after component analysis');
  const currentProfile = await inspectProject(config);
  if (currentProfile.truncatedDiscovery || hash(JSON.stringify(currentProfile)) !== report.profileHash) throw new Error('Project component/CSS inventory changed; repeat component analysis');
  for (const source of report.sourceEvidence) {
    const filename = inside(config.projectRoot, source.projectPath); await rejectSymlinkPath(config.projectRoot, filename);
    if (hash(await readFile(filename)) !== source.sha256) throw new Error(`Component source changed: ${source.projectPath}`);
  }
  for (const analysis of report.analysisEvidence) if (hash(await readFile(analysis.path)) !== analysis.sha256) throw new Error('Component analysis evidence changed');
  return report;
}
