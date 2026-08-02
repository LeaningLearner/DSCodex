import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { Readable } from "node:stream";
import {
  CHATGPT_CODEX_BASE_URL,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_PICKER_SLUG,
  DEEPSEEK_WIRE_MODEL,
} from "./constants.mjs";
import { createVisionDescriber } from "./vision.mjs";

const FORWARDED_REQUEST_HEADERS = new Set([
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "user-agent",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DECODED_BYTES = 128 * 1024 * 1024;
const SHUTDOWN_HEADER = "x-dscodex-shutdown-token";
const SHUTDOWN_PATH = "/_dscodex/shutdown";

function isDeepSeekModel(model) {
  return model === DEEPSEEK_PICKER_SLUG || model === DEEPSEEK_WIRE_MODEL;
}

function convertInputItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const converted = { ...item };
  delete converted.id;
  if (converted.type === "agent_message") {
    converted.type = "message";
    converted.role = "assistant";
  }
  return converted;
}

export function buildDeepSeekBody(input) {
  const body = structuredClone(input);
  const requestedEffort = body.reasoning?.effort;
  body.model = DEEPSEEK_WIRE_MODEL;
  body.store = false;
  body.reasoning = {
    ...(body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {}),
    effort: ["low", "medium", "high"].includes(requestedEffort) ? "high" : "max",
  };
  delete body.reasoning.summary;
  delete body.reasoning.generate_summary;
  delete body.reasoning.context;
  delete body.previous_response_id;
  delete body.conversation;
  delete body.background;
  delete body.metadata;
  delete body.service_tier;
  if (Array.isArray(body.input)) body.input = body.input.map(convertInputItem);
  return body;
}

function decodeBody(buffer, encoding, maxOutputLength) {
  const options = { maxOutputLength };
  switch ((encoding ?? "").toLowerCase()) {
    case "gzip": return gunzipSync(buffer, options);
    case "deflate": return inflateSync(buffer, options);
    case "br": return brotliDecompressSync(buffer, options);
    case "zstd": return zstdDecompressSync(buffer, options);
    case "":
    case "identity": return buffer;
    default: throw new Error(`Unsupported content-encoding: ${encoding}`);
  }
}

async function readRequestBody(request, maxBytes) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    request.resume();
    const error = new Error("Request body exceeds the configured limit");
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      request.resume();
      const error = new Error("Request body exceeds the configured limit");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validRouterToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

function tokenMatches(candidate, expected) {
  const actual = Buffer.from(candidate ?? "", "utf8");
  const target = Buffer.from(expected, "utf8");
  return actual.length === target.length && timingSafeEqual(actual, target);
}

function authorizedPath(pathname, routerToken) {
  const firstSlash = pathname.indexOf("/", 1);
  const candidate = firstSlash === -1 ? pathname.slice(1) : pathname.slice(1, firstSlash);
  if (!tokenMatches(candidate, routerToken)) return null;
  return firstSlash === -1 ? "/" : pathname.slice(firstSlash) || "/";
}

function copyRequestHeaders(request, deepSeekKey) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!FORWARDED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("content-type", "application/json");
  headers.set("accept", request.headers.accept ?? "text/event-stream");
  if (deepSeekKey) headers.set("authorization", `Bearer ${deepSeekKey}`);
  return headers;
}

function copyResponseHeaders(upstream, response) {
  for (const [name, value] of upstream.headers) {
    if (!HOP_BY_HOP_HEADERS.has(name)) response.setHeader(name, value);
  }
}

function json(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
  });
  response.end(body);
}

function upstreamPath(pathname) {
  return pathname.startsWith("/v1/") ? pathname.slice(3) : pathname;
}

