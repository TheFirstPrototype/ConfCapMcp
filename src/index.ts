#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main() {
  let config;
  try { config = loadConfig(process.env); }
  catch (err) { console.error(`confcap-mcp: ${(err as Error).message}`); process.exit(1); }
  // stdout belongs to the protocol; diagnostics go to stderr and never include credentials or caption text.
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  console.error(`confcap-mcp ready (${config.key ? "developer key set" : "no key: public streams only"})`);
}
main();
