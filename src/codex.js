import { spawn } from 'node:child_process';
import { access, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

// npm's Windows .cmd launcher needs a shell. Resolve its JS entry point instead,
// so neither prompts nor model names ever become shell source.
export async function resolveCodexCommand(bin, env = process.env, platform = process.platform) {
  let executable = bin;
  if (!path.isAbsolute(bin) && !bin.includes('/') && !bin.includes('\\')) {
    const extensions = platform === 'win32' && !path.extname(bin) ? ['.exe', '.cmd', ''] : [''];
    for (const directory of (env.PATH || env.Path || '').split(path.delimiter)) {
      if (!directory) continue;
      for (const extension of extensions) {
        const candidate = path.resolve(directory, bin + extension);
        if (await exists(candidate)) { executable = candidate; break; }
      }
      if (executable !== bin) break;
    }
  } else {
    executable = path.resolve(bin);
  }
  if (/\.(cmd|bat)$/i.test(executable)) {
    const entry = path.join(path.dirname(executable), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (!(await exists(entry))) {
      throw new Error('Cannot resolve Codex npm launcher. Set CODEX_BIN to codex.exe or @openai/codex/bin/codex.js.');
    }
    return { executable: process.execPath, prefix: [entry] };
  }
  if (/\.m?js$/i.test(executable)) return { executable: process.execPath, prefix: [executable] };
  return { executable, prefix: [] };
}

function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore',
    });
    killer.on('error', () => child.kill('SIGKILL'));
    killer.on('exit', (code) => { if (code !== 0) child.kill('SIGKILL'); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

export function execute(command, args, { cwd, input, timeoutMs, signal, maxOutputBytes = MAX_OUTPUT_BYTES }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Codex request cancelled')); return; }
    const child = spawn(command.executable, [...command.prefix, ...args], {
      cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let failure;
    let bytes = 0;
    let stderr = '';
    let killDeadline;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killDeadline);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve();
    };
    const stop = (error) => {
      if (failure || settled) return;
      failure = error;
      terminateTree(child);
      killDeadline = setTimeout(() => {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        child.unref();
        finish(failure);
      }, 3000);
    };
    const cancel = () => stop(new Error('Codex request cancelled'));
    const timer = setTimeout(() => stop(new Error(`Codex timed out after ${timeoutMs} ms`)), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    const capture = (chunk, isError) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { stop(new Error('Codex output exceeded the size limit')); return; }
      if (isError) stderr = (stderr + chunk.toString('utf8')).slice(-8000);
    };
    child.stdout.on('data', (chunk) => capture(chunk, false));
    child.stderr.on('data', (chunk) => capture(chunk, true));
    child.on('error', (error) => finish(new Error(`Unable to start Codex CLI: ${error.message}. Check CODEX_BIN and installation.`)));
    child.on('close', (code, exitSignal) => finish(failure || (code === 0 ? undefined :
      new Error(`Codex CLI exited with ${code ?? exitSignal}: ${stderr.trim() || 'no diagnostics'}`))));
    // Early process exits can close stdin before the prompt is written.
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') stop(error); });
    child.stdin.end(input, 'utf8');
  });
}

async function readArtifact(file, maxBytes) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Codex output must be a regular file');
  if (info.size > maxBytes) throw new Error('Codex artifact exceeded the size limit');
  const handle = await open(file, 'r');
  try {
    // Bound allocation even if the file grows after lstat.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error('Codex artifact exceeded the size limit');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

export function createCodexRunner(config, logger) {
  let active = 0;
  return async function run({ tool, prompt, model, requestId, signal }) {
    if (active >= config.maxConcurrent) throw new Error('Codex is busy; retry when an active request finishes');
    active++;
    try {
      const directory = path.join(config.dataDir, requestId);
      await mkdir(directory, { recursive: true });
      const output = path.join(directory, 'response.txt');
      const drawing = tool === 'codex_draw';
      const input = drawing ? [
        '$imagegen',
        'Generate one image for the request below using the available image generation tool/skill.',
        'Save the actual generated image as PNG at output.png in the current working directory.',
        'If the tool saves elsewhere, copy the generated file here. Do not return only a path or a description.',
        'If image generation is unavailable, explain the failure; do not fabricate an image or draw a placeholder.',
        '', 'Image request:', prompt,
      ].join('\n') : prompt;
      const args = ['--ask-for-approval', 'never', 'exec', '--skip-git-repo-check', '--color', 'never',
        '--sandbox', drawing ? 'workspace-write' : 'read-only', '--output-last-message', output];
      if (model) args.push('--model', model);
      args.push('-');
      const command = await resolveCodexCommand(config.codexBin);
      logger.log('codex.start', { requestId, tool, command: command.executable, args: [...command.prefix, ...args], cwd: directory });
      await execute(command, args, { cwd: directory, input, timeoutMs: config.timeoutMs, signal });
      let text = '';
      try { text = (await readArtifact(output, MAX_OUTPUT_BYTES)).toString('utf8').trim(); }
      catch (error) { if (error.code !== 'ENOENT' || !drawing) throw error; }
      if (!drawing) {
        if (!text) throw new Error('Codex returned an empty response');
        return { content: [{ type: 'text', text }] };
      }
      const imagePath = path.join(directory, 'output.png');
      let image;
      try { image = await readArtifact(imagePath, MAX_IMAGE_BYTES); }
      catch (error) {
        if (error.code === 'ENOENT') throw new Error(`Codex did not create output.png. Check CLI image generation support and account access. ${text}`);
        throw error;
      }
      if (image.length < 33 || !image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
          image.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Codex output.png is not a PNG image');
      return { content: [
        { type: 'text', text: `${text || 'Image generated.'}\nSaved to: ${imagePath}` },
        { type: 'image', mimeType: 'image/png', data: image.toString('base64') },
      ] };
    } finally { active--; }
  };
}
