import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCatalog } from "../src/catalog.mjs";
import { buildInstalledConfig, install, stripManagedConfig, uninstall } from "../src/config.mjs";
import { pathsFor } from "../src/constants.mjs";

const TEMPLATE = {
  slug: "gpt-5.6-sol",
  display_name: "GPT-5.6-Sol",
  description: "native",
  default_reasoning_level: "low",
  supported_reasoning_levels: [{ effort: "low", description: "fast" }],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 1,
  base_instructions: "You are Codex, an agent based on GPT-5.",
  model_messages: { instructions_template: "You are Codex, an agent based on GPT-5." },
};

test("catalog adds one whale-labelled V4 Flash entry with honest reasoning levels", () => {
  const catalog = buildCatalog({ models: [TEMPLATE] });
  const model = catalog.models[0];
  assert.equal(model.slug, "deepseek/deepseek-v4-flash");
  assert.equal(model.display_name, "🐳 V4 Flash");
  assert.equal(model.default_reasoning_level, "max");
  assert.deepEqual(model.supported_reasoning_levels.map(({ effort }) => effort), ["high", "max"]);
  assert.equal(model.base_instructions, "You are Codex, powered by DeepSeek V4 Flash.");
  assert.deepEqual(model.input_modalities, ["text"]);
  assert.equal(model.prefer_websockets, false);
});

test("config injection is root-correct, reversible, and preserves user config", () => {
  const original = 'personality = "pragmatic"\n\n[features]\nmulti_agent = true\n\n[desktop]\ntheme = "light"\n';
  const installed = buildInstalledConfig(original, { port: 10110, catalogPath: "/tmp/models.json" });
  assert.ok(installed.indexOf("openai_base_url") < installed.indexOf("[features]"));
  assert.match(installed, /model_catalog_json = "\/tmp\/models\.json"/);
  assert.match(installed, /enabled-reasoning-efforts = \[.*"max".*\]/);
  assert.equal(stripManagedConfig(installed), original);
});

test("install and uninstall touch only DSCodex-owned files and lines", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-test-"));
  const paths = pathsFor(codexHome);
  const original = '[features]\nmulti_agent = true\n\n[desktop]\ntheme = "light"\n';
  writeFileSync(paths.config, original);
  writeFileSync(paths.cache, JSON.stringify({ models: [TEMPLATE] }));

  const result = install({ paths, port: 10110 });
  assert.equal(result.catalog.models.length, 2);
  assert.equal(existsSync(paths.backup), true);
  assert.equal(existsSync(paths.catalog), true);
  assert.match(readFileSync(paths.config, "utf8"), /DSCodex managed/);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.selectionState, "{}\n");
  writeFileSync(paths.bridgeShim, "#!/bin/sh\n");

  uninstall({ paths });
  assert.equal(existsSync(paths.catalog), false);
  assert.equal(existsSync(paths.selectionState), false);
  assert.equal(existsSync(paths.bridgeShim), false);
  assert.equal(readFileSync(paths.config, "utf8"), original);
  assert.equal(readFileSync(paths.backup, "utf8"), original);
});

test("refuses to replace a user-owned openai_base_url", () => {
  assert.throws(
    () => buildInstalledConfig('openai_base_url = "https://example.test/v1"\n', { port: 10110, catalogPath: "/tmp/models.json" }),
    /user-owned root key/,
  );
});
