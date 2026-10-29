import path from 'node:path';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { ScreenIndex } from './types.js';

export interface PreparedWidget {
  id: string;
  nodeIds: string[];
  filename: string;
  cssFilename: string;
  directory: string;
  exportNames: Record<string, string>;
}
export interface WidgetPlan { viewTsx: string; viewCss: string; widgets: PreparedWidget[] }

type DesignElement = ts.JsxElement | ts.JsxSelfClosingElement;
const digest = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 12);
const nodeName = (id: string): string => `Node_${digest(id)}`;

function designId(node: ts.Node): string | undefined {
  const attributes = ts.isJsxElement(node) ? node.openingElement.attributes : ts.isJsxSelfClosingElement(node) ? node.attributes : undefined;
  const attribute = attributes?.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText() === 'data-pixso-id');
  if (!attribute || !ts.isJsxAttribute(attribute)) return undefined;
  const value = attribute.initializer;
  if (value && ts.isStringLiteral(value)) return value.text;
  if (value && ts.isJsxExpression(value) && value.expression && ts.isStringLiteral(value.expression)) return value.expression.text;
  throw new Error('Baseline data-pixso-id must be a constant string');
}

function identifiers(node: ts.Node): Set<string> {
  const result = new Set<string>();
  function visit(current: ts.Node): void { if (ts.isIdentifier(current)) result.add(current.text); ts.forEachChild(current, visit); }
  visit(node); return result;
}

