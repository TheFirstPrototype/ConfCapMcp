import http from "node:http";
import { AddressInfo } from "node:net";
import { ApiClient, Clock } from "../src/api.js";
import { Config } from "../src/config.js";

export const KEY = "cck_TESTKEY0123456789abcdefghijklmnopqrstuv";
export const AUTH = "SECUREcode_abcdef123456";

export interface Recorded { method: string; path: string; query: Record<string, string>; headers: http.IncomingHttpHeaders }
type Handler = (req: Recorded, res: http.ServerResponse) => void;

/** A real HTTP server standing in for the API, recording every request it gets. */
const open = new Set<() => Promise<void>>();
/** Closes every mock still open, so a failing test cannot leave the process hanging. */
export async function closeAll() { await Promise.all([...open].map((c) => c())); open.clear(); }

export async function startMock(handler: Handler) {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const rec = { method: req.method!, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers };
    requests.push(rec);
    handler(rec, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  open.add(close);
  return { url, requests, close };
}

export function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** A clock that never really waits: sleeping just advances time, so retry and rate-limit tests are instant. */
export function fakeClock(): Clock & { t: number; sleeps: number[] } {
  const c = { t: 1_000_000, sleeps: [] as number[], now() { return c.t; }, async sleep(ms: number) { c.sleeps.push(ms); c.t += ms; } };
  return c;
}

export function clientFor(config: Config, clock = fakeClock()) {
  return { api: new ApiClient(config, fetch, clock), clock };
}

export const liveBody = (over: Record<string, unknown> = {}) => ({
  timestamp: "2026-10-28T09:00:00", roomName: "mtw", description: "Keynote", transcript: "Hello everyone and welcome.", transcriptCursor: 27,
  isActivelyStreaming: true, translation: "Hola a todos y bienvenidos.", translation2: "مرحبا بالجميع", inputLanguage: "en-US",
  outputLanguage: "es-ES", outputLanguage2: "ar-SA", ...over,
});

export const historyRows = [
  { id: 1, startTimestamp: "2026-10-28T09:00:00", endTimestamp: "2026-10-28T10:00:00", roomName: "mtw", uid: null, transcript: "A".repeat(2500), inputLanguage: "en", title: "Opening", description: "Welcome", isHidden: false },
  { id: 2, startTimestamp: "2026-10-28T11:00:00", endTimestamp: "2026-10-28T12:00:00", roomName: "mtw", uid: null, transcript: "Second session", inputLanguage: "en", title: null, description: null, isHidden: true },
];
