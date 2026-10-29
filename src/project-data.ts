import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { loadSnapshot } from './artifacts.js';
import { hash, inside, json, rejectSymlinkPath, writeJson } from './fs.js';
import { inspectProject, type ProjectProfile } from './project.js';
import type { ComponentAnalysis } from './design-system.js';
import type { BridgeConfig } from './types.js';

export interface DataBinding {
  nodeId: string; kind: 'none' | 'static' | 'dynamic' | 'unknown'; reason: string; changes: string[];
  binding?: {
    delivery: 'props' | 'hook' | 'context'; expression: string;
    source: { projectPath: string; sha256: string; excerpt: string; exportName?: string };
    fixturePath: string; fixtureSha256: string; fixtureExcerpt: string;
  };
}
export interface DataPlanReference {
  schemaVersion: 1; status: 'compatible' | 'blocked'; planPath: string; gapsPath: string;
  planSha256: string; gapsSha256: string; blockingCount: number; bindingCount: number;
}
interface Finding { nodeId?: string; screenId?: string; message: string }
export interface DataPlan {
  schemaVersion: 1; status: 'compatible' | 'blocked'; snapshot: string; captureHash: string; projectRoot: string;
  profilePath: string; profileSha256: string; profileHash: string; expectedNodeIds: string[];
  bindings: (DataBinding & { screenId: string; screenName: string; widgetId: string; designText?: string; visible: boolean })[];
  sourceEvidence: { projectPath: string; sha256: string }[]; analysisEvidence: { path: string; sha256: string }[];
  findings: Finding[]; fixtureFiles: string[]; setupFile?: string; inferenceLimit: string;
}

const nonempty = (value: unknown, max = 4000): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const normalizePath = (value: string) => value.replaceAll('\\', '/');
const sameIds = (actual: unknown[], expected: string[]) => actual.length === expected.length && new Set(actual).size === actual.length && expected.every(id => actual.includes(id));
const memberExpression = /^[A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*|\[\d+\])*$/;

function parseBinding(value: any): DataBinding {
  if (!value || !nonempty(value.nodeId, 1024) || !['none', 'static', 'dynamic', 'unknown'].includes(value.kind) || !nonempty(value.reason)) throw new Error('Each node needs a valid explicit data classification and reason');
  if (!Array.isArray(value.changes) || value.changes.length > 24 || value.changes.some((item: unknown) => !nonempty(item, 2000))) throw new Error(`${value.nodeId}: changes must be a bounded array`);
  if (value.kind === 'unknown' && !value.changes.length) throw new Error(`${value.nodeId}: unknown data requires an actionable change`);
  if (value.kind !== 'unknown' && value.changes.length) throw new Error(`${value.nodeId}: unresolved data changes cannot be hidden by a compatible classification`);
  if (value.kind !== 'dynamic') {
    if (value.binding !== undefined) throw new Error(`${value.nodeId}: only dynamic data may have a binding`);
    return { nodeId: value.nodeId, kind: value.kind, reason: value.reason, changes: value.changes };
  }
  const binding = value.binding, source = binding?.source;
  if (!binding || !['props', 'hook', 'context'].includes(binding.delivery) || !nonempty(binding.expression, 512) || !memberExpression.test(binding.expression)) throw new Error(`${value.nodeId}: dynamic data needs a simple props/hook/context member expression, not a literal or fallback`);
  if (!source || !nonempty(source.projectPath, 2048) || !/^[a-f0-9]{64}$/.test(source.sha256) || !nonempty(source.excerpt, 4096) || (source.exportName !== undefined && !nonempty(source.exportName, 256))) throw new Error(`${value.nodeId}: dynamic source/API evidence is missing or malformed`);
  if (!nonempty(binding.fixturePath, 2048) || !/^[a-f0-9]{64}$/.test(binding.fixtureSha256) || !nonempty(binding.fixtureExcerpt, 4096)) throw new Error(`${value.nodeId}: an existing project fixture/scenario with exact source evidence is required`);
  return { nodeId: value.nodeId, kind: value.kind, reason: value.reason, changes: value.changes, binding: { delivery: binding.delivery, expression: binding.expression, source: { projectPath: normalizePath(source.projectPath), sha256: source.sha256, excerpt: source.excerpt, ...(source.exportName ? { exportName: source.exportName } : {}) }, fixturePath: normalizePath(binding.fixturePath), fixtureSha256: binding.fixtureSha256, fixtureExcerpt: binding.fixtureExcerpt } };
}

