import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { hash, inside, json, writeJson, rejectSymlinkPath } from './fs.js';
import type { BridgeConfig } from './types.js';

export interface ProjectDataProfile { mechanisms: string[]; files: { path: string; sha256: string; kind: string }[]; scanLimit: number; truncatedDiscovery: boolean; issues: string[]; setupFile?: string; bootstrapFile?: string; instructions?: string }
export interface ProjectProfile { root: string; dependencies: Record<string, string>; css: { path: string; sha256: string; classes: string[] }[]; components: { path: string; sha256: string; exports: string[] }[]; metadata: { path: string; sha256: string }[]; data: ProjectDataProfile; scanLimit: number; truncatedDiscovery: boolean; designSystem?: { name: string; packageName?: string } }
export async function inspectProject(config: BridgeConfig, outputFile?: string): Promise<ProjectProfile> {
  const root = config.projectRoot;
  let pkg: any = {}; try { pkg = await json(path.join(root, 'package.json')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const discovered: string[] = [], dataDiscovered: string[] = []; let truncatedDiscovery = false, dataTruncated = false, visitedEntries = 0;
  const discoverComponents = !config.generation.cssFiles.length || !config.generation.componentFiles.length;
  const discoverData = !config.generation.data?.mockFiles?.length;
  const skip = new Set(['node_modules', '.git', '.pixso-artifacts', 'dist', 'build', '.next', 'coverage', 'output']);
  async function scan(directory: string) {
    if (path.resolve(directory) === path.resolve(config.artifactsDir) || path.resolve(directory) === path.resolve(config.generation.outputDir)) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (entry.name.startsWith('.') && entry.name !== '.storybook') || skip.has(entry.name)) continue;
      if (++visitedEntries > 10000) { truncatedDiscovery ||= discoverComponents; dataTruncated ||= discoverData; return; }
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(filename);
      else {
        const relative = path.relative(root, filename).replaceAll('\\', '/');
        if (discoverComponents && /\.(css|tsx|jsx)$/.test(entry.name)) { if (discovered.length < 400) discovered.push(relative); else truncatedDiscovery = true; }
        if (discoverData && /\.(?:[cm]?[jt]sx?|json)$/i.test(entry.name) && (/(?:^|[\/._-])(?:mocks?|__mocks__|fixtures?|factories|factory|stories|storybook|handlers|seeds?|mirage)(?:[\/._-]|[A-Z]|$)/.test(relative) || /(?:mock|fixture|factory|stories|storybook)/i.test(relative) || (entry.name === 'db.json' && (pkg.dependencies?.['json-server'] || pkg.devDependencies?.['json-server'])))) {
          if (dataDiscovered.length < 200) dataDiscovered.push(relative); else dataTruncated = true;
        }
      }
    }
  }
  if (discoverComponents || discoverData) await scan(root);
  const cssPaths = config.generation.cssFiles.length ? config.generation.cssFiles : discovered.filter(f => f.endsWith('.css'));
  const componentPaths = config.generation.componentFiles.length ? config.generation.componentFiles : discovered.filter(f => /\.[jt]sx$/.test(f));
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies }, mechanisms: string[] = [];
  for (const [pattern, mechanism] of [[/^msw$/, 'MSW'], [/^miragejs$/, 'Mirage'], [/^json-server$/, 'json-server'], [/^(?:@faker-js\/faker|faker|fishery|rosie|factory\.ts)$/, 'factory'], [/^(?:@storybook\/|storybook$)/, 'Storybook']] as const) if (Object.keys(dependencies).some(name => pattern.test(name))) mechanisms.push(mechanism);
  const setupFile = config.validation.setupFile, bootstrapFile = config.generation.data?.setupFile;
  const profile: ProjectProfile = { root, dependencies, css: [], components: [], metadata: [], data: { mechanisms, files: [], scanLimit: 200, truncatedDiscovery: dataTruncated, issues: [], ...(setupFile ? { setupFile: setupFile.replaceAll('\\', '/') } : {}), ...(bootstrapFile ? { bootstrapFile: bootstrapFile.replaceAll('\\', '/') } : {}), ...(config.generation.data?.instructions ? { instructions: config.generation.data.instructions } : {}) }, scanLimit: 400, truncatedDiscovery, ...(config.generation.designSystem ? { designSystem: config.generation.designSystem } : {}) };
  const dataPaths = [...new Set([...(config.generation.data?.mockFiles?.length ? config.generation.data.mockFiles : dataDiscovered), ...(setupFile ? [setupFile] : []), ...(bootstrapFile ? [bootstrapFile] : [])])];
  for (const filename of dataPaths) {
    const absolute = inside(root, filename); await rejectSymlinkPath(root, absolute);
    const relative = filename.replaceAll('\\', '/'), kind = filename === setupFile ? 'setup' : filename === bootstrapFile ? 'bootstrap' : /factor/i.test(relative) ? 'factory' : /stor(y|ies|ybook)/i.test(relative) ? 'story' : /fixture|seed/i.test(relative) ? 'fixture' : 'mock';
    try { profile.data.files.push({ path: relative, sha256: hash(await readFile(absolute)), kind }); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; profile.data.issues.push(`Configured project data file is missing: ${relative}`); }
  }
  if (profile.data.files.some(file => file.kind !== 'setup') && !mechanisms.length) mechanisms.push('project-custom');
  const metadataPaths = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];
  if (config.generation.designSystem?.packageName) metadataPaths.push(`node_modules/${config.generation.designSystem.packageName}/package.json`);
  for (const filename of metadataPaths) {
    try { const absolute = inside(root, filename); await rejectSymlinkPath(root, absolute); profile.metadata.push({ path: filename, sha256: hash(await readFile(absolute)) }); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const filename of cssPaths) {
    const absolute = inside(root, filename); await rejectSymlinkPath(root, absolute);
    const text = await readFile(absolute, 'utf8');
    profile.css.push({ path: filename, sha256: hash(text), classes: [...new Set([...text.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)].map(m => m[1]))] });
  }
  for (const filename of componentPaths) {
    const absolute = inside(root, filename); await rejectSymlinkPath(root, absolute);
    const text = await readFile(absolute, 'utf8'), source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true), exports = new Set<string>();
    for (const statement of source.statements) {
      if (ts.isExportAssignment(statement)) exports.add('default');
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) statement.exportClause.elements.forEach(item => exports.add(item.name.text));
      if (!ts.canHaveModifiers(statement)) continue;
      const modifiers = ts.getModifiers(statement) ?? [];
      if (!modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) exports.add('default');
      if (ts.isVariableStatement(statement)) statement.declarationList.declarations.forEach(declaration => { if (ts.isIdentifier(declaration.name)) exports.add(declaration.name.text); });
      else if ('name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) exports.add((statement.name as ts.Identifier).text);
    }
    profile.components.push({ path: filename, sha256: hash(text), exports: [...exports] });
  }
  if (outputFile) await writeJson(outputFile, profile);
  return profile;
}
