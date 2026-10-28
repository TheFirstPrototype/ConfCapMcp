import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApp } from "../src/http.js";
import { closeAll, startMock, json, KEY, AUTH, liveBody } from "./helpers.js";

const servers: http.Server[] = [];
afterEach(async () => { await closeAll(); await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }))); });

async function hosted(apiHandler: Parameters<typeof startMock>[0], opts: Parameters<typeof createHttpApp>[0] = {}) {
  const api = await startMock(apiHandler);
  const app = createHttpApp({ baseUrl: api.url, ...opts });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  servers.push(app);
  const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  return { url, api };
}
const OTHER_KEY = "cck_OTHERKEY123456789abcdefghijklmnopqrstuv";

async function connect(url: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: "t", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp"), { requestInit: { headers } }));
  return client;
}
const textOf = (r: any) => r.content[0].text as string;
const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(url + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body });

const gate = (r: any, res: any) => {
  if (r.path === "/stream/LiteGetStream") return json(res, 200, r.headers.authorization ? liveBody() : { roomName: "mtw", authRequired: true }, { ETag: '"e"' });
  if (r.path === "/developerkey/Me") return r.headers.authorization === `Bearer ${KEY}` ? json(res, 200, { streams: ["mtw"] }) : json(res, 401, {});
  return json(res, 200, {});
};

test("health check answers, other paths are 404 and GET /mcp is refused (stateless, no streams)", async () => {
  const { url } = await hosted(gate);
  assert.equal((await fetch(url + "/healthz")).status, 200);
  assert.equal((await fetch(url + "/nothing")).status, 404);
  const get = await fetch(url + "/mcp");
  assert.equal(get.status, 405); assert.equal(get.headers.get("allow"), "POST");
});

test("works over HTTP end to end with the key from the Authorization header, and sends it on to the API", async () => {
  const { url, api } = await hosted(gate);
  const client = await connect(url, { Authorization: `Bearer ${KEY}` });
  assert.equal((await client.listTools()).tools.length, 7);
  assert.deepEqual(JSON.parse(textOf(await client.callTool({ name: "list_my_streams", arguments: {} }))), { streams: ["mtw"] });
  assert.match(textOf(await client.callTool({ name: "get_live_captions", arguments: {} })), /Hello everyone/); // default stream: the only one the key owns
  assert.ok(api.requests.some((r) => r.headers.authorization === `Bearer ${KEY}`));
  await client.close();
});

test("without a key only public data works, and owner tools say a key is needed", async () => {
  const { url } = await hosted(gate);
  const client = await connect(url, { "X-Confcap-Stream": "mtw" });
  assert.match(textOf(await client.callTool({ name: "get_live_captions", arguments: {} })), /authRequired/);
  const r: any = await client.callTool({ name: "list_saved_transcripts", arguments: {} });
  assert.equal(r.isError, true); assert.match(textOf(r), /developer API key is required/);
  // the hosted server must tell the person to send a header, never to set an environment variable they cannot reach
  assert.match(textOf(r), /Authorization: Bearer cck_/); assert.match(textOf(r), /claude mcp add --transport http/); assert.doesNotMatch(textOf(r), /CONFCAP_KEY/);
  assert.match(textOf(await client.callTool({ name: "get_live_captions", arguments: {} })), /X-Confcap-Auth/);
  await client.close();
});

test("callers never see each other's cached text", async () => {
  const { url } = await hosted(gate);
  const owner = await connect(url, { Authorization: `Bearer ${KEY}`, "X-Confcap-Stream": "mtw" });
  const anon = await connect(url, { "X-Confcap-Stream": "mtw" });
  assert.match(textOf(await owner.callTool({ name: "get_live_captions", arguments: {} })), /Hello everyone/);
  const seen = textOf(await anon.callTool({ name: "get_live_captions", arguments: {} }));
  assert.match(seen, /authRequired/); assert.ok(!seen.includes("Hello everyone"));
  await owner.close(); await anon.close();
});

test("X-Confcap-Auth is passed to the API as the secure code, and only to the caption endpoint", async () => {
  const { url, api } = await hosted(gate);
  const client = await connect(url, { "X-Confcap-Stream": "mtw", "X-Confcap-Auth": AUTH });
  await client.callTool({ name: "get_live_captions", arguments: {} }); await client.callTool({ name: "get_stream_context", arguments: {} });
  for (const r of api.requests) assert.equal(r.query.auth, r.path === "/stream/LiteGetStream" ? AUTH : undefined, r.path);
  await client.close();
});

test("a bad Authorization header is refused before anything reaches the API, and the key text is never echoed", async () => {
  const { url, api } = await hosted(gate);
  for (const bad of ["Bearer not-a-key", "Bearer " + "x".repeat(300), "Basic abc"]) {
    const res = await post(url, "{}", { Authorization: bad });
    assert.equal(res.status, 401, bad); assert.ok(!(await res.text()).includes("x".repeat(50)));
  }
  assert.equal(api.requests.length, 0);
});

test("invalid JSON and oversized bodies get clear errors that never echo credentials", async () => {
  const { url } = await hosted(gate);
  const bad = await post(url, "{not json", { Authorization: `Bearer ${KEY}` });
  assert.equal(bad.status, 400); assert.ok(!(await bad.text()).includes(KEY));
  const big = await post(url, JSON.stringify({ pad: "a".repeat(300_000) }), { Authorization: `Bearer ${KEY}` });
  assert.equal(big.status, 413);
});

test("each caller is limited per minute, separately, and the limit resets", async () => {
  let t = 1_000_000;
  const { url } = await hosted(gate, { perMinute: 3, now: () => t });
  const call = (k: string) => post(url, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), { Authorization: `Bearer ${k}` });
  for (let i = 0; i < 3; i++) assert.equal((await call(KEY)).status, 200);
  const limited = await call(KEY);
  assert.equal(limited.status, 429); assert.ok(limited.headers.get("retry-after"));
  assert.equal((await call(OTHER_KEY)).status, 200); // another caller is not affected
  t += 61_000;
  assert.equal((await call(KEY)).status, 200);        // the window moved on
});

test("anonymous callers are limited per address, and the first X-Forwarded-For hop counts only behind a trusted proxy", async () => {
  const { url } = await hosted(gate, { perMinute: 2 });
  const call = (h: Record<string, string> = {}) => post(url, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), h);
  assert.equal((await call({ "X-Forwarded-For": "1.1.1.1" })).status, 200);
  assert.equal((await call({ "X-Forwarded-For": "2.2.2.2" })).status, 200);
  assert.equal((await call({ "X-Forwarded-For": "3.3.3.3" })).status, 429); // not trusted: spoofing the header does not help
  const trusted = await hosted(gate, { perMinute: 2, trustProxy: true });
  const callT = (ip: string) => post(trusted.url, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), { "X-Forwarded-For": ip });
  assert.equal((await callT("1.1.1.1")).status, 200); assert.equal((await callT("1.1.1.1")).status, 200);
  assert.equal((await callT("1.1.1.1")).status, 429);
  assert.equal((await callT("9.9.9.9")).status, 200);
});

test("the server keeps no session: no Mcp-Session-Id is issued", async () => {
  const { url } = await hosted(gate);
  const res = await post(url, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  assert.equal(res.status, 200); assert.equal(res.headers.get("mcp-session-id"), null);
});