export const dataBindingInstructions = `For EVERY assigned node add exactly one dataBindings entry to analysis.json: {nodeId,kind:"none"|"static"|"dynamic"|"unknown",reason:string,changes:string[],binding?:{delivery:"props"|"hook"|"context",expression:string,source:{projectPath:string,sha256:string,excerpt:string,exportName?:string},fixturePath:string,fixtureSha256:string,fixtureExcerpt:string}}. none means no textual data; static means a stable UI label/instruction, never a business/example value disguised as a label. Customer names, amounts, dates, counts, repeated rows/cards, statuses from records and other design example values are dynamic. Inspect project-profile.data, actual MSW/Mirage/json-server handlers, fixtures, factories, Storybook or custom mechanisms; use configured instructions. Dynamic values must come through actual project props/data hooks/context; expression is a simple identifier/member path such as props.summary.total or summary.total. Source/API and fixture excerpts must be exact, nonempty, at most 4096 characters, and SHA-256 must match real files. fixturePath must be an inventoried existing project mock/scenario; example values belong in that fixture, not views. If no existing fixture/scenario, API adapter or setup supports the design, kind unknown with concrete changes blocks generation: instruct adding the scenario through EXISTING project tooling, never invent a library or scatter literals in JSX. Dynamic preview requires configured validation.setupFile, and an external validation.url cannot substitute for initialization of the installed-code preview. Setup may export async preparePixsoPreview({screenId}) returning {props?,Provider?}; harness renders real View with props and optionally wraps it with Provider. Never import fixture/handler/setup modules into production views. Static UI labels, style numbers and original image assets remain normal. changes is empty for compatible classifications. Classification/API suitability is explicit model inference, not mathematical proof.`;

