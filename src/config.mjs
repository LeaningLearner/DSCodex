import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { MANAGED_MARKER } from "./constants.mjs";
import { syncCatalog } from "./catalog.mjs";

const ROOT_KEYS = new Set(["openai_base_url", "model_catalog_json"]);
const DESKTOP_KEY = "enabled-reasoning-efforts";
const REASONING_EFFORTS = '["low", "medium", "high", "xhigh", "max", "ultra"]';

function keyOf(line) {
  return /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1] ?? null;
}

function firstTableIndex(lines) {
  const index = lines.findIndex((line) => /^\s*\[/.test(line));
  return index === -1 ? lines.length : index;
}

function quoteToml(value) {
  return JSON.stringify(value);
}

export function stripManagedConfig(content) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== MANAGED_MARKER) {
      kept.push(lines[index]);
      continue;
    }
    let next = index + 1;
    while (next < lines.length) {
      const key = keyOf(lines[next]);
      if (!ROOT_KEYS.has(key) && key !== DESKTOP_KEY) break;
      next += 1;
    }
    index = next - 1;
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

function assertNoRootConflict(content) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const rootEnd = firstTableIndex(lines);
  for (let index = 0; index < rootEnd; index += 1) {
    const key = keyOf(lines[index]);
    if (ROOT_KEYS.has(key)) {
      throw new Error(`Refusing to replace user-owned root key: ${key}`);
    }
  }
}

function injectRoot(content, { port, catalogPath }) {
  const lines = content.split("\n");
  const insertAt = firstTableIndex(lines);
  const block = [
    MANAGED_MARKER,
    `openai_base_url = "http://127.0.0.1:${port}/v1"`,
    `model_catalog_json = ${quoteToml(catalogPath)}`,
  ];
  lines.splice(insertAt, 0, ...block);
  return lines.join("\n");
}

function injectDesktopReasoning(content) {
  const lines = content.split("\n");
  const desktopStart = lines.findIndex((line) => /^\s*\[desktop\]\s*$/.test(line));
  if (desktopStart === -1) {
    const suffix = content.endsWith("\n") ? "" : "\n";
    return `${content}${suffix}\n[desktop]\n${MANAGED_MARKER}\n${DESKTOP_KEY} = ${REASONING_EFFORTS}\n`;
  }
  let desktopEnd = lines.findIndex((line, index) => index > desktopStart && /^\s*\[/.test(line));
  if (desktopEnd === -1) desktopEnd = lines.length;
  for (let index = desktopStart + 1; index < desktopEnd; index += 1) {
    if (keyOf(lines[index]) !== DESKTOP_KEY) continue;
    if (/\bmax\b/.test(lines[index])) return content;
    throw new Error(`Existing [desktop].${DESKTOP_KEY} does not expose max; update it manually`);
  }
  let insertAt = desktopEnd;
  while (insertAt > desktopStart + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
  lines.splice(insertAt, 0, MANAGED_MARKER, `${DESKTOP_KEY} = ${REASONING_EFFORTS}`);
  return lines.join("\n");
}

export function buildInstalledConfig(content, options) {
  const clean = stripManagedConfig(content);
  assertNoRootConflict(clean);
  return injectDesktopReasoning(injectRoot(clean, options));
}

function atomicWrite(path, content, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.dscodex-tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, path);
}

export function install({ paths, port }) {
  mkdirSync(dirname(paths.config), { recursive: true });
  const original = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "";
  const configured = buildInstalledConfig(original, { port, catalogPath: paths.catalog });
  const catalog = syncCatalog({ cachePath: paths.cache, catalogPath: paths.catalog });
  if (!existsSync(paths.backup) && existsSync(paths.config)) {
    copyFileSync(paths.config, paths.backup);
  }
  atomicWrite(paths.config, configured.endsWith("\n") ? configured : `${configured}\n`);
  return { catalog, configPath: paths.config, catalogPath: paths.catalog };
}

export function uninstall({ paths }) {
  if (existsSync(paths.config)) {
    const current = readFileSync(paths.config, "utf8");
    const stripped = stripManagedConfig(current);
    atomicWrite(paths.config, stripped.endsWith("\n") ? stripped : `${stripped}\n`);
  }
  if (existsSync(paths.catalog)) unlinkSync(paths.catalog);
  if (existsSync(paths.selectionState)) unlinkSync(paths.selectionState);
  if (existsSync(paths.bridgeShim)) unlinkSync(paths.bridgeShim);
}
