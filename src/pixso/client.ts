import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BridgeConfig, Raw } from '../types.js';
import { explicitTruncation } from './normalize.js';

export type PixsoConfig = BridgeConfig['pixso'];
export interface ToolDefinition { name: string; inputSchema: Raw; description?: string }
export interface PixsoConnection {
  tools: ToolDefinition[];
  call(name: string, args: Raw): Promise<unknown>;
  close(): Promise<void>;
}

/** Parse machine data only. Text explaining an incomplete result is never a valid design. */
export function decodeToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') throw new Error('MCP result is not an object');
  const r = result as Raw;
  if (r.isError) throw new Error('Pixso returned an MCP tool error; inspect the saved raw response');
  if (explicitTruncation(r)) throw new Error('Pixso explicitly reported truncated or paginated output');
  if (r.structuredContent !== undefined) return unwrap(r.structuredContent);
  const parts = (r.content ?? []).filter((x: Raw) => x.type === 'text').map((x: Raw) => x.text);
  if (!parts.length) throw new Error('Pixso did not return structured JSON data');
  const text = parts.join('\n').trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
  try { return unwrap(JSON.parse(text)); }
  catch { throw new Error('Pixso response is not complete JSON; raw response retained (no truncation guessing)'); }
}

function unwrap(value: unknown): unknown {
  if (explicitTruncation(value)) throw new Error('Pixso explicitly reported truncated or paginated output');
  if (typeof value === 'string') return parseNested(value);
  // eval_script versions return either a JSON value or { result: value }.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const r = value as Raw;
    if (r.error) throw new Error(`Pixso script failed: ${String(r.error)}`);
    if (Object.hasOwn(r, 'result') && (Object.keys(r).length === 1 || r.success === true)) {
      return unwrap(r.result);
    }
    if (Object.keys(r).length === 1 && typeof r.data === 'string') return parseNested(r.data);
  }
  return value;
}
function parseNested(value: string): unknown {
  let parsed: unknown = value;
  for (let i = 0; i < 4 && typeof parsed === 'string'; i++) { try { parsed = JSON.parse(parsed); } catch { break; } }
  return typeof parsed === 'string' ? parsed : unwrap(parsed);
}

export function toolArguments(tool: ToolDefinition, values: Raw): Raw {
  const properties = tool.inputSchema?.properties ?? {};
  const result: Raw = {};
  for (const [key, value] of Object.entries(values)) if (key in properties) result[key] = value;
  for (const key of tool.inputSchema?.required ?? []) {
    if (!(key in result)) throw new Error(`${tool.name} requires unsupported argument ${key}; inspect tools.json and configure matching Pixso version`);
  }
  return result;
}

export async function connectPixso(config: PixsoConfig, rawDir?: string): Promise<PixsoConnection> {
  const client = new Client({ name: 'pixso-react-bridge', version: '1.0.0' });
  const headers: Record<string, string> = {};
  for (const [header, envName] of Object.entries(config.headersEnv ?? {})) {
    const value = process.env[envName];
    if (!value) throw new Error(`Environment variable ${envName} is required for Pixso authentication`);
    headers[header] = value;
  }
  if (rawDir) await mkdir(rawDir, { recursive: true });
  let sequence = 0;
  try {
    if (config.transport === 'stdio') {
      if (!config.command) throw new Error('pixso.command is required for stdio transport');
      const env = Object.fromEntries(Object.entries(process.env).filter((x): x is [string, string] => x[1] !== undefined));
      await client.connect(new StdioClientTransport({ command: config.command, args: config.args ?? [], env, stderr: 'pipe' }));
    } else {
      if (!config.url) throw new Error('pixso.url is required for HTTP/SSE transport');
      const url = new URL(config.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Pixso URL must use HTTP or HTTPS');
      const transport = config.transport === 'sse'
        ? new SSEClientTransport(url, { requestInit: { headers } })
        : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
      await client.connect(transport);
    }
    const tools: ToolDefinition[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools as ToolDefinition[]);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Pixso tools/list repeated a pagination cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (rawDir) await writeFile(join(rawDir, 'tools.json'), JSON.stringify({ server: client.getServerVersion(), tools }, null, 2));
    return {
      tools,
      async call(name, args) {
        const n = ++sequence;
        const tool = tools.find(t => t.name === name);
        if (!tool) throw new Error(`Pixso tool ${name} is unavailable`);
        const arguments_ = toolArguments(tool, args);
        const response = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: Number(config.timeoutMs ?? 120_000) });
        if (rawDir) {
          const basename = `${String(n).padStart(6, '0')}-${name.replace(/[^a-z0-9_-]/gi, '_')}`;
          await writeFile(join(rawDir, `${basename}.json`), JSON.stringify({ tool: name, arguments: arguments_, response }, null, 2));
        }
        return decodeToolResult(response);
      },
      close: () => client.close(),
    };
  } catch (error) { await client.close().catch(() => {}); throw error; }
}