export async function buildDataPlan(options: { snapshot: string; runDir: string; config: BridgeConfig; profileFile: string; analyses: ComponentAnalysis[] }): Promise<DataPlanReference> {
  const { snapshot, runDir, config, profileFile, analyses } = options;
  const { capture, manifest } = await loadSnapshot(snapshot), profileBytes = await readFile(profileFile), profile: ProjectProfile = JSON.parse(profileBytes.toString('utf8'));
  const findings: Finding[] = [], bindings: DataPlan['bindings'] = [], analysisEvidence: DataPlan['analysisEvidence'] = [], sources = new Map<string, string>();
  const currentProfile = await inspectProject(config), expectedNodeIds = [...new Set(manifest.screens.flatMap(screen => screen.nodeIds))];
  if (hash(JSON.stringify(currentProfile)) !== hash(JSON.stringify(profile))) findings.push({ message: 'Project data source inventory changed after planning; repeat analysis.' });
  if (!profile.data || profile.data.truncatedDiscovery) findings.push({ message: 'Project data discovery is missing or truncated; provide a complete generation.data.mockFiles inventory.' });
  for (const message of profile.data?.issues ?? []) findings.push({ message });
  const nodes = new Map(capture.nodes.map(node => [node.id, node])), fixtures = new Set((profile.data?.files ?? []).map(file => normalizePath(file.path)));
  const setupFile = config.validation.setupFile;
  async function source(relative: string, expectedHash?: string, excerpt?: string) {
    const filename = inside(config.projectRoot, relative); await rejectSymlinkPath(config.projectRoot, filename);
    const bytes = await readFile(filename), digest = hash(bytes), text = bytes.toString('utf8');
    if (expectedHash && digest !== expectedHash) throw new Error(`Data source SHA-256 mismatch: ${relative}`);
    if (excerpt !== undefined && !text.includes(excerpt)) throw new Error(`Data source/API excerpt does not exist: ${relative}`);
    sources.set(normalizePath(relative), digest); return text;
  }
  for (const file of [...(profile.data?.files ?? []), ...profile.metadata]) {
    try { await source(file.path, file.sha256); } catch (error) { findings.push({ message: String(error) }); }
  }
  for (const analysis of analyses) {
    const screen = manifest.screens.find(item => item.id === analysis.screenId), widget = screen?.widgets.find(item => item.id === analysis.widgetId);
    if (!screen || !widget || !sameIds(analysis.nodeIds, widget.nodeIds)) { findings.push({ screenId: analysis.screenId, message: 'Invalid data-analysis widget assignment' }); continue; }
    let data: any;
    try { const bytes = await readFile(analysis.analysisFile); analysisEvidence.push({ path: path.resolve(analysis.analysisFile), sha256: hash(bytes) }); data = JSON.parse(bytes.toString('utf8')); }
    catch (error) { findings.push({ screenId: screen.id, message: `Unreadable data analysis: ${String(error)}` }); continue; }
    if (!Array.isArray(data.dataBindings) || !sameIds(data.dataBindings.map((item: any) => item?.nodeId), widget.nodeIds)) { findings.push({ screenId: screen.id, message: 'dataBindings must cover every assigned node exactly once.' }); continue; }
    for (const raw of data.dataBindings) {
      try {
        const decision = parseBinding(raw), node = nodes.get(decision.nodeId)!;
        const designText = typeof node.raw.characters === 'string' ? node.raw.characters : undefined;
        let visible = node.raw.visible !== false, ancestor = node.parentId ? nodes.get(node.parentId) : undefined;
        while (ancestor) { visible &&= ancestor.raw.visible !== false; ancestor = ancestor.parentId ? nodes.get(ancestor.parentId) : undefined; }
        bindings.push({ ...decision, screenId: screen.id, screenName: screen.name, widgetId: widget.id, ...(decision.kind === 'dynamic' && designText !== undefined ? { designText } : {}), visible });
        if (decision.kind === 'none' && designText?.trim()) throw new Error('Textual design value cannot be omitted as kind none');
        if (decision.kind === 'unknown') { findings.push({ screenId: screen.id, nodeId: node.id, message: `Data scenario/API/setup needs work: ${decision.reason}; ${decision.changes.join('; ')}` }); continue; }
        if (decision.kind !== 'dynamic') continue;
        if (!designText?.trim()) throw new Error('Dynamic binding currently requires captured textual data; classify unsupported non-text business data as unknown');
        const binding = decision.binding!;
        if (!fixtures.has(binding.fixturePath)) throw new Error(`Fixture is outside the project data inventory: ${binding.fixturePath}`);
        await source(binding.fixturePath, binding.fixtureSha256, binding.fixtureExcerpt);
        await source(binding.source.projectPath, binding.source.sha256, binding.source.excerpt);
        if (binding.source.exportName) {
          const program = ts.createProgram([inside(config.projectRoot, binding.source.projectPath)], { noEmit: true, allowJs: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true });
          const checker = program.getTypeChecker(), file = program.getSourceFile(inside(config.projectRoot, binding.source.projectPath)), symbol = file && checker.getSymbolAtLocation(file);
          if (!symbol || !checker.getExportsOfModule(symbol).some(item => item.name === binding.source.exportName && (item.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(item) : item).declarations?.length)) throw new Error(`Data API export does not exist: ${binding.source.exportName}`);
          for (const dependency of program.getSourceFiles()) {
            const relative = normalizePath(path.relative(config.projectRoot, dependency.fileName));
            if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('../')) await source(relative);
          }
        }
        if (fixtures.has(binding.source.projectPath) && binding.delivery !== 'props') throw new Error('Production data hooks/context cannot directly use the fixture/setup module as their runtime API');
        if (!setupFile) throw new Error('Dynamic project data requires existing preview setup; create it through project tooling first');
      } catch (error) { findings.push({ screenId: screen.id, nodeId: nonempty(raw?.nodeId, 1024) ? raw.nodeId : undefined, message: String(error) }); }
    }
  }
  if (!sameIds(bindings.map(binding => binding.nodeId), expectedNodeIds)) findings.push({ message: 'Data classifications do not exactly cover all screen node IDs.' });
  const report: DataPlan = { schemaVersion: 1, status: findings.length ? 'blocked' : 'compatible', snapshot: path.resolve(snapshot), captureHash: manifest.captureHash, projectRoot: path.resolve(config.projectRoot), profilePath: path.resolve(profileFile), profileSha256: hash(profileBytes), profileHash: hash(JSON.stringify(profile)), expectedNodeIds, bindings, sourceEvidence: [...sources].map(([projectPath, sha256]) => ({ projectPath, sha256 })), analysisEvidence, findings, fixtureFiles: [...fixtures], ...(setupFile ? { setupFile: normalizePath(setupFile) } : {}), inferenceLimit: 'Files, hashes, declared exports, exact classification coverage, mapped JSX expressions and literals for declared dynamic text are checked mechanically. Static-vs-business classification and semantic scenario/API suitability remain model judgments. New scenarios must first be created through existing project tooling. Non-text dynamic fields need an explicit supported adapter and currently block.' };
  const planPath = path.join(runDir, 'data-plan.json'), gapsPath = path.join(runDir, 'data-gaps.md'); await writeJson(planPath, report);
  const lines = ['# Данные макета и моки проекта', '', `Статус: ${report.status === 'compatible' ? 'сопоставление данных согласовано' : 'перенос заблокирован до подключения данных проекта'}.`, `Механизмы: ${profile.data?.mechanisms.join(', ') || 'не обнаружены'}.`, '', 'Подписи интерфейса остаются статическими. Бизнес-значения должны поступать через props, hooks или context; демонстрационные значения хранятся в штатных фикстурах проекта.', ''];
  for (const finding of findings) {
    const decision = bindings.find(item => item.nodeId === finding.nodeId), screen = manifest.screens.find(item => item.id === finding.screenId);
    lines.push(`## ${screen?.name ?? 'Проект'}${finding.nodeId ? ` — узел ${finding.nodeId}` : ''}`, '', `Причина: ${finding.message}`, `Источник: ${decision?.binding?.source.projectPath ?? 'не подтверждён'}.`, `Фикстура: ${decision?.binding?.fixturePath ?? 'нужна штатная фикстура/сценарий'}.`, `Изменения: ${decision?.changes.join('; ') || 'проверить схему, сценарий и подключение mock-окружения'}.`, '', 'Задание для ИИ:', '', `> В проекте ${config.projectRoot} изучи существующие ${profile.data?.mechanisms.join(', ') || 'моки, фикстуры, фабрики и data hooks'} и узел ${finding.nodeId ?? 'из отчёта'} экрана ${screen?.name ?? 'проекта'} по версии ${snapshot}. ${finding.message}. ${decision?.changes.join('; ') ?? ''} Создай или адаптируй сценарий штатными средствами проекта и передай значения через реальный API/props/context. Подключи существующее preview-окружение через validation.setupFile (preparePixsoPreview возвращает props и необязательный Provider). Не добавляй новую библиотеку, не переноси бизнес-значения в JSX и не включай preview-моки в production views. Затем повтори анализ и полный transfer с визуальной проверкой.`, '');
  }
  if (!findings.length) lines.push('Блокирующих разрывов не обнаружено. Реализация обязана сохранить согласованные выражения и пройти проверку исходников и всех экранов.', '');
  lines.push('Граница проверки: классификация статических и бизнес-данных остаётся явным решением ИИ. Автоматическая AST-проверка контролирует заявленные динамические текстовые значения; неизвестные сценарии и динамические нетекстовые поля требуют доработки.', '');
  await writeFile(gapsPath, lines.join('\n'), 'utf8');
  return { schemaVersion: 1, status: report.status, planPath, gapsPath, planSha256: hash(await readFile(planPath)), gapsSha256: hash(await readFile(gapsPath)), blockingCount: findings.length, bindingCount: bindings.length };
}

