import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

async function readJson(relativePath) {
  const absolutePath = path.join(root, relativePath);

  try {
    return JSON.parse(await readFile(absolutePath, 'utf8'));
  } catch (error) {
    errors.push(`${relativePath}: invalid or unreadable JSON (${error.message})`);
    return null;
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(absolutePath));
    } else {
      files.push(absolutePath);
    }
  }

  return files;
}

function relative(absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

async function ensureFile(relativePath) {
  try {
    const info = await stat(path.join(root, relativePath));
    if (!info.isFile()) errors.push(`${relativePath}: expected a file`);
  } catch {
    errors.push(`${relativePath}: referenced file does not exist`);
  }
}

function collectManifestFiles(manifest) {
  const files = new Set();

  if (manifest?.background?.service_worker) {
    files.add(manifest.background.service_worker);
  }
  for (const backgroundScript of manifest?.background?.scripts || []) {
    files.add(backgroundScript);
  }
  if (manifest?.action?.default_popup) {
    files.add(manifest.action.default_popup);
  }
  if (manifest?.options_ui?.page) {
    files.add(manifest.options_ui.page);
  }

  for (const iconPath of Object.values(manifest?.icons || {})) {
    files.add(iconPath);
  }
  for (const iconPath of Object.values(manifest?.action?.default_icon || {})) {
    files.add(iconPath);
  }
  for (const resourceGroup of manifest?.web_accessible_resources || []) {
    for (const resource of resourceGroup.resources || []) {
      files.add(resource);
    }
  }

  return [...files];
}

function collectReferencedLocaleKeys(content) {
  const keys = new Set();
  const patterns = [
    /data-i18n=["']([^"']+)["']/g,
    /\bt\(\s*["']([^"']+)["']/g,
    /getMessage\(\s*["']([^"']+)["']/g,
    /setContent\([^,]+,\s*["']([^"']+)["']/g,
    /setAttribute\(\s*["']data-i18n["']\s*,\s*["']([^"']+)["']/g
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      keys.add(match[1]);
    }
  }

  return keys;
}

const manifest = await readJson('manifest.json');
const packageJson = await readJson('package.json');
const englishMessages = await readJson('_locales/en/messages.json');
const files = await walk(root);

for (const file of files.filter(file => file.endsWith('.json'))) {
  await readJson(relative(file));
}

if (manifest && packageJson && manifest.version !== packageJson.version) {
  errors.push(
    `Version mismatch: manifest.json=${manifest.version}, package.json=${packageJson.version}`
  );
}

if (manifest) {
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes('scripting')) {
    errors.push('manifest.json: Daily Limit visibility accounting requires the "scripting" permission');
  }

  for (const referencedFile of collectManifestFiles(manifest)) {
    await ensureFile(referencedFile);
  }

  const firefoxDataCollection =
    manifest.browser_specific_settings?.gecko?.data_collection_permissions;
  const requiredDataCollection = Array.isArray(firefoxDataCollection?.required) ?
    firefoxDataCollection.required : [];
  const optionalDataCollection = Array.isArray(firefoxDataCollection?.optional) ?
    firefoxDataCollection.optional : [];

  if (!requiredDataCollection.includes('none')) {
    errors.push(
      'manifest.json: Firefox data_collection_permissions.required must include "none"'
    );
  }
  if (!optionalDataCollection.includes('technicalAndInteraction')) {
    errors.push(
      'manifest.json: Firefox data_collection_permissions.optional must include "technicalAndInteraction"'
    );
  }

  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  const firstVersion = changelog.match(/^## \[([^\]]+)\]/m)?.[1];
  if (firstVersion !== manifest.version) {
    errors.push(
      `CHANGELOG.md: first version is ${firstVersion || 'missing'}, expected ${manifest.version}`
    );
  }
}

for (const file of files.filter(file => file.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    errors.push(`${relative(file)}: JavaScript syntax check failed\n${result.stderr.trim()}`);
  }
}

if (englishMessages) {
  const knownKeys = new Set(Object.keys(englishMessages));
  const referencedKeys = new Set();

  for (const file of files.filter(file => /\.(?:js|html)$/.test(file))) {
    const content = await readFile(file, 'utf8');
    for (const key of collectReferencedLocaleKeys(content)) {
      referencedKeys.add(key);
    }
  }

  for (const key of [...referencedKeys].sort()) {
    if (!knownKeys.has(key)) {
      errors.push(`Missing English localization key referenced by code: ${key}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`Extension validation failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Extension validation passed: ${files.length} files, version ${manifest?.version || 'unknown'}.`
);
