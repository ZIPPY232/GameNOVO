// Packages the desktop app: node pack.mjs [win32|linux|darwin] [x64|arm64]
// Requires the standalone build (npm run build:standalone at the repo root).
import { packager } from '@electron/packager';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'dist-standalone', 'index.html');
if (!existsSync(src)) throw new Error('dist-standalone/index.html not found: run "npm run build:standalone" first');
rmSync(join(here, 'app'), { recursive: true, force: true });
mkdirSync(join(here, 'app'));
cpSync(src, join(here, 'app', 'index.html'));

const platform = process.argv[2] ?? 'win32';
const arch = process.argv[3] ?? 'x64';
const paths = await packager({
  dir: here,
  out: join(here, 'out'),
  overwrite: true,
  platform,
  arch,
  name: 'Horizonte Voxel',
  executableName: 'HorizonteVoxel',
  appCopyright: 'Horizonte Voxel',
  asar: true,
  prune: true,
  ignore: [/^\/out($|\/)/, /^\/pack\.mjs$/, /^\/node_modules($|\/)/],
});
console.log(paths.join('\n'));