export async function verifyDataPlan(reference: DataPlanReference, config: BridgeConfig, expectedNodeIds?: string[], expectedCaptureHash?: string): Promise<DataPlan> {
  if (!reference || reference.schemaVersion !== 1 || reference.status !== 'compatible' || reference.blockingCount !== 0) throw new Error('Missing or blocked project-data plan');
  for (const [filename, digest] of [[reference.planPath, reference.planSha256], [reference.gapsPath, reference.gapsSha256]]) {
    await rejectSymlinkPath(path.resolve(config.artifactsDir), path.resolve(filename));
    if (hash(await readFile(filename)) !== digest) throw new Error('Project-data report changed after analysis');
  }
  const report = await json<DataPlan>(reference.planPath);
  if (report.schemaVersion !== 1 || report.status !== 'compatible' || report.findings.length || path.resolve(report.projectRoot) !== path.resolve(config.projectRoot)) throw new Error('Invalid project-data report');
  if (expectedCaptureHash && report.captureHash !== expectedCaptureHash) throw new Error('Project-data report belongs to a different capture');
  if (!sameIds(report.bindings.map(item => item.nodeId), expectedNodeIds ?? report.expectedNodeIds) || report.bindings.length !== reference.bindingCount) throw new Error('Project-data report node coverage mismatch');
  for (const binding of report.bindings) if (parseBinding(binding).kind === 'unknown') throw new Error('Unknown data binding cannot be accepted');
  if (hash(await readFile(report.profilePath)) !== report.profileSha256) throw new Error('Project profile changed after data analysis');
  const current = await inspectProject(config);
  if (current.data.truncatedDiscovery || hash(JSON.stringify(current)) !== report.profileHash) throw new Error('Project data inventory changed; repeat data analysis');
  for (const evidence of report.sourceEvidence) {
    const filename = inside(config.projectRoot, evidence.projectPath); await rejectSymlinkPath(config.projectRoot, filename);
    if (hash(await readFile(filename)) !== evidence.sha256) throw new Error(`Project data source changed: ${evidence.projectPath}`);
  }
  for (const evidence of report.analysisEvidence) if (hash(await readFile(evidence.path)) !== evidence.sha256) throw new Error('Data analysis evidence changed');
  return report;
}

