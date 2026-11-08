#!/usr/bin/env node
// A stdio front door for fwrd-sms-mcp, for MCP directories (such as Glama) that start a server in
// a container and talk to it over stdin/stdout.
//
// The real server is a Cloudflare Worker that speaks MCP over HTTP. This script runs that same
// Worker locally with `wrangler dev`, then passes each JSON-RPC message from stdin to its /mcp
// endpoint and writes each reply to stdout, one per line. Logs go to stderr only.
//
// Texts only arrive when the Fwrd iPhone app posts them to a deployed Worker, so a local copy
// started this way lists its tools and answers calls, but has no texts. For real use, deploy the
// Worker (see README.md) and connect your client to https://<worker>/mcp instead.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const PORT = Number(process.env.FWRD_MCP_PORT ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const MCP_TOKEN = process.env.MCP_TOKEN || randomBytes(32).toString("hex");
const FWRD_TOKEN = process.env.FWRD_TOKEN || randomBytes(32).toString("hex");
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

const log = (...parts) => console.error("[fwrd-sms-mcp stdio]", ...parts);

const worker = spawn(
  "npx",
  [
    "wrangler", "dev",
    "--ip", "127.0.0.1",
    "--port", String(PORT),
    "--persist-to", mkdtempSync(join(tmpdir(), "fwrd-sms-mcp-")),
    "--show-interactive-dev-session=false",
    "--log-level", "warn",
    "--var", `MCP_TOKEN:${MCP_TOKEN}`,
    "--var", `FWRD_TOKEN:${FWRD_TOKEN}`,
  ],
  {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  },
);
worker.stdout.pipe(process.stderr);
worker.stderr.pipe(process.stderr);
worker.on("exit", (code) => {
  if (!shuttingDown) {
    log(`wrangler dev exited (${code})`);
    process.exit(1);
  }
});

let shuttingDown = false;
function shutdown(code) {
  shuttingDown = true;
  worker.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

async function waitForWorker() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("wrangler dev didn't start within 90 seconds");
}
const ready = waitForWorker();

let legacyVersion = null; // set from the initialize result, for 2025-era clients
let initializing = null; // in-flight initialize, which later requests wait for

async function forward(message) {
  await ready;
  if (message?.method !== "initialize" && initializing) await initializing;

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${MCP_TOKEN}`,
  };
  const metaVersion = message?.params?._meta?.[PROTOCOL_VERSION_KEY];
  if (typeof metaVersion === "string") {
    // 2026-07-28 requests mirror their version, method and tool name in headers.
    headers["MCP-Protocol-Version"] = metaVersion;
    if (typeof message.method === "string") headers["Mcp-Method"] = message.method;
    if (typeof message.params?.name === "string") headers["Mcp-Name"] = message.params.name;
  } else if (legacyVersion) {
    headers["MCP-Protocol-Version"] = legacyVersion;
  }

  const res = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(message) });
  const text = await res.text();
  if (!text) return;
  const reply = JSON.parse(text);
  if (message?.method === "initialize" && reply?.result?.protocolVersion) {
    legacyVersion = reply.result.protocolVersion;
  }
  process.stdout.write(JSON.stringify(reply) + "\n");
}

const pending = new Set();
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n",
    );
    return;
  }
  const job = forward(message).catch((error) => {
    log(error.message);
    if (message && "id" in message && message.method) {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error.message } }) + "\n",
      );
    }
  });
  if (message?.method === "initialize") initializing = job;
  pending.add(job);
  job.finally(() => pending.delete(job));
});
lines.on("close", async () => {
  await Promise.allSettled([...pending]);
  shutdown(0);
});
