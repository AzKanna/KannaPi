// This worker always runs inside AppContainer, never in the server process.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const root = process.cwd();
function local(value = '.') {
  const target = path.resolve(root, value);
  const rel = path.relative(root, target);
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) throw new Error('Path must be inside the sandbox workspace');
  return target;
}
async function walk(directory, results = [], depth = 0) {
  if (depth > 30 || results.length >= 2000) return results;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === '.runtime' || entry.name === '.home') continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target, results, depth + 1);
    else results.push(target);
    if (results.length >= 2000) break;
  }
  return results;
}
try {
  let result;
  const target = local(input.path);
  if (input.op === 'exec') {
    const child = spawn(process.env.SystemRoot + '\\System32\\cmd.exe', ['/d', '/s', '/c', input.command], {
      cwd: target, env: { ...process.env, PATH: path.join(root, '.runtime') + ';' + process.env.PATH }, stdio: 'inherit', windowsHide: true,
    });
    child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', (code) => { process.exitCode = code ?? 1; });
  } else {
    if (input.op === 'read') {
      const text = await fs.readFile(target, 'utf8');
      result = text.split(/\r?\n/).slice(Math.max(0, (input.offset ?? 1) - 1), Math.max(0, (input.offset ?? 1) - 1) + (input.limit ?? 500)).join('\n');
    } else if (input.op === 'write') {
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, input.content, 'utf8'); result = 'File written in sandbox';
    } else if (input.op === 'edit') {
      const text = await fs.readFile(target, 'utf8');
      if (!input.oldText || !text.includes(input.oldText) || text.indexOf(input.oldText) !== text.lastIndexOf(input.oldText)) throw new Error('oldText must match exactly once');
      await fs.writeFile(target, text.replace(input.oldText, input.newText), 'utf8'); result = 'File edited in sandbox';
    } else if (input.op === 'ls') {
      result = (await fs.readdir(target, { withFileTypes: true })).slice(0, 500).map((e) => e.name + (e.isDirectory() ? '/' : '')).join('\n');
    } else if (input.op === 'find') {
      const pattern = input.pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
      const regex = new RegExp(pattern, 'i');
      result = (await walk(target)).map((p) => path.relative(root, p)).filter((p) => regex.test(p)).slice(0, 500).join('\n');
    } else if (input.op === 'grep') {
      const files = (await fs.stat(target)).isDirectory() ? await walk(target) : [target];
      const matches = [];
      for (const file of files) {
        if ((await fs.stat(file)).size > 1024 * 1024) continue;
        const text = await fs.readFile(file, 'utf8').catch(() => '');
        if (text.includes('\0')) continue;
        for (const [index, line] of text.split(/\r?\n/).entries()) if (line.includes(input.pattern)) matches.push(`${path.relative(root, file)}:${index + 1}:${line.slice(0, 1000)}`);
        if (matches.length >= 500) break;
      }
      result = matches.slice(0, 500).join('\n');
    } else throw new Error('Unknown sandbox operation');
    process.stdout.write(String(result).slice(0, 64000));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
