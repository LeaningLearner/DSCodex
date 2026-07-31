import http from "node:http";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { Readable } from "node:stream";
import {
  CHATGPT_CODEX_BASE_URL,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_PICKER_SLUG,
  DEEPSEEK_WIRE_MODEL,
} from "./constants.mjs";

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

function decodeBody(buffer, encoding) {
  switch ((encoding ?? "").toLowerCase()) {
    case "gzip": return gunzipSync(buffer);
    case "deflate": return inflateSync(buffer);
    case "br": return brotliDecompressSync(buffer);
    case "zstd": return zstdDecompressSync(buffer);
    case "":
    case "identity": return buffer;
    default: throw new Error(`Unsupported content-encoding: ${encoding}`);
  }
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
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
} = {}) {
  const server = http.createServer(async (request, response) => {
    const startedAt = Date.now();
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { ok: true, deepseek_key: Boolean(deepSeekKey) });
      return;
    }
    if (request.method === "GET" && (url.pathname === "/models" || url.pathname === "/v1/models")) {
      json(response, 200, { models });
      return;
    }
    if (request.method !== "POST") {
      json(response, 405, { error: { message: "DSCodex accepts POST Responses API requests only" } });
      return;
    }

    try {
      const raw = await readRequestBody(request);
      const decoded = decodeBody(raw, request.headers["content-encoding"]);
      const parsed = JSON.parse(decoded.toString("utf8"));
      const deepSeek = isDeepSeekModel(parsed.model);
      if (deepSeek && !deepSeekKey) {
        json(response, 503, { error: { message: "DEEPSEEK_API_KEY is not configured in the DSCodex server process" } });
        return;
      }

      const outgoingBody = deepSeek
        ? Buffer.from(JSON.stringify(buildDeepSeekBody(parsed)))
        : raw;
      const baseUrl = deepSeek ? deepSeekBaseUrl : chatGptBaseUrl;
      const target = new URL(`${baseUrl.replace(/\/$/, "")}${upstreamPath(url.pathname)}${url.search}`);
      const headers = copyRequestHeaders(request, deepSeek ? deepSeekKey : undefined);
      if (!deepSeek && request.headers["content-encoding"]) {
        headers.set("content-encoding", request.headers["content-encoding"]);
      }
      headers.set("content-length", String(outgoingBody.length));

      const upstream = await fetch(target, {
        method: "POST",
        headers,
        body: outgoingBody,
        redirect: "manual",
      });
      response.statusCode = upstream.status;
      response.statusMessage = upstream.statusText;
      copyResponseHeaders(upstream, response);
      logger.info?.(`${deepSeek ? "deepseek" : "chatgpt"} ${url.pathname} -> ${upstream.status} ${Date.now() - startedAt}ms`);
      if (!upstream.body) {
        response.end();
        return;
      }
      Readable.fromWeb(upstream.body).pipe(response);
    } catch (error) {
      logger.error?.(`proxy error: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) {
        json(response, 502, { error: { message: "DSCodex upstream request failed" } });
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    }
  });
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
  });
  return server;
}
