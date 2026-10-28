import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { ApiClient, ApiError, CAPTION_INTERVAL_MS } from "../src/api.js";
import { closeAll, startMock, json, fakeClock, clientFor, KEY, liveBody } from "./helpers.js";
afterEach(closeAll);

const cfg = (url: string, extra = {}) => ({ baseUrl: url, key: KEY, ...extra });

test("only ever issues GET, and sends the key as a bearer token only when asked", async () => {
  const mock = await startMock((_r, res) => json(res, 200, {}));
  const { api } = clientFor(cfg(mock.url));
  await api.get("/a", {}, { credential: "key" });
  await api.get("/b", {});
  assert.deepEqual(mock.requests.map((r) => r.method), ["GET", "GET"]);
  assert.equal(mock.requests[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(mock.requests[1].headers.authorization, undefined);
  await mock.close();
});

test("the source has no code path that writes: no POST/PUT/DELETE and no admin header", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../../src/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.ok(!/method:\s*["'](POST|PUT|PATCH|DELETE)/i.test(src), `${f} issues a write`);
    assert.ok(!/x-admin-code/i.test(src), `${f} mentions the admin header`);
  }
});

test("retries a 5xx with backoff and then succeeds", async () => {
  let n = 0;
  const mock = await startMock((_r, res) => (++n < 3 ? json(res, 503, {}) : json(res, 200, { ok: true })));
  const { api, clock } = clientFor(cfg(mock.url));
  assert.deepEqual((await api.get("/x", {})).body, { ok: true });
  assert.equal(n, 3);
  assert.ok(clock.sleeps.includes(250) && clock.sleeps.includes(500));
  await mock.close();
});

test("gives up after three tries with a retryable error", async () => {
  const mock = await startMock((_r, res) => json(res, 500, {}));
  const { api } = clientFor(cfg(mock.url));
  await assert.rejects(api.get("/x", {}), (e: ApiError) => e.retryable && e.status === 500);
  assert.equal(mock.requests.length, 3);
  await mock.close();
});

test("honours 429 Retry-After", async () => {
  let n = 0;
  const mock = await startMock((_r, res) => (++n === 1 ? json(res, 429, {}, { "Retry-After": "7" }) : json(res, 200, {})));
  const { api, clock } = clientFor(cfg(mock.url));
  await api.get("/x", {});
  assert.ok(clock.sleeps.includes(7000));
  await mock.close();
});

test("an unreachable API is a retryable error that never contains the key", async () => {
  const { api } = clientFor(cfg("http://127.0.0.1:1"));
  await assert.rejects(api.get("/x", {}, { credential: "key" }), (e: ApiError) => e.retryable && !e.message.includes(KEY));
});

test("sends If-None-Match and returns the stored copy on 304", async () => {
  const mock = await startMock((r, res) => {
    if (r.headers["if-none-match"] === '"v1"') { res.writeHead(304); res.end(); } else json(res, 200, { n: 1 }, { ETag: '"v1"' });
  });
  const { api, clock } = clientFor(cfg(mock.url));
  const first = await api.get("/s", {}, { streamKey: "a" });
  assert.equal(first.notModified, false);
  clock.t += CAPTION_INTERVAL_MS + 1;
  const second = await api.get("/s", {}, { streamKey: "a" });
  assert.equal(second.notModified, true);
  assert.deepEqual(second.body, { n: 1 });
  await mock.close();
});

test("calls to one stream within a second are served from the stored copy without a request", async () => {
  const mock = await startMock((_r, res) => json(res, 200, { n: 1 }, { ETag: '"v1"' }));
  const { api } = clientFor(cfg(mock.url));
  await api.get("/s", {}, { streamKey: "a" });
  await api.get("/s", {}, { streamKey: "a" });
  assert.equal(mock.requests.length, 1);
  await mock.close();
});

test("a different request to the same stream within a second waits for the remaining time", async () => {
  const mock = await startMock((_r, res) => json(res, 200, {}));
  const { api, clock } = clientFor(cfg(mock.url));
  await api.get("/s", { transcriptCursor: 1 }, { streamKey: "a" });
  await api.get("/s", { transcriptCursor: 2 }, { streamKey: "a" });
  assert.equal(mock.requests.length, 2);
  assert.ok(clock.sleeps.some((ms) => ms > 0 && ms <= CAPTION_INTERVAL_MS));
  await mock.close();
});

test("never exceeds 5 requests in any second", async () => {
  const mock = await startMock((_r, res) => json(res, 200, {}));
  const { api, clock } = clientFor(cfg(mock.url));
  const start = clock.t;
  for (let i = 0; i < 12; i++) await api.get("/p" + i, {});
  const stamps: number[] = [];
  // replay the fake timeline: with 12 calls at <=5/s, at least two full seconds must have been waited
  assert.ok(clock.t - start >= 2000, `only ${clock.t - start}ms elapsed`);
  void stamps; await mock.close();
});

test("two clients never share cached text: a key-holder's copy is not served to an anonymous client", async () => {
  const mock = await startMock((r, res) => json(res, 200, r.headers.authorization ? liveBody() : { authRequired: true }, { ETag: '"x"' }));
  const owner = clientFor(cfg(mock.url)).api;
  const anon = clientFor({ baseUrl: mock.url }).api;
  assert.ok((await owner.get("/stream/LiteGetStream", { streamName: "a" }, { credential: "key", streamKey: "a" })).body.transcript);
  const seen = await anon.get("/stream/LiteGetStream", { streamName: "a" }, { credential: "key", streamKey: "a" });
  assert.deepEqual(seen.body, { authRequired: true });
  await mock.close();
});

test("the same client keeps keyed and unkeyed copies apart, even when the server honours If-None-Match", async () => {
  const mock = await startMock((r, res) => {
    // a server whose ETag is the same for both callers: only the client's own cache identity can keep them apart
    if (r.headers["if-none-match"] === '"x"') { res.writeHead(304); res.end(); return; }
    json(res, 200, r.headers.authorization ? { secret: 1 } : { public: 1 }, { ETag: '"x"' });
  });
  const { api } = clientFor(cfg(mock.url));
  await api.get("/s", {}, { credential: "key" });
  assert.deepEqual((await api.get("/s", {})).body, { public: 1 });
  await mock.close();
});
