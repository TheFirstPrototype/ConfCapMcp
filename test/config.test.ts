import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, redact } from "../src/config.js";
import { KEY, AUTH } from "./helpers.js";

test("defaults to the production API and lowercases the stream", () => {
  const c = loadConfig({ CONFCAP_STREAM: "MTW" });
  assert.equal(c.baseUrl, "https://api.deafassistant.com");
  assert.equal(c.stream, "mtw");
});

test("rejects a key that is not a developer key, and does not echo it", () => {
  assert.throws(() => loadConfig({ CONFCAP_KEY: "my-account-uid-123" }), (e: Error) => /developer API key/.test(e.message) && !e.message.includes("my-account-uid-123"));
});

test("refuses a plain-http API address except localhost, because credentials are sent to it", () => {
  assert.throws(() => loadConfig({ CONFCAP_API_URL: "http://api.example.com" }), /https/);
  assert.doesNotThrow(() => loadConfig({ CONFCAP_API_URL: "http://localhost:5099" }));
  assert.doesNotThrow(() => loadConfig({ CONFCAP_API_URL: "http://127.0.0.1:5099" }));
});

test("redact removes the key, the auth code, and any key-looking or auth= text", () => {
  const text = `failed ${KEY} and ${AUTH} at https://x/y?auth=${AUTH}&uid=u123&streamName=a cck_otherkey12345678`;
  const out = redact(text, { key: KEY, auth: AUTH });
  for (const secret of [KEY, AUTH, "u123", "cck_otherkey"]) assert.ok(!out.includes(secret), secret);
  assert.ok(out.includes("streamName=a"));
});
