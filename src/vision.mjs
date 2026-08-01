import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { CHATGPT_CODEX_BASE_URL } from "./constants.mjs";

const DEFAULT_VISION_MODEL = "gpt-5.6-sol";
const MAX_CACHE_ENTRIES = 200;
const VISION_TIMEOUT_MS = 60_000;

const DESCRIBE_INSTRUCTIONS = [
  "You are the vision front-end for a text-only coding model.",
  "Describe the attached image with enough detail for that model to answer questions about it:",
  "transcribe all visible text, code, file paths, and error messages verbatim;",
  "describe the UI layout, controls, and spatial relationships when it is a screenshot;",
  "state what the image is (screenshot, diagram, photo, ...) in one line first.",
  "Be concise but complete; do not speculate beyond what is visible.",
].join(" ");

// Only the OAuth identity headers a ChatGPT Codex backend call needs; turn-scoped
// headers (x-codex-turn-*, thread-id) stay out so describes never touch turn state.
const VISION_REQUEST_HEADERS = new Set([
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "user-agent",
]);

function hashOf(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Collects every replaceable input_image part: pasted images live in
// message.content, view_image tool results in function_call_output.output.
function imageRefs(input) {
  const refs = [];
  if (!Array.isArray(input)) return refs;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    for (const key of ["content", "output"]) {
      const parts = item[key];
      if (!Array.isArray(parts)) continue;
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part?.type === "input_image" && typeof part.image_url === "string" && part.image_url.startsWith("data:")) {
          refs.push({ parts, index, dataUrl: part.image_url });
        }
      }
    }
  }
  return refs;
}

function headersFor(requestHeaders) {
  const headers = new Headers();
  for (const name of VISION_REQUEST_HEADERS) {
    const value = requestHeaders[name]; // Node lowercases incoming header names
    if (typeof value === "string" && value) headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  return headers;
}

function textFromCompleted(data) {
  try {
    const output = JSON.parse(data)?.response?.output;
    if (!Array.isArray(output)) return "";
    const chunks = [];
    for (const item of output) {
      if (!Array.isArray(item?.content)) continue;
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") chunks.push(part.text);
      }
    }
    return chunks.join("");
  } catch {
    return "";
  }
}

async function readDescription(body) {
  let deltas = "";
  let completed = "";
  let buffer = "";
  for await (const chunk of Readable.fromWeb(body)) {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const event = JSON.parse(data);
        if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
          deltas += event.delta;
        } else if (event?.type === "response.completed" && !completed) {
          completed = textFromCompleted(data);
        }
      } catch {
        // Ignore keep-alives and non-JSON SSE lines.
      }
    }
  }
  return (completed || deltas).trim();
}

export function createVisionDescriber({
  baseUrl = CHATGPT_CODEX_BASE_URL,
  model = process.env.DSCODEX_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL,
  logger = console,
} = {}) {
  // sha256(data URL) -> description; failures are cached as "" so Codex stream
  // retries do not re-issue a describe that just failed. Process-local, bounded.
  const cache = new Map();

  function remember(key, description) {
    cache.delete(key);
    cache.set(key, description);
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  }

  async function describe(dataUrl, headers) {
    const key = hashOf(dataUrl);
    if (cache.has(key)) return cache.get(key);
    let description = "";
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          instructions: DESCRIBE_INSTRUCTIONS,
          input: [{
            type: "message",
            role: "user",
            content: [{ type: "input_image", image_url: dataUrl }],
          }],
          store: false,
          stream: true,
        }),
        signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      });
      if (!response.ok) {
        logger.error?.(`vision describe failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
      } else {
        description = await readDescription(response.body);
        if (!description) logger.error?.("vision describe returned an empty description");
      }
    } catch (error) {
      logger.error?.(`vision describe error: ${error instanceof Error ? error.message : String(error)}`);
    }
    remember(key, description);
    return description;
  }

  // Replaces DeepSeek-bound input_image parts with GPT-generated text descriptions.
  // Needs the incoming request's ChatGPT OAuth headers; without them the body is
  // left untouched (pure API-key setups have no GPT vision to borrow).
  async function rewriteImages(body, requestHeaders) {
    if (typeof requestHeaders?.authorization !== "string" || !requestHeaders.authorization) return 0;
    const refs = imageRefs(body?.input);
    if (refs.length === 0) return 0;
    const headers = headersFor(requestHeaders);
    const unique = [...new Map(refs.map((ref) => [hashOf(ref.dataUrl), ref.dataUrl])).values()];
    const entries = await Promise.all(unique.map(async (dataUrl) => [hashOf(dataUrl), await describe(dataUrl, headers)]));
    const descriptions = new Map(entries);
    for (const ref of refs) {
      const description = descriptions.get(hashOf(ref.dataUrl));
      ref.parts[ref.index] = {
        type: "input_text",
        text: description
          ? `[image content, described by ${model} via DSCodex vision]\n${description}`
          : "[an image was attached, but DSCodex vision could not analyze it; answer as if the image is unavailable]",
      };
    }
    return refs.length;
  }

  return { rewriteImages };
}
