import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const FIELD = "deepseek_api_key";

export function readStoredKey(keyFile) {
  if (!existsSync(keyFile)) return "";
  try {
    const parsed = JSON.parse(readFileSync(keyFile, "utf8"));
    return typeof parsed?.[FIELD] === "string" ? parsed[FIELD].trim() : "";
  } catch {
    return "";
  }
}

export function writeStoredKey(keyFile, key) {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("Empty DeepSeek API key");
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  const temporary = `${keyFile}.dscodex-tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ [FIELD]: trimmed }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, keyFile);
}

export function deleteStoredKey(keyFile) {
  if (existsSync(keyFile)) unlinkSync(keyFile);
}
