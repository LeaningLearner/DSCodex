import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { DEEPSEEK_PICKER_SLUG } from "./constants.mjs";

const HIGH = {
  effort: "high",
  description: "DeepSeek thinking mode",
};
const MAX = {
  effort: "max",
  description: "Maximum DeepSeek thinking depth",
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function replaceIdentity(value) {
  if (typeof value !== "string") return value;
  return value
    .replaceAll("You are Codex, an agent based on GPT-5.", "You are Codex, powered by DeepSeek V4 Flash.")
    .replaceAll("You are Codex, based on GPT-5.", "You are Codex, powered by DeepSeek V4 Flash.");
}

export function buildDeepSeekCatalogEntry(template) {
  const entry = clone(template);
  entry.slug = DEEPSEEK_PICKER_SLUG;
  entry.display_name = "🐳 V4 Flash";
  entry.description = "DeepSeek V4 Flash via the native Responses API.";
  entry.default_reasoning_level = "max";
  entry.supported_reasoning_levels = [HIGH, MAX];
  entry.priority = 0;
  entry.visibility = "list";
  entry.supported_in_api = true;
  entry.prefer_websockets = false;
  entry.support_verbosity = true;
  entry.default_verbosity = "low";
  entry.apply_patch_tool_type = "freeform";
  entry.web_search_tool_type = "text";
  entry.input_modalities = ["text"];
  entry.supports_image_detail_original = false;
  entry.supports_parallel_tool_calls = true;
  entry.supports_search_tool = true;
  entry.tool_mode = null;
  entry.multi_agent_version = "v2";
  entry.use_responses_lite = false;
  entry.include_skills_usage_instructions = false;
  entry.context_window = 1_048_576;
  entry.max_context_window = 1_048_576;
  entry.effective_context_window_percent = 95;
  entry.auto_compact_token_limit = null;
  entry.default_reasoning_summary = "none";
  entry.supports_reasoning_summaries = false;
  entry.minimal_client_version = "0.144.0";
  entry.availability_nux = null;
  entry.upgrade = null;
  entry.experimental_supported_tools = [];
  entry.base_instructions = replaceIdentity(entry.base_instructions);
  if (entry.model_messages?.instructions_template) {
    entry.model_messages.instructions_template = replaceIdentity(entry.model_messages.instructions_template);
  }

  delete entry.additional_speed_tiers;
  delete entry.service_tiers;
  delete entry.default_service_tier;
  return entry;
}

export function buildCatalog(cache) {
  if (!Array.isArray(cache?.models) || cache.models.length === 0) {
    throw new Error("Codex models_cache.json has no model templates; open Codex once, then retry");
  }
  const nativeModels = cache.models.filter((model) => model?.slug !== DEEPSEEK_PICKER_SLUG);
  const template = nativeModels.find((model) => model?.slug === "gpt-5.6-sol") ?? nativeModels[0];
  return {
    models: [buildDeepSeekCatalogEntry(template), ...clone(nativeModels)],
  };
}

export function syncCatalog({ cachePath, catalogPath }) {
  const cache = JSON.parse(readFileSync(cachePath, "utf8"));
  const catalog = buildCatalog(cache);
  const temporary = `${catalogPath}.dscodex-tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, catalogPath);
  return catalog;
}
