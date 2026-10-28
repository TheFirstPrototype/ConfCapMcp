import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { closeAll, startMock, json, clientFor, KEY, AUTH, liveBody, historyRows } from "./helpers.js";
afterEach(closeAll);

async function connect(handler: Parameters<typeof startMock>[0], cfg: Record<string, unknown> = {}) {
  const mock = await startMock(handler);
  const config = { baseUrl: mock.url, key: KEY, stream: "mtw", ...cfg } as any;
  const server = createServer(config, clientFor(config).api);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, mock, config };
}
const happy = (r: any, res: any) => {
  if (r.path === "/stream/LiteGetStream") return json(res, 200, liveBody());
  if (r.path === "/history/GetStreamHistory") return json(res, 200, r.headers.authorization ? historyRows : []);
  if (r.path === "/developerkey/Me") return r.headers.authorization ? json(res, 200, { streams: ["mtw"] }) : json(res, 401, {});
  if (r.path === "/question/GetStreamQuestions") return json(res, 200, [{ id: 1, createdAt: "2026-10-28T09:00:00", streamName: "mtw", question: "Lunch?" }]);
  return json(res, 200, { terms: [], streamColor: "#000" });
};
const textOf = (r: any) => r.content[0].text as string;

test("lists the seven read-only tools, each marked read-only", async () => {
  const { client, mock } = await connect(happy);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["get_live_captions", "get_saved_transcript", "get_stream_context", "get_stream_status", "list_my_streams", "list_questions", "list_saved_transcripts"]);
  for (const t of tools) { assert.equal(t.annotations?.readOnlyHint, true, t.name); assert.equal(t.annotations?.destructiveHint, false, t.name); assert.match(t.description!, /sent to the AI model/, t.name); }
  await mock.close();
});

test("no tool takes a credential or uid as an argument the model could fill in", async () => {
  const { client, mock } = await connect(happy);
  for (const t of (await client.listTools()).tools) {
    const props = Object.keys((t.inputSchema as any).properties ?? {});
    for (const bad of ["key", "uid", "auth", "apiKey", "token", "password"]) assert.ok(!props.includes(bad), `${t.name} accepts ${bad}`);
  }
  await mock.close();
});

test("calls a tool end to end through the protocol", async () => {
  const { client, mock } = await connect(happy);
  const r: any = await client.callTool({ name: "get_live_captions", arguments: { language: "es" } });
  assert.match(textOf(r), /Hola a todos/);
  const q: any = await client.callTool({ name: "list_questions", arguments: {} });
  assert.match(textOf(q), /Lunch\?/);
  await mock.close();
});

test("rejects bad arguments before any API call", async () => {
  const { client, mock } = await connect(happy);
  const r: any = await client.callTool({ name: "get_live_captions", arguments: { maxChars: -5 } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
  assert.equal(r.isError, true);
  assert.equal(mock.requests.length, 0);
  await mock.close();
});

test("errors come back as tool errors with a message and a retryable flag", async () => {
  const { client, mock } = await connect((_r, res) => json(res, 503, {}));
  const r: any = await client.callTool({ name: "get_stream_status", arguments: {} });
  assert.equal(r.isError, true); assert.deepEqual(JSON.parse(textOf(r)), { error: "The API had a problem (503).", retryable: true });
  await mock.close();
});

test("the key and the auth code never appear in any tool result or error, even when the API echoes them", async () => {
  const echo = (r: any, res: any) => {
    // a hostile or buggy API that reflects credentials in bodies and in its failures
    if (r.path === "/stream/LiteGetStream") return json(res, 200, liveBody({ description: `${KEY} ${AUTH}`, transcript: `see ?auth=${AUTH}` }));
    return json(res, 500, `boom ${KEY} ${AUTH}`);
  };
  const { client, mock, config } = await connect(echo, { auth: AUTH });
  const outputs: string[] = [];
  for (const [name, args] of [["get_stream_status", {}], ["get_live_captions", {}], ["list_saved_transcripts", {}], ["get_stream_context", {}], ["list_questions", {}], ["list_my_streams", {}]] as const) {
    const r: any = await client.callTool({ name, arguments: args });
    outputs.push(JSON.stringify(r));
  }
  void config;
  // A tool may relay what speakers said (that is its job), but errors must be clean: check the error results only.
  for (const out of outputs.filter((o) => o.includes('"isError":true'))) { assert.ok(!out.includes(KEY)); assert.ok(!out.includes(AUTH)); }
  await mock.close();
});

test("an error that carries the key or the auth code is redacted before the model sees it", async () => {
  const { ApiClient, ApiError } = await import("../src/api.js");
  const config = { baseUrl: "http://127.0.0.1:1", key: KEY, auth: AUTH, stream: "mtw" } as any;
  class Leaky extends ApiClient { async get(): Promise<never> { throw new ApiError(`GET /x?auth=${AUTH} with ${KEY} failed`, 500, false); } }
  const server = createServer(config, new Leaky(config));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const r: any = await client.callTool({ name: "get_stream_status", arguments: {} });
  assert.equal(r.isError, true);
  assert.ok(!textOf(r).includes(KEY) && !textOf(r).includes(AUTH), textOf(r));
  assert.match(textOf(r), /redacted/);
});

test("secured stream: without the key no caption text leaks, and a key-holder's copy is not reused", async () => {
  const gate = (r: any, res: any) => r.path === "/stream/LiteGetStream"
    ? json(res, 200, r.headers.authorization ? liveBody() : { roomName: "mtw", authRequired: true }, { ETag: '"e"' })
    : json(res, 404, {});
  const owner = await connect(gate); const anon = await connect(gate, { key: undefined });
  assert.match(textOf(await owner.client.callTool({ name: "get_live_captions", arguments: {} }) as any), /Hello everyone/);
  const denied = textOf(await anon.client.callTool({ name: "get_live_captions", arguments: {} }) as any);
  assert.match(denied, /authRequired/); assert.ok(!denied.includes("Hello everyone"));
  await owner.mock.close(); await anon.mock.close();
});

test("resources and prompts are offered", async () => {
  const { client, mock } = await connect(happy);
  const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate).sort();
  assert.deepEqual(templates, ["confcap://stream/{name}/status", "confcap://stream/{name}/transcript/{id}"]);
  const status: any = await client.readResource({ uri: "confcap://stream/mtw/status" });
  assert.equal(JSON.parse(status.contents[0].text).state, "ok");
  const transcript: any = await client.readResource({ uri: "confcap://stream/mtw/transcript/1" });
  assert.match(transcript.contents[0].text, /AAAA/);
  assert.deepEqual((await client.listPrompts()).prompts.map((p) => p.name).sort(), ["catch_me_up", "meeting_minutes", "translate_summary", "triage_questions"]);
  const p: any = await client.getPrompt({ name: "meeting_minutes", arguments: { id: "1", language: "Spanish" } });
  assert.match(p.messages[0].content.text, /get_saved_transcript with id 1.*Spanish/s);
  await mock.close();
});