export async function blockDataPlan(reference: DataPlanReference, messages: string[]): Promise<DataPlanReference> {
  const report = await json<DataPlan>(reference.planPath); report.status = 'blocked';
  report.findings.push(...messages.map(message => ({ message: `Implementation data contract: ${message}` })));
  await writeJson(reference.planPath, report);
  const previous = await readFile(reference.gapsPath, 'utf8');
  await writeFile(reference.gapsPath, previous + '\n## Реализация нарушила согласованную схему данных\n\n' + messages.map(message => `- ${message}`).join('\n') + '\n\nЗадание для ИИ: исправь указанные узлы по data-plan.json. Убери бизнес-литералы из JSX, восстанови согласованные props/hooks/context и точный coverage.dataBindings. Значения сценария оставь в штатных фикстурах проекта; preview-моки не импортируй в production views. Повтори анализ и transfer.\n', 'utf8');
  return { ...reference, status: 'blocked', blockingCount: report.findings.length, planSha256: hash(await readFile(reference.planPath)), gapsSha256: hash(await readFile(reference.gapsPath)) };
}

function jsxId(node: ts.JsxElement | ts.JsxSelfClosingElement): string | undefined {
  const attributes = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
  const attribute = attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText() === 'data-pixso-id');
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer) return undefined;
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  return ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression && ts.isStringLiteral(attribute.initializer.expression) ? attribute.initializer.expression.text : undefined;
}
function bindingNames(name: ts.BindingName): string[] { return ts.isIdentifier(name) ? [name.text] : name.elements.flatMap(item => ts.isBindingElement(item) ? bindingNames(item.name) : []); }
const compact = (value: string) => value.replace(/\s+/g, '');

