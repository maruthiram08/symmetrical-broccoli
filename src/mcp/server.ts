// npm run -s mcp : the Daily brief MCP server over stdio, for Claude Desktop and Claude Code.
// stdout carries MCP protocol only, so every log goes to stderr.
//
// Concurrency with the running web app (its scheduler writes the same state.json):
//  - Every tool call re-reads state.json first (FileStore reloads when the mtime changed).
//  - mark_item goes through FileStore.setItemStatus: reload, change one item, write the whole
//    file to state.json.tmp and rename it over state.json (atomic: a reader never sees half a file).
//  - Known race, not fully solvable without a cross-process lock: FileStore writes are
//    read-modify-write of the whole file. If the web app reloads, then this process writes, then
//    the web app flushes its own change within the same instant, the later write wins and the
//    earlier change is lost. Each window is a synchronous reload-change-flush (well under a
//    millisecond; the slow Anthropic / Wispr calls happen outside it), so in practice it needs two
//    writes in the same millisecond. mark_item re-reads after writing and reports if the change
//    didn't stick.

import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileStore } from "@/server/local/file-store";
import { dataDir } from "@/server/local/paths";
import { createMcpServer } from "./tools";

// Anything that would print to stdout would corrupt the protocol stream.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

async function main() {
  // Same file as the web app (src/server/local/app.ts getStore), honouring DAILY_BRIEF_DIR.
  // Opened directly rather than through getStore(), which also creates the OAuth key: not needed here.
  const path = join(dataDir(), "state.json");
  const store = new FileStore(path);
  const server = createMcpServer({ store });
  await server.connect(new StdioServerTransport());
  console.error(`[daily-brief mcp] ready, reading ${path}`);
}

main().catch((e) => {
  console.error("[daily-brief mcp]", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
