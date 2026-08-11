// Build a self-contained static site into dist/.
//
// The game is written with absolute paths (/src, /shared, /vendor) because the
// dev server serves it from the root. GitHub Pages serves project sites from a
// sub-path, so every absolute reference is rewritten to a relative one here.
// Nothing else about the game changes — there is no bundler and no transpiler.

import { cp, mkdir, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

// Files that exist only for local authoring.
const DEV_ONLY = new Set(['preview.html', 'preview.js']);

const ABSOLUTE_PREFIXES = ['/shared/', '/vendor/', '/assets/', '/css/', '/src/'];

/** How many directories deep a file sits inside dist. */
function relativePrefix(fileAbs) {
  const rel = path.relative(DIST, fileAbs);
  const depth = rel.split(path.sep).length - 1;
  return depth === 0 ? './' : '../'.repeat(depth);
}

function rewrite(source, prefix) {
  let out = source;
  for (const abs of ABSOLUTE_PREFIXES) {
    // Only rewrite inside quotes, so prose and comments are left alone.
    const re = new RegExp(`(["'\`])${abs}`, 'g');
    out = out.replace(re, (_m, q) => `${q}${prefix}${abs.slice(1)}`);
  }
  return out;
}

async function walk(dir, fn) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, fn);
    else await fn(full);
  }
}

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // Client, shared simulation, and three.js.
  await cp(path.join(ROOT, 'public'), DIST, { recursive: true });
  await cp(path.join(ROOT, 'shared'), path.join(DIST, 'shared'), { recursive: true });
  await cp(
    path.join(ROOT, 'node_modules', 'three', 'build'),
    path.join(DIST, 'vendor', 'three'),
    { recursive: true }
  );
  await cp(
    path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm'),
    path.join(DIST, 'vendor', 'three', 'addons'),
    { recursive: true }
  );

  for (const name of DEV_ONLY) {
    await rm(path.join(DIST, name), { force: true });
    await rm(path.join(DIST, 'src', name), { force: true });
  }

  // Rewrite our own sources. three and peerjs are left untouched: they use
  // relative imports internally and never reference this project's paths.
  let rewritten = 0;
  await walk(DIST, async (file) => {
    if (file.includes(`${path.sep}vendor${path.sep}`)) return;
    if (!/\.(js|html|css)$/i.test(file)) return;
    const prefix = relativePrefix(file);
    const src = await readFile(file, 'utf8');
    const out = rewrite(src, prefix);
    if (out !== src) { await writeFile(file, out); rewritten++; }
  });

  // GitHub Pages otherwise runs the site through Jekyll, which drops
  // directories beginning with an underscore and slows every deploy down.
  await writeFile(path.join(DIST, '.nojekyll'), '');

  // Single-page fallback so a deep link still loads the game.
  const indexHtml = await readFile(path.join(DIST, 'index.html'), 'utf8');
  await writeFile(path.join(DIST, '404.html'), indexHtml);

  let files = 0, bytes = 0;
  await walk(DIST, async (f) => { files++; bytes += (await stat(f)).size; });
  console.log(`dist/ built — ${files} files, ${(bytes / 1e6).toFixed(1)} MB, ${rewritten} rewritten`);
}

main().catch((err) => { console.error(err); process.exit(1); });
