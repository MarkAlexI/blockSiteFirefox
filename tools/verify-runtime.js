import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Input is the extracted installed/store runtime, not a CRX signature claim.
export function verifyRuntime(metadata, rootDir) {
  const root = path.resolve(rootDir);
  const expected = new Map(metadata.runtimeFiles.map(file => [file.path, file.gitBlob]));
  if (!expected.size) throw new Error('Build metadata contains no runtime files.');
  const actual = new Set();
  const walk = (directory, prefix = '') => {
    for (const name of readdirSync(directory)) {
      const relative = prefix + name;
      const absolute = path.join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Symlink in runtime: ${relative}`);
      // Stores may add signature/integrity records; they are not source runtime.
      if (!prefix && ['META-INF', '_metadata'].includes(name) && stat.isDirectory()) continue;
      if (stat.isDirectory()) walk(absolute, relative + '/');
      else if (stat.isFile()) actual.add(relative);
      else throw new Error(`Unsupported runtime entry: ${relative}`);
    }
  };
  walk(root);
  for (const filename of expected.keys()) {
    if (!actual.has(filename)) throw new Error(`Missing runtime file: ${filename}`);
  }
  for (const filename of actual) {
    if (!expected.has(filename)) throw new Error(`Unexpected runtime file: ${filename}`);
    const bytes = readFileSync(path.join(root, filename));
    const reference = expected.get(filename);
    const algorithm = reference.length === 64 ? 'sha256' : 'sha1';
    const blob = createHash(algorithm).update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
    if (blob !== reference) throw new Error(`Runtime bytes differ: ${filename}`);
  }
  return { commit: metadata.commit, version: metadata.version, target: metadata.target || 'firefox', verifiedFiles: actual.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node tools/verify-runtime.js BUILD_JSON EXTRACTED_RUNTIME_DIR');
  console.log(JSON.stringify(verifyRuntime(JSON.parse(readFileSync(process.argv[2], 'utf8')), process.argv[3]), null, 2));
}
