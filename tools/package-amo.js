import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const runtimePaths = [
  '_locales', 'backup', 'blocked.html', 'diagnostics', 'dom', 'feedback', 'images',
  'index.html', 'manifest.json', 'onboarding', 'options', 'popup.js', 'pro',
  'redirect.html', 'rules', 'schedules', 'scripts', 'styles', 'telemetry', 'update', 'utils'
];

export function packageAmo(rootDir = fileURLToPath(new URL('..', import.meta.url))) {
  const git = args => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8' }).trim();
  const dirty = git(['status', '--porcelain', '--untracked-files=all', '--', ...runtimePaths]);
  if (dirty) throw new Error('Commit runtime changes before packaging AMO. The package is built from tracked HEAD.');
  const manifest = JSON.parse(git(['show', 'HEAD:manifest.json']));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid extension version.');
  if (!manifest.browser_specific_settings?.gecko?.id || manifest.background?.service_worker) {
    throw new Error('AMO packaging requires the Firefox manifest and extension ID.');
  }
  const tracked = git(['ls-tree', '-r', '--full-tree', 'HEAD', '--', ...runtimePaths])
    .split('\n').filter(Boolean).map(line => {
      const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/.exec(line);
      if (!match || match[1] !== '100644') throw new Error(`Unsupported runtime entry: ${line}`);
      return { path: match[3], gitBlob: match[2] };
    });
  for (const root of runtimePaths) {
    if (!tracked.some(file => file.path === root || file.path.startsWith(`${root}/`))) {
      throw new Error(`Required runtime path is missing from HEAD: ${root}`);
    }
  }
  const output = path.join(rootDir, 'dist');
  mkdirSync(output, { recursive: true });
  const filename = `BlockDistraction-${manifest.version}-amo.zip`;
  const archivePath = path.join(output, filename);
  execFileSync('git', ['archive', '--format=zip', '--output', archivePath, 'HEAD', '--', ...runtimePaths], { cwd: rootDir });
  const sha256 = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  writeFileSync(`${archivePath}.sha256`, `${sha256}  ${filename}\n`);
  const metadata = { version: manifest.version, extensionId: manifest.browser_specific_settings.gecko.id,
    commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']),
    filename, sha256, signed: false, runtimeFiles: tracked };
  writeFileSync(path.join(output, `${filename}.build.json`), JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = packageAmo();
  console.log(`Created: dist/${result.filename}\nCommit: ${result.commit}\nRuntime files: ${result.runtimeFiles.length}\nSHA-256: ${result.sha256}`);
}
