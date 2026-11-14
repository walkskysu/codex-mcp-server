import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const model = args.includes('--model') ? value('--model') : '';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString('utf8');
await writeFile('invocation.json', JSON.stringify({ args, prompt, cwd: process.cwd(), pid: process.pid }));
if (model === 'fixture-fail') { console.error('fixture authentication failure'); process.exit(7); }
if (model === 'fixture-hang') await new Promise(() => setInterval(() => {}, 1000));
if (model === 'fixture-delay') await new Promise((resolve) => setTimeout(resolve, 300));
if (model === 'fixture-flood') process.stdout.write('x'.repeat(3 * 1024 * 1024));
if (model === 'fixture-missing-response') process.exit(0);
await writeFile(value('--output-last-message'), model === 'fixture-empty' ? '' : `Reply: ${prompt}`);
if (args.includes('workspace-write') && model !== 'fixture-no-image') {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6l1sAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(process.cwd(), 'output.png'), model === 'fixture-invalid-image' ? 'not an image' :
    model === 'fixture-large-image' ? Buffer.alloc(11 * 1024 * 1024) : png);
}
