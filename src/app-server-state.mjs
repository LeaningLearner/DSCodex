import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEEPSEEK_PICKER_SLUG, DEEPSEEK_WIRE_MODEL } from "./constants.mjs";

const VERSION = 1;
const STANDARD_TIER = "default";
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

function providerFor(model) {
  return model === DEEPSEEK_PICKER_SLUG || model === DEEPSEEK_WIRE_MODEL ? "deepseek" : "openai";
}

function normalizeEffort(provider, effort) {
  if (!VALID_EFFORTS.has(effort)) return null;
  if (provider === "deepseek") return effort === "high" ? "high" : "max";
  return effort;
}

function rootString(content, key) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const end = lines.findIndex((line) => /^\s*\[/.test(line));
  const root = end === -1 ? lines : lines.slice(0, end);
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`);
  for (const line of root) {
    const match = pattern.exec(line);
    if (match) return match[1];
  }
  return null;
}

function initialState(configPath) {
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const model = rootString(config, "model") ?? "gpt-5.6-sol";
  const activeProvider = providerFor(model);
  const effort = rootString(config, "model_reasoning_effort");
  const state = {
    version: VERSION,
    activeProvider,
    openai: {
      reasoningEffort: "high",
      serviceTier: rootString(config, "service_tier") ?? STANDARD_TIER,
    },
    deepseek: { reasoningEffort: "max" },
  };
  const normalized = normalizeEffort(activeProvider, effort);
  if (normalized) state[activeProvider].reasoningEffort = normalized;
  return state;
}

function loadState(statePath, configPath) {
  if (!existsSync(statePath)) return initialState(configPath);
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8"));
    if (value?.version !== VERSION) return initialState(configPath);
    return {
      version: VERSION,
      activeProvider: value.activeProvider === "deepseek" ? "deepseek" : "openai",
      openai: {
        reasoningEffort: normalizeEffort("openai", value.openai?.reasoningEffort) ?? "high",
        serviceTier: typeof value.openai?.serviceTier === "string"
          ? value.openai.serviceTier
          : STANDARD_TIER,
      },
      deepseek: {
        reasoningEffort: normalizeEffort("deepseek", value.deepseek?.reasoningEffort) ?? "max",
      },
    };
  } catch {
    return initialState(configPath);
  }
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.dscodex-tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}

function requestKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function keyName(keyPath) {
  return keyPath.split(".").at(-1);
}

function tierForThread(value) {
  return value === STANDARD_TIER ? null : value;
}

export function createAppServerState({ statePath, configPath }) {
  const state = loadState(statePath, configPath);
  const threads = new Map();
  const pending = new Map();

  function save() {
    atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  function rememberEffort(provider, effort) {
    const normalized = normalizeEffort(provider, effort);
    if (normalized) state[provider].reasoningEffort = normalized;
    return normalized;
  }

  function switchDefaults(model, incomingEffort) {
    const provider = providerFor(model);
    if (provider !== state.activeProvider) {
      state.activeProvider = provider;
      return state[provider].reasoningEffort;
    }
    return rememberEffort(provider, incomingEffort) ?? state[provider].reasoningEffort;
  }

  function rewriteConfigBatch(params) {
    if (!Array.isArray(params?.edits)) return;
    const modelEdit = params.edits.find((edit) => keyName(edit.keyPath) === "model");
    const effortEdit = params.edits.find((edit) => keyName(edit.keyPath) === "model_reasoning_effort");
    const tierEdit = params.edits.find((edit) => keyName(edit.keyPath) === "service_tier");
    if (modelEdit && typeof modelEdit.value === "string") {
      const effort = switchDefaults(modelEdit.value, effortEdit?.value);
      if (effortEdit) effortEdit.value = effort;
      else params.edits.push({
        keyPath: modelEdit.keyPath.replace(/model$/, "model_reasoning_effort"),
        value: effort,
        mergeStrategy: "upsert",
      });
    } else if (effortEdit) {
      const effort = rememberEffort(state.activeProvider, effortEdit.value);
      if (effort) effortEdit.value = effort;
    }
    if (tierEdit && state.activeProvider === "openai" && typeof tierEdit.value === "string") {
      state.openai.serviceTier = tierEdit.value;
    }
    save();
  }

  function rewriteConfigValue(params) {
    if (!params?.keyPath) return;
    const name = keyName(params.keyPath);
    if (name === "model" && typeof params.value === "string") {
      switchDefaults(params.value, null);
    } else if (name === "model_reasoning_effort") {
      const effort = rememberEffort(state.activeProvider, params.value);
      if (effort) params.value = effort;
    } else if (name === "service_tier" && state.activeProvider === "openai" && typeof params.value === "string") {
      state.openai.serviceTier = params.value;
    }
    save();
  }

  function rewriteThreadSettings(params) {
    if (!params?.threadId) return;
    const thread = threads.get(params.threadId) ?? {
      activeProvider: params.model ? providerFor(params.model) : state.activeProvider,
      model: params.model ?? null,
    };
    const provider = params.model ? providerFor(params.model) : thread.activeProvider;
    if (provider !== thread.activeProvider) {
      params.effort = state[provider].reasoningEffort;
      params.serviceTier = provider === "openai" ? tierForThread(state.openai.serviceTier) : null;
    } else {
      const effort = rememberEffort(provider, params.effort);
      if (effort) params.effort = effort;
      if (provider === "openai" && params.serviceTier !== undefined) {
        state.openai.serviceTier = params.serviceTier ?? STANDARD_TIER;
      }
    }
    thread.activeProvider = provider;
    if (params.model) thread.model = params.model;
    threads.set(params.threadId, thread);
    save();
  }

  function rewriteThreadStart(message) {
    const params = message.params ?? {};
    const model = params.model ?? params.config?.model;
    if (!model) return;
    const provider = providerFor(model);
    const incomingEffort = params.config?.model_reasoning_effort;
    const effort = switchDefaults(model, incomingEffort);
    params.config = { ...(params.config ?? {}), model_reasoning_effort: effort };
    params.serviceTier = provider === "openai" ? tierForThread(state.openai.serviceTier) : null;
    pending.set(requestKey(message.id), {
      kind: "thread",
      activeProvider: provider,
      model,
    });
    save();
  }

  function trackThreadRequest(message) {
    const params = message.params ?? {};
    if (!params.threadId) return;
    pending.set(requestKey(message.id), { kind: "resume", threadId: params.threadId });
  }

  function rewriteClient(message) {
    if (!message || typeof message !== "object") return message;
    switch (message.method) {
      case "config/batchWrite": rewriteConfigBatch(message.params); break;
      case "config/value/write": rewriteConfigValue(message.params); break;
      case "thread/start": rewriteThreadStart(message); break;
      case "thread/resume":
      case "thread/fork": trackThreadRequest(message); break;
      case "thread/settings/update": rewriteThreadSettings(message.params); break;
    }
    return message;
  }

  function rewriteServer(message) {
    if (!message || typeof message !== "object" || message.id === undefined) return message;
    const tracked = pending.get(requestKey(message.id));
    if (!tracked) return message;
    pending.delete(requestKey(message.id));
    if (message.error || !message.result) return message;
    const result = message.result;
    const threadId = result.thread?.id ?? tracked.threadId;
    const model = result.model ?? tracked.model;
    if (threadId && model) {
      const provider = providerFor(model);
      threads.set(threadId, { activeProvider: provider, model });
      rememberEffort(provider, result.reasoningEffort);
      if (provider === "openai" && result.serviceTier !== undefined) {
        state.openai.serviceTier = result.serviceTier ?? STANDARD_TIER;
      }
      save();
    }
    return message;
  }

  save();
  return { rewriteClient, rewriteServer };
}
