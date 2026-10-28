import http from "node:http";
import { createHash } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ApiClient } from "./api.js";
import { Config, DEFAULT_BASE_URL, redact } from "./config.js";
import { createServer } from "./server.js";

const KEY_PATTERN = /^cck_[A-Za-z0-9_-]{20,100}$/;
const MAX_BODY_BYTES = 256 * 1024;

export interface HttpOptions {
  baseUrl?: string;
  /** Requests per minute for one caller (a developer key, or an address when there is no key). */
  perMinute?: number;
  /** Distinct callers whose API clients (and their caches) are kept at once. */
  maxClients?: number;
  /** Trust the first X-Forwarded-For hop (only behind a proxy you control, like nginx). */
  trustProxy?: boolean;
  now?: () => number;
}

/**
 * A stateless streamable-HTTP MCP endpoint. Every request carries its own credentials: `Authorization: Bearer cck_...` (a
 * developer API key) and optionally `X-Confcap-Stream` (default stream) and `X-Confcap-Auth` (a secured stream's code).
 * Nothing about a caller is stored beyond a small cache of API responses, kept per caller and never shared between callers.
 * Without a key only the public tools work.
 */
export function createHttpApp(options: HttpOptions = {}) {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const perMinute = options.perMinute ?? 60;
  const maxClients = options.maxClients ?? 200;
  const now = options.now ?? (() => Date.now());

  const clients = new Map<string, { api: ApiClient; config: Config; used: number }>(); // insertion order = least recently used first
  const hits = new Map<string, number[]>();

  function callerOf(req: http.IncomingMessage, key?: string): string {
    if (key) return "key:" + createHash("sha256").update(key).digest("hex").slice(0, 16);
    const forwarded = options.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    return "ip:" + (forwarded || req.socket.remoteAddress || "unknown");
  }

  function allowed(caller: string): boolean {
    const t = now();
    const recent = (hits.get(caller) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= perMinute) { hits.set(caller, recent); return false; }
    recent.push(t); hits.set(caller, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < 60_000)) hits.delete(k);
    return true;
  }

  function clientFor(caller: string, config: Config) {
    const fingerprint = caller + "|" + (config.auth ?? "") + "|" + (config.stream ?? "");
    const hit = clients.get(fingerprint);
    if (hit) { clients.delete(fingerprint); clients.set(fingerprint, hit); return hit; }
    const made = { api: new ApiClient(config), config, used: now() };
    clients.set(fingerprint, made);
    while (clients.size > maxClients) clients.delete(clients.keys().next().value!);
    return made;
  }

  async function readBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error("too large"), { status: 413 });
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : undefined;
  }

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (url.pathname !== "/mcp") return send(res, 404, { error: "Not found" });
      if (req.method !== "POST") return send(res, 405, { error: "Use POST" }, { Allow: "POST" }); // stateless: no server-sent streams

      const header = String(req.headers.authorization ?? "");
      const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
      // Any Authorization header must be a developer key: a client that sends something else expects to be authenticated.
      if (header && (bearer === undefined || !KEY_PATTERN.test(bearer))) return send(res, 401, { error: "The Authorization header must be a developer API key (cck_...). Create one in the portal under Advanced Settings." });
      const caller = callerOf(req, bearer);
      if (!allowed(caller)) return send(res, 429, { error: "Too many requests. Slow down." }, { "Retry-After": "30" });

      const config: Config = {
        baseUrl, key: bearer, hosted: true,
        auth: String(req.headers["x-confcap-auth"] ?? "").trim() || undefined,
        stream: String(req.headers["x-confcap-stream"] ?? "").trim().toLowerCase().slice(0, 100) || undefined,
      };
      const { api } = clientFor(caller, config);
      const server = createServer(config, api);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
      await server.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
    } catch (err) {
      const status = (err as { status?: number }).status ?? (err instanceof SyntaxError ? 400 : 500);
      // Never echo internals or credentials.
      if (!res.headersSent) send(res, status, { error: status === 413 ? "Request too large" : status === 400 ? "Invalid JSON" : "Internal error" });
      else res.end();
      if (status === 500) console.error("confcap-mcp http error:", redact(String((err as Error)?.message ?? err), {}));
    }
  });
}

export function startHttp(env: Record<string, string | undefined>) {
  const port = Number(env.PORT ?? 8787);
  const host = env.HOST ?? "127.0.0.1"; // behind nginx; never exposed directly
  const app = createHttpApp({ baseUrl: env.CONFCAP_API_URL, trustProxy: env.TRUST_PROXY === "1", perMinute: Number(env.RATE_PER_MINUTE) || 60 });
  app.listen(port, host, () => console.error(`confcap-mcp (http) listening on ${host}:${port}`));
  return app;
}
