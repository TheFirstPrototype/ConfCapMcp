// Live smoke test: runs the built stdio server against the real API with a throwaway developer key, calls every tool
// read-only, checks the key never appears in output, then deletes the key. See README ("Live smoke test").
// Usage: npm run build && FIREBASE_API_KEY=... T_EMAIL=... T_PASS=... node scripts/live-smoke.mjs
// Optional: API_BASE_URL (default https://api.deafassistant.com), SMOKE_STREAM (default: the account's only stream),
// HOSTED_URL (e.g. https://mcp.deafassistant.com or http://127.0.0.1:8787): test the hosted HTTP endpoint instead of the stdio server.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";

const API = (process.env.API_BASE_URL || "https://api.deafassistant.com").replace(/\/+$/, "");
const FIREBASE_KEY = process.env.FIREBASE_API_KEY; // the portal's public web key (find it in the portal's firebase config)
const { T_EMAIL, T_PASS } = process.env;
if (!T_EMAIL || !T_PASS) { console.error("Set T_EMAIL and T_PASS (a portal login for the account that owns a stream)."); process.exit(2); }
if (!FIREBASE_KEY) { console.error("Set FIREBASE_API_KEY (the portal's Firebase web API key, the apiKey in its firebase config)."); process.exit(2); }
const SERVER = fileURLToPath(new URL("../dist/src/index.js", import.meta.url));

const failures = [];
const check = (name, ok, detail = "") => { console.log((ok ? "  OK   " : "  FAIL ") + name + (ok ? "" : `  -> ${detail}`)); if (!ok) failures.push(name); };
const json = (r) => r.json();

const login = await json(await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: T_EMAIL, password: T_PASS, returnSecureToken: true }) }));
if (!login.idToken) { console.error("Login failed:", JSON.stringify(login).slice(0, 200)); process.exit(2); }
const L = { Authorization: "Bearer " + login.idToken };
const listKeys = async () => (await json(await fetch(API + "/developerkey/List", { headers: L }))).keys;
const revokeAll = async () => { for (const k of await listKeys()) await fetch(`${API}/developerkey/Revoke?id=${k.id}`, { method: "POST", headers: L }); };

await revokeAll();
const created = await json(await fetch(API + "/developerkey/Create", { method: "POST", headers: L }));
let client;
try {
  const env = { ...process.env, CONFCAP_KEY: created.key, CONFCAP_API_URL: API };
  delete env.T_PASS; delete env.CONFCAP_STREAM; // the server never needs the password; start with no default stream
  client = new Client({ name: "smoke", version: "1" });
  if (process.env.HOSTED_URL) {
    await client.connect(new StreamableHTTPClientTransport(new URL(process.env.HOSTED_URL.replace(/\/+$/, "") + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${created.key}` } } }));
    console.log("Testing the hosted endpoint", process.env.HOSTED_URL);
  } else {
    await client.connect(new StdioClientTransport({ command: "node", args: [SERVER], env }));
  }
  const all = [];
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const text = r.content[0].text; all.push(text); return { error: !!r.isError, data: JSON.parse(text) }; };

  check("seven tools are listed", (await client.listTools()).tools.length === 7);
  const mine = await call("list_my_streams");
  check("list_my_streams returns the account's streams", !mine.error && mine.data.streams.length > 0, mine.data);
  const stream = process.env.SMOKE_STREAM || mine.data.streams[0];
  console.log("Using stream", stream);
  const status = await call("get_stream_status", { streamName: stream });
  check("get_stream_status answers a known state", ["ok", "unknown", "authRequired", "expired"].includes(status.data.state), status.data);
  const caps = await call("get_live_captions", { streamName: stream, maxChars: 200 });
  check("get_live_captions answers without error", !caps.error, caps.data);
  check("caption text is wrapped as untrusted", caps.data.text === undefined || /^<untrusted-text>[\s\S]*<\/untrusted-text>$/.test(caps.data.text));
  check("get_stream_context answers", !(await call("get_stream_context", { streamName: stream })).error);
  const saved = await call("list_saved_transcripts", { streamName: stream, includeHidden: true });
  check("list_saved_transcripts answers", !saved.error && Array.isArray(saved.data.transcripts), saved.data);
  if (saved.data.transcripts?.length) check("get_saved_transcript answers", !(await call("get_saved_transcript", { streamName: stream, id: saved.data.transcripts[0].id, limit: 1000 })).error);
  const qs = await call("list_questions", { streamName: stream });
  check("list_questions answers", !qs.error && Array.isArray(qs.data.questions), qs.data);
  const wrong = await call("get_saved_transcript", { streamName: stream, id: 999999999 });
  check("an unknown transcript id is a clear error", wrong.error && /No saved transcript/.test(wrong.data.error), wrong.data);
  check("the key never appears in any output", !all.join("\n").includes(created.key));
  check("the uid never appears in any output", !all.join("\n").includes(login.localId));
} catch (err) {
  check("smoke test ran to the end", false, err.stack || String(err));
} finally {
  await client?.close().catch(() => {});
  await revokeAll();
  console.log("Cleaned up: keys left =", (await listKeys()).length);
}
console.log(failures.length ? `\nFAILED: ${failures.join("; ")}` : "\nLive smoke test passed.");
process.exit(failures.length ? 1 : 0);