/** The baseline emits ordinary rules; scan quotes/comments so text such as a font named A}B stays intact. */
function cssRules(css: string): { text: string; selector: string }[] {
  const result: { text: string; selector: string }[] = [];
  let start = 0, selectorEnd = -1, depth = 0, quote = '', comment = false;
  for (let index = 0; index < css.length; index++) {
    const character = css[index], next = css[index + 1];
    if (comment) { if (character === '*' && next === '/') { comment = false; index++; } continue; }
    if (quote) { if (character === '\\') index++; else if (character === quote) quote = ''; continue; }
    if (character === '/' && next === '*') { comment = true; index++; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '{') { if (depth === 0) selectorEnd = index; depth++; }
    else if (character === '}') {
      if (--depth < 0) throw new Error('Baseline CSS has an unmatched closing brace');
      if (depth === 0) { result.push({ text: css.slice(start, index + 1), selector: css.slice(start, selectorEnd).replace(/\/\*[\s\S]*?\*\//g, '').trim() }); start = index + 1; }
    }
  }
  if (depth || quote || comment) throw new Error('Baseline CSS is incomplete');
  if (css.slice(start).trim()) result.push({ text: css.slice(start), selector: '' });
  return result;
}

function localAsset(relative: string): boolean { return relative.startsWith('./assets/') || relative.startsWith('assets/'); }
function within(root: string, relative: string): string {
  const filename = path.resolve(root, relative), difference = path.relative(path.resolve(root), filename);
  if (path.isAbsolute(difference) || difference === '..' || difference.startsWith(`..${path.sep}`)) throw new Error(`Asset escapes baseline/output: ${relative}`);
  return filename;
}

/** Splits one exact baseline into bounded source files; workers can refine them independently. */
export async function prepareWidgets(baselineDir: string, screen: ScreenIndex, outputDir: string): Promise<WidgetPlan> {
  const baseline = path.resolve(baselineDir), output = path.resolve(outputDir);
  const [tsx, css] = await Promise.all([readFile(path.join(baseline, 'View.tsx'), 'utf8'), readFile(path.join(baseline, 'View.css'), 'utf8')]);
  const parsed = ts.transpileModule(tsx, { fileName: 'View.tsx', compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
  if (parsed.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error)) throw new Error('Baseline TSX has syntax errors');
  const source = ts.createSourceFile('View.tsx', tsx, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const elements = new Map<string, DesignElement>();
  function collect(node: ts.Node): void {
    const id = designId(node);
    if (id !== undefined) {
      if (elements.has(id)) throw new Error(`Duplicate baseline node ID: ${id}`);
      elements.set(id, node as DesignElement);
    }
    ts.forEachChild(node, collect);
  }
  collect(source);
  const expected = new Set(screen.nodeIds);
  if (expected.size !== screen.nodeIds.length || !expected.has(screen.id)) throw new Error('Screen inventory has duplicates or is missing its root');
  if (elements.size !== expected.size || [...expected].some((id) => !elements.has(id)) || [...elements.keys()].some((id) => !expected.has(id))) throw new Error('Baseline node inventory differs from the complete screen inventory');
  const widgets: PreparedWidget[] = screen.widgets.map((widget, index) => {
    const name = `Widget${String(index + 1).padStart(4, '0')}`;
    return { id: widget.id, nodeIds: [...widget.nodeIds], filename: `${name}.tsx`, cssFilename: `${name}.css`, directory: path.join(output, 'widgets', name), exportNames: Object.fromEntries(widget.nodeIds.map((id) => [id, nodeName(id)])) };
  });
  if (new Set(widgets.map((widget) => widget.id)).size !== widgets.length) throw new Error('Widget partition IDs must be unique');
  const owner = new Map<string, PreparedWidget>();
  const hashOwner = new Map<string, PreparedWidget>();
  const hashIds = new Map<string, string>();
  for (const widget of widgets) {
    if (!widget.nodeIds.length) throw new Error(`Empty widget partition: ${widget.id}`);
    for (const id of widget.nodeIds) {
      if (!expected.has(id) || owner.has(id)) throw new Error(`Widget partition has an unknown or duplicate node: ${id}`);
      owner.set(id, widget);
      const short = digest(id);
      if (hashIds.has(short) && hashIds.get(short) !== id) throw new Error('Node hash collision prevents unambiguous widget CSS ownership');
      hashOwner.set(short, widget); hashIds.set(short, id);
    }
  }
  if (owner.size !== expected.size) throw new Error('Widget partitions do not cover every screen node');
  const widgetCss = new Map(widgets.map((widget) => [widget.id, [] as string[]]));
  const globalCss: string[] = [], styledIds = new Set<string>();
  for (const rule of cssRules(css)) {
    const classes = [...rule.selector.matchAll(/\.pixso-([a-f\d]{12})(?=[^a-f\d]|$)/g)].map((match) => match[1]);
    const owners = new Set<PreparedWidget>();
    for (const short of classes) {
      const widget = hashOwner.get(short);
      if (!widget) throw new Error(`CSS refers to an uncaptured design node: pixso-${short}`);
      owners.add(widget); styledIds.add(hashIds.get(short)!);
    }
    if (!owners.size) globalCss.push(rule.text);
    else for (const widget of owners) widgetCss.get(widget.id)!.push(rule.text);
  }
  if ([...expected].some((id) => !styledIds.has(id))) throw new Error('Baseline CSS is missing rules for one or more design nodes');
  const constants = new Map<string, { declaration: ts.VariableDeclaration; statement: ts.VariableStatement }>();
  const originalImports = source.statements.filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement) && !(ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.endsWith('.css')));
  for (const statement of source.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) constants.set(declaration.name.text, { declaration, statement });
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  for (const widget of widgets) {
    const functions: ts.FunctionDeclaration[] = [];
    const foreign = new Map<PreparedWidget, Set<string>>();
    for (const id of widget.nodeIds) {
      const original = elements.get(id)!;
      const transformed = ts.transform(original, [(context) => (root) => {
        const visitor: ts.Visitor = (node) => {
          const childId = node !== original ? designId(node) : undefined;
          if (childId !== undefined) {
            const target = owner.get(childId);
            if (!target) throw new Error(`Referenced child is outside widget coverage: ${childId}`);
            if (target !== widget) { const imports = foreign.get(target) ?? new Set<string>(); imports.add(nodeName(childId)); foreign.set(target, imports); }
            return ts.factory.createJsxSelfClosingElement(ts.factory.createIdentifier(nodeName(childId)), undefined, ts.factory.createJsxAttributes([ts.factory.createJsxSpreadAttribute(ts.factory.createIdentifier('props'))]));
          }
          return ts.visitEachChild(node, visitor, context);
        };
        return ts.visitNode(root, visitor) as DesignElement;
      }]);
      const element = transformed.transformed[0];
      const props = ts.factory.createParameterDeclaration(undefined, undefined, 'props', undefined, ts.factory.createTypeReferenceNode('Record', [ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword), ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)]));
      functions.push(ts.factory.createFunctionDeclaration([ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)], undefined, nodeName(id), undefined, [props], undefined, ts.factory.createBlock([ts.factory.createReturnStatement(element)], true)));
      transformed.dispose();
    }
    const needed = new Set<string>();
    functions.forEach((fn) => identifiers(fn).forEach((name) => { if (constants.has(name)) needed.add(name); }));
    for (const name of needed) identifiers(constants.get(name)!.declaration).forEach((dependency) => { if (constants.has(dependency)) needed.add(dependency); });
    const preamble: ts.Statement[] = [...originalImports];
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const declarations = statement.declarationList.declarations.filter((declaration) => ts.isIdentifier(declaration.name) && needed.has(declaration.name.text));
      if (declarations.length) preamble.push(ts.factory.updateVariableStatement(statement, statement.modifiers, ts.factory.updateVariableDeclarationList(statement.declarationList, declarations)));
    }
    const imports = [...foreign].sort(([a], [b]) => a.filename.localeCompare(b.filename)).map(([target, names]) => `import { ${[...names].sort().join(', ')} } from ${JSON.stringify(`./${target.filename.slice(0, -4)}`)};`);
    const code = [`import './${widget.cssFilename}';`, ...imports, ...preamble.map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, source)), ...functions.map((fn) => printer.printNode(ts.EmitHint.Unspecified, fn, source))].join('\n\n') + '\n';
    const styles = widgetCss.get(widget.id)!.join('\n').trim() + '\n';
    await mkdir(widget.directory, { recursive: true });
    await writeFile(path.join(widget.directory, widget.filename), code, 'utf8');
    await writeFile(path.join(widget.directory, widget.cssFilename), styles, 'utf8');
    const assets = new Set<string>();
    const inspectAssets = (node: ts.Node): void => { if (ts.isStringLiteral(node) && localAsset(node.text)) assets.add(node.text); ts.forEachChild(node, inspectAssets); };
    [...preamble, ...functions].forEach(inspectAssets);
    for (const match of styles.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi)) { const value = match[1] ?? match[2] ?? match[3]; if (localAsset(value)) assets.add(value); }
    for (const relative of assets) { const destination = within(widget.directory, relative); await mkdir(path.dirname(destination), { recursive: true }); await copyFile(within(baseline, relative), destination); }
  }
  await mkdir(output, { recursive: true });
  const rootOwner = owner.get(screen.id)!;
  const viewTsx = path.join(output, 'View.tsx'), viewCss = path.join(output, 'View.css');
  await writeFile(viewTsx, `import './View.css';\nimport { ${nodeName(screen.id)} } from ${JSON.stringify(`./${rootOwner.filename.slice(0, -4)}`)};\n\nexport function View(props: Parameters<typeof ${nodeName(screen.id)}>[0]) {\n  return <div className="pixso-capture"><${nodeName(screen.id)} {...props} /></div>;\n}\n\nexport default View;\n`, 'utf8');
  await writeFile(viewCss, globalCss.join('\n').trim() + '\n', 'utf8');
  return { viewTsx, viewCss, widgets };
}