export async function validateDataImplementation(report: DataPlan, outputDir: string, expectedNodeIds: string[]): Promise<void> {
  const coverage = await json<any>(path.join(outputDir, 'coverage.json')), expected = report.bindings.filter(item => expectedNodeIds.includes(item.nodeId));
  if (!Array.isArray(coverage.dataBindings) || !sameIds(coverage.dataBindings.map((item: any) => item?.nodeId), expectedNodeIds)) throw new Error('Implementation dataBindings must exactly cover the assigned IDs');
  for (const decision of expected) {
    const actual = coverage.dataBindings.find((item: any) => item.nodeId === decision.nodeId);
    if (actual.kind !== decision.kind || (decision.kind === 'dynamic' && actual.expression !== decision.binding!.expression) || (decision.kind !== 'dynamic' && actual.expression !== undefined)) throw new Error(`Implementation changed approved data binding: ${decision.nodeId}`);
  }
  const files: { filename: string; source: ts.SourceFile }[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Generated data source contains a symlink');
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (/\.[jt]sx?$/.test(entry.name)) files.push({ filename, source: ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true, filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) });
    }
  }
  await visit(outputDir);
  const fixtureFiles = new Set(report.fixtureFiles.map(file => path.resolve(report.projectRoot, file)));
  function importProjectPath(specifier: string, filename: string): string | undefined {
    const mapped = (coverage.imports ?? []).find((item: any) => item.specifier === specifier)?.projectPath;
    if (typeof mapped === 'string') return path.resolve(report.projectRoot, mapped);
    if (specifier.startsWith('.')) {
      const absolute = path.resolve(path.dirname(filename), specifier);
      const match = report.sourceEvidence.find(item => path.resolve(report.projectRoot, item.projectPath).replace(/\.[cm]?[jt]sx?$/, '') === absolute.replace(/\.[cm]?[jt]sx?$/, ''));
      if (match) return path.resolve(report.projectRoot, match.projectPath);
    }
    return undefined;
  }
  for (const file of files) for (const statement of file.source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
    const target = importProjectPath(statement.moduleSpecifier.text, file.filename);
    if (target && fixtureFiles.has(target)) throw new Error(`Preview fixture/setup must not be imported into production view: ${statement.moduleSpecifier.text}`);
  }
  for (const decision of expected.filter(item => item.kind === 'dynamic' && item.visible)) {
    const binding = decision.binding!, candidates: { element: ts.JsxElement | ts.JsxSelfClosingElement; filename: string; source: ts.SourceFile }[] = [];
    for (const file of files) {
      function walk(node: ts.Node) { if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && jsxId(node) === decision.nodeId) candidates.push({ element: node, ...file }); ts.forEachChild(node, walk); }
      walk(file.source);
    }
    if (!candidates.length) throw new Error(`Dynamic node has no inspectable JSX element: ${decision.nodeId}`);
    for (const candidate of candidates) {
      let expressionFound = false;
      function inspect(node: ts.Node) {
        if (node !== candidate.element && (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && jsxId(node) && jsxId(node) !== decision.nodeId) return;
        if (ts.isJsxAttribute(node) && ['style', 'className', 'data-pixso-id'].includes(node.name.getText())) return;
        if (ts.isJsxExpression(node) && node.expression && compact(node.expression.getText()) === compact(binding.expression)) {
          const attribute = ts.isJsxAttribute(node.parent) ? node.parent.name.getText() : undefined;
          const opening = attribute ? node.parent.parent.parent : undefined;
          const tag = opening && (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) ? opening.tagName.getText() : '';
          const customComponent = /^[A-Z]/.test(tag) || tag.includes('.');
          if (!attribute || attribute === 'children' || (/^(input|textarea)$/.test(tag) && ['value', 'defaultValue'].includes(attribute)) || (customComponent && ['value', 'label', 'text'].includes(attribute))) expressionFound = true;
        }
        if ((ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.trim() === decision.designText?.trim()) throw new Error(`Hardcoded dynamic design value in JSX: ${decision.nodeId}`);
        ts.forEachChild(node, inspect);
      }
      inspect(candidate.element);
      if (!expressionFound) throw new Error(`Approved data expression is not rendered for ${decision.nodeId}: ${binding.expression}`);
      const rootName = binding.expression.match(/^[A-Za-z_$][\w$]*/)![0];
      let owningFunction: ts.Node | undefined = candidate.element.parent;
      while (owningFunction && !ts.isFunctionLike(owningFunction)) owningFunction = owningFunction.parent;
      const parameters = owningFunction && 'parameters' in owningFunction ? (owningFunction as ts.FunctionLikeDeclaration).parameters : [];
      const aliases = new Set([rootName]);
      const rootIdentifier = (node: ts.Node): string | undefined => {
        if (ts.isIdentifier(node)) return node.text;
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return rootIdentifier(node.expression);
        return undefined;
      };
      let previousAliasCount = -1;
      while (previousAliasCount !== aliases.size) {
        previousAliasCount = aliases.size;
        function findAlias(node: ts.Node) {
          if (ts.isVariableDeclaration(node) && node.initializer && aliases.has(rootIdentifier(node.initializer) ?? '')) bindingNames(node.name).forEach(name => aliases.add(name));
          ts.forEachChild(node, findAlias);
        }
        findAlias(owningFunction ?? candidate.source);
      }
      function rejectMutation(node: ts.Node) {
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && aliases.has(rootIdentifier(node.left) ?? '')) throw new Error(`Approved project data is reassigned inside production view: ${decision.nodeId}`);
        if ((ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && aliases.has(rootIdentifier(node.operand) ?? '')) throw new Error(`Approved project data is mutated inside production view: ${decision.nodeId}`);
        if (ts.isDeleteExpression(node) && aliases.has(rootIdentifier(node.expression) ?? '')) throw new Error(`Approved project data is deleted inside production view: ${decision.nodeId}`);
        if (ts.isCallExpression(node) && node.expression.getText() === 'Object.assign' && node.arguments[0] && aliases.has(rootIdentifier(node.arguments[0]) ?? '')) throw new Error(`Approved project data is overwritten inside production view: ${decision.nodeId}`);
        ts.forEachChild(node, rejectMutation);
      }
      rejectMutation(owningFunction ?? candidate.source);
      if (binding.delivery === 'props') {
        const parameter = parameters.find(item => bindingNames(item.name).includes(rootName));
        if (!parameter) throw new Error(`Props expression is not rooted in the rendered function parameter: ${decision.nodeId}`);
        if (parameter.initializer) throw new Error(`Preview values must not be defaults in production props: ${decision.nodeId}`);
        function rejectBindingDefault(node: ts.Node) {
          if (ts.isBindingElement(node) && bindingNames(node.name).includes(rootName) && node.initializer) throw new Error(`Preview values must not be defaults in destructured production props: ${decision.nodeId}`);
          ts.forEachChild(node, rejectBindingDefault);
        }
        rejectBindingDefault(parameter.name);
      } else {
        const imported = new Set<string>();
        for (const statement of candidate.source.statements) {
          if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause || statement.importClause.isTypeOnly) continue;
          if (importProjectPath(statement.moduleSpecifier.text, candidate.filename) !== path.resolve(report.projectRoot, binding.source.projectPath)) continue;
          if (statement.importClause.name) imported.add(statement.importClause.name.text);
          const names = statement.importClause.namedBindings;
          if (names && ts.isNamedImports(names)) names.elements.forEach(item => imported.add(item.name.text));
          else if (names && ts.isNamespaceImport(names)) imported.add(names.name.text);
        }
        let dataOrigin = false;
        function checkDeclaration(node: ts.Node) {
          if (ts.isVariableDeclaration(node) && bindingNames(node.name).includes(rootName) && node.initializer) {
            let importedRead = false, literalFallback = false;
            function read(child: ts.Node) {
              if (ts.isIdentifier(child) && imported.has(child.text)) importedRead = true;
              if ((ts.isStringLiteral(child) || ts.isNumericLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) && child.text.trim() === decision.designText?.trim()) literalFallback = true;
              ts.forEachChild(child, read);
            }
            read(node.initializer);
            const call = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
            const approvedCall = ts.isCallExpression(call) && (imported.has(rootIdentifier(call.expression) ?? '') || (binding.delivery === 'context' && /(?:^|\.)useContext$/.test(call.expression.getText()) && importedRead));
            dataOrigin ||= approvedCall && importedRead && !literalFallback;
          }
          ts.forEachChild(node, checkDeclaration);
        }
        checkDeclaration(owningFunction ?? candidate.source);
        if (!dataOrigin) throw new Error(`Dynamic expression is not derived from the verified project hook/context import: ${decision.nodeId}`);
      }
    }
  }
}
