import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, writeJson } from './fs.js';

export async function installGigacode(projectRoot: string, configPath: string) {
  const root = path.resolve(projectRoot), dir = path.join(root, '.gigacode');
  await mkdir(dir, { recursive: true });
  const settingsPath = path.join(dir, 'settings.json'); let settings: any = {};
  try {
    settings = await json(settingsPath);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('GigaCode settings.json must contain a JSON object; existing file was preserved');
    if ('mcpServers' in settings && (!settings.mcpServers || typeof settings.mcpServers !== 'object' || Array.isArray(settings.mcpServers))) throw new Error('GigaCode mcpServers must be a JSON object; existing file was preserved');
    await copyFile(settingsPath, `${settingsPath}.backup-${Date.now()}`);
  }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const sourceMode = import.meta.url.endsWith('.ts');
  const loader = sourceMode ? ['--import', import.meta.resolve('tsx')] : [];
  const server = { command: process.execPath, args: [...loader, fileURLToPath(new URL(sourceMode ? './cli.ts' : './cli.js', import.meta.url)), 'serve', '--config', path.resolve(configPath)] };
  if (settings.mcpServers?.['pixso-react'] && JSON.stringify(settings.mcpServers['pixso-react']) !== JSON.stringify(server)) throw new Error('MCP pixso-react is already configured with different settings; preserved existing configuration');
  settings.mcpServers = { ...settings.mcpServers, 'pixso-react': server };
  const skillDir = path.join(dir, 'skills', 'pixso-react'); await mkdir(skillDir, { recursive: true });
  const sourceSkill = await readFile(fileURLToPath(new URL('../skills/pixso-react/SKILL.md', import.meta.url)), 'utf8');
  const templates = [
    { file: 'SKILL.md', data: Buffer.from(sourceSkill.replace('](../../docs/gigacode.md)', '](reference.md)')) },
    { file: 'reference.md', data: await readFile(fileURLToPath(new URL('../docs/gigacode.md', import.meta.url))) },
  ];
  const missing: typeof templates = [];
  for (const template of templates) {
    try { const existing = await readFile(path.join(skillDir, template.file)); if (!existing.equals(template.data)) throw new Error(`Existing pixso-react ${template.file} differs; preserved it`); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; missing.push(template); }
  }
  for (const template of missing) await writeFile(path.join(skillDir, template.file), template.data, { flag: 'wx' });
  await writeJson(settingsPath, settings);
  return { settingsPath, skillDir, server, next: 'Restart GigaCode CLI in this project; use pixso_status and pixso_inspect to verify connectivity.' };
}
