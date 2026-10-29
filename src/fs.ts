import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const slug = (value: string) => `${value.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 60) || 'item'}-${hash(value).slice(0, 8)}`;
export async function json<T>(file: string): Promise<T> { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as T; }
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await rename(temp, file);
}
export function inside(root: string, relative: string): string {
  const target = path.resolve(root, relative), rel = path.relative(path.resolve(root), target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Path escapes root: ${relative}`);
  return target;
}
export async function rejectSymlinkPath(root: string, target: string): Promise<void> {
  inside(root, path.relative(root, target));
  const actualRoot = await realpath(root);
  let cursor = path.resolve(root);
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`Symlink/junction is not allowed in output: ${cursor}`);
      const actual = await realpath(cursor);
      inside(actualRoot, path.relative(actualRoot, actual));
    } catch (error: any) { if (error.code === 'ENOENT') break; throw error; }
  }
}
