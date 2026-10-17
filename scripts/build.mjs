// Builds the unpacked extension.
//   node scripts/build.mjs                build into dist/
//   node scripts/build.mjs --out <dir>    build somewhere else
//   node scripts/build.mjs --watch        rebuild scripts on change
import { build, context } from 'esbuild';
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const watch = args.includes('--watch');
const outArg = args.indexOf('--out');
const outdir = resolve(outArg >= 0 ? args[outArg + 1] : join(root, 'dist'));

const common = {
  bundle: true,
  target: 'chrome120',
  legalComments: 'none',
  sourcemap: watch ? 'inline' : false,
  logLevel: 'warning',
};

const entries = [
  { entryPoints: [join(root, 'src/content/index.ts')], outfile: join(outdir, 'content.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/background/index.ts')], outfile: join(outdir, 'background.js'), format: 'esm' },
  { entryPoints: [join(root, 'src/popup/popup.ts')], outfile: join(outdir, 'popup.js'), format: 'iife' },
];

const exists = (path) => access(path).then(() => true, () => false);

/** Empties the output directory, refusing to touch anything that isn't a previous build. */
async function clean() {
  if (!(await exists(outdir))) return;
  const entriesInDir = await readdir(outdir);
  if (entriesInDir.length && !entriesInDir.includes('manifest.json')) {
    throw new Error(`${outdir} is not empty and doesn't look like a Scribblr build; not overwriting it.`);
  }
  await rm(outdir, { recursive: true, force: true });
}

async function copyStatic() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'src/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  await writeFile(join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await cp(join(root, 'src/content/content.css'), join(outdir, 'content.css'));
  await cp(join(root, 'src/popup/popup.css'), join(outdir, 'popup.css'));
  const html = await readFile(join(root, 'src/popup/popup.html'), 'utf8');
  await writeFile(join(outdir, 'popup.html'), html);
  await writeFile(join(outdir, 'options.html'), html.replace('<body>', '<body class="page">'));
  await cp(join(root, 'src/icons'), join(outdir, 'icons'), { recursive: true });
}

await clean();
await mkdir(outdir, { recursive: true });
await copyStatic();

if (watch) {
  for (const entry of entries) await (await context({ ...common, ...entry })).watch();
  console.log(`Watching for changes; output in ${outdir}. Reload the extension in chrome://extensions after a rebuild.`);
} else {
  await Promise.all(entries.map((entry) => build({ ...common, ...entry })));
  console.log(`Built the extension into ${outdir}`);
}
