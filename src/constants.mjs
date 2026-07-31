import { homedir } from "node:os";
import { join } from "node:path";

export const VERSION = "0.1.0";
export const DEFAULT_PORT = 10110;
export const HOST = "127.0.0.1";
export const DEEPSEEK_PICKER_SLUG = "deepseek/deepseek-v4-flash";
export const DEEPSEEK_WIRE_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const MANAGED_MARKER = "# DSCodex managed; remove with `dscodex uninstall`";

export function resolveCodexHome(env = process.env) {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

export function pathsFor(codexHome) {
  return {
    config: join(codexHome, "config.toml"),
    cache: join(codexHome, "models_cache.json"),
    catalog: join(codexHome, "dscodex-models.json"),
    backup: join(codexHome, "config.toml.pre-dscodex.bak"),
    stateDir: join(codexHome, "dscodex"),
    pid: join(codexHome, "dscodex", "server.pid"),
    log: join(codexHome, "dscodex", "server.log"),
  };
}