export function createProxyServer({
  deepSeekKey = process.env.DEEPSEEK_API_KEY,
  deepSeekBaseUrl = DEEPSEEK_BASE_URL,
  chatGptBaseUrl = CHATGPT_CODEX_BASE_URL,
  models = [],
  logger = console,
  visionModel,
  routerToken,
  shutdownToken = "",
  instanceId = "",
  onShutdown,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  maxDecodedBytes = DEFAULT_MAX_DECODED_BYTES,
} = {}) {
  if (!validRouterToken(routerToken)) throw new Error("DSCodex routerToken is required");
  if (shutdownToken && !validRouterToken(shutdownToken)) throw new Error("Invalid DSCodex shutdownToken");
  const vision = createVisionDescriber({ baseUrl: chatGptBaseUrl, model: visionModel, logger });
  const server = http.createServer(async (request, response) => {
    const startedAt = Date.now();
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = authorizedPath(url.pathname, routerToken);
    if (!pathname) {
      json(response, 404, { error: { message: "Not found" } });
      return;
    }
    if (request.method === "POST" && pathname === SHUTDOWN_PATH) {
      request.resume();
      if (!shutdownToken || !tokenMatches(request.headers[SHUTDOWN_HEADER], shutdownToken)) {
        json(response, 401, { error: { message: "Invalid shutdown token" } });
        return;
      }
      json(response, 202, { ok: true });
      if (typeof onShutdown === "function") {
        setImmediate(() => {
          try {
            onShutdown();
          } catch (error) {
            logger.error?.(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      }
      return;
    }
    if (request.method === "GET" && pathname === "/health") {
      json(response, 200, {
        ok: true,
        deepseek_key: Boolean(deepSeekKey),
        ...(instanceId ? { instance_id: instanceId } : {}),
      });
      return;
    }
    if (request.method === "GET" && (pathname === "/models" || pathname === "/v1/models")) {
      json(response, 200, { models });
      return;
    }
    if (request.method !== "POST") {
      json(response, 405, { error: { message: "DSCodex accepts POST Responses API requests only" } });
      return;
    }

    let direction = "unknown";
    try {
      const raw = await readRequestBody(request, maxRequestBytes);
      let decoded;
      try {
        decoded = decodeBody(raw, request.headers["content-encoding"], maxDecodedBytes);
      } catch (error) {
        if (error?.code === "ERR_BUFFER_TOO_LARGE") error.statusCode = 413;
        throw error;
      }
      if (decoded.length > maxDecodedBytes) {
        const error = new Error("Decoded request body exceeds the configured limit");
        error.statusCode = 413;
        throw error;
      }
      const parsed = JSON.parse(decoded.toString("utf8"));
      const deepSeek = isDeepSeekModel(parsed.model);
      direction = deepSeek ? "deepseek" : "chatgpt";
      if (deepSeek && !deepSeekKey) {
        json(response, 503, { error: { message: "DEEPSEEK_API_KEY is not configured in the DSCodex server process" } });
        return;
      }
      let outgoingBody = raw;
      if (deepSeek) {
        const body = buildDeepSeekBody(parsed);
        // DeepSeek V4 is text-only: borrow the caller's GPT OAuth to describe any
        // attached images, then inject the descriptions as plain input_text.
        const rewritten = await vision.rewriteImages(body, request.headers);
        if (rewritten) logger.info?.(`vision: described ${rewritten} image(s) for ${pathname}`);
        outgoingBody = Buffer.from(JSON.stringify(body));
      }
      const baseUrl = deepSeek ? deepSeekBaseUrl : chatGptBaseUrl;
      const target = new URL(`${baseUrl.replace(/\/$/, "")}${upstreamPath(pathname)}${url.search}`);
      const headers = copyRequestHeaders(request, deepSeek ? deepSeekKey : undefined);
      if (!deepSeek && request.headers["content-encoding"]) {
        headers.set("content-encoding", request.headers["content-encoding"]);
      }
      headers.set("content-length", String(outgoingBody.length));

      const controller = new AbortController();
      // A client that goes away mid-stream (cancel, retry after a disconnect) must
      // not leave the upstream request running.
      response.on("close", () => {
        if (!response.writableFinished) controller.abort();
      });
      const upstream = await fetch(target, {
        method: "POST",
        headers,
        body: outgoingBody,
        redirect: "manual",
        signal: controller.signal,
      });
      response.statusCode = upstream.status;
      response.statusMessage = upstream.statusText;
      copyResponseHeaders(upstream, response);
      logger.info?.(`${deepSeek ? "deepseek" : "chatgpt"} ${pathname} -> ${upstream.status} ${Date.now() - startedAt}ms`);
      if (!upstream.body) {
        response.end();
        return;
      }
      const stream = Readable.fromWeb(upstream.body);
      stream.on("error", (error) => {
        // Otherwise invisible: the client only sees a truncated SSE stream and
        // retries with "stream disconnected before completion".
        logger.error?.(`upstream stream ended early: ${error instanceof Error ? error.message : String(error)}`);
        response.destroy(error instanceof Error ? error : undefined);
      });
      stream.pipe(response);
    } catch (error) {
      logger.error?.(`proxy error (${direction} ${pathname}): ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent && !response.destroyed) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
        json(response, status, { error: { message: status === 413 ? "Request body too large" : "DSCodex upstream request failed" } });
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    }
  });
  // Node's default 5s keepAliveTimeout is far shorter than the ~90s idle timeout
  // of the Codex HTTP client's connection pool, so pooled loopback connections
  // were reused after the server had closed them — surfacing as
  // "stream disconnected before completion: error sending request" retries.
  // headersTimeout must stay above keepAliveTimeout.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
  });
  return server;
}
