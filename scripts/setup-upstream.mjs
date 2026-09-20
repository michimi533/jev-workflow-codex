// Run from Node CLI. This fetches a pinned dependency; it does not call Jev or a browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor', 'jev-cu');
const revision = 'fabec3c9ee456b8140f11c8895e62a15ad6b5379';
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tracked = git(['ls-files']);
// Never initialize over a repository which tracks the generated dependency files.
if (['scripts/loop.mjs', 'scripts/policy.mjs', 'scripts/jev-decide.mjs', 'tests/core.test.mjs']
    .some(p => tracked.split('\n').includes(p))) throw new Error('Dependency paths must be gitignored');
if (!fs.existsSync(vendor)) {
  fs.mkdirSync(path.dirname(vendor), { recursive: true });
  execFileSync('git', ['clone', '--no-checkout', 'https://github.com/Fortytwoo/Jev-cu.git', vendor], { stdio: 'inherit' });
  execFileSync('git', ['-C', vendor, 'checkout', '--detach', revision], { stdio: 'inherit' });
}
if (git(['-C', vendor, 'rev-parse', 'HEAD']) !== revision || git(['-C', vendor, 'status', '--porcelain'])) {
  throw new Error('Existing vendor checkout is modified or not at the pinned revision');
}
const read = relative => fs.readFileSync(path.join(vendor, relative), 'utf8').replaceAll('\r\n', '\n');
const generated = new Map();
let loop = read('scripts/loop.mjs');
if ((loop.match(/  "search field",/g) ?? []).length !== 2 ||
    !loop.includes('["text field", "search field"].includes')) throw new Error('Unexpected upstream AX parser');
loop = loop.replaceAll('  "search field",', '  "search text field",\n  "search field",')
  .replace('["text field", "search field"].includes', '["text field", "search field", "search text field"].includes');
generated.set('scripts/loop.mjs', loop);
generated.set('scripts/policy.mjs', read('scripts/policy.mjs'));
let api = read('scripts/jev-decide.mjs');
const marker = '      err.status = res.status;';
if (api.split(marker).length !== 2) throw new Error('Unexpected upstream error handling');
api = api.replace(marker, marker + `
      const retryAfter = res.headers?.get?.('retry-after');
      if (retryAfter != null) {
        const seconds = Number(retryAfter);
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(delay)) err.retryAfterMs = Math.max(0, delay);
      }`);
generated.set('scripts/jev-decide.mjs', api);
generated.set('tests/core.test.mjs', read('tests/core.test.mjs'));
for (const [relative, content] of generated) {
  const destination = path.join(root, relative);
  if (fs.existsSync(destination) && fs.readFileSync(destination, 'utf8').replaceAll('\r\n', '\n') !== content) {
    throw new Error(`Local dependency changed; review before replacing: ${relative}`);
  }
}
for (const [relative, content] of generated) fs.writeFileSync(path.join(root, relative), content);
fs.cpSync(path.join(vendor, 'fixtures'), path.join(root, 'fixtures'), { recursive: true, force: false });
console.log('Pinned Jev-cu dependency ready. Local patches: search text field; Retry-After. No API requests.');
