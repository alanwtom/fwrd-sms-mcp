// Shared by the tests: start `wrangler dev`, send texts the way Fwrd does, and talk MCP
// the way a client does. No dependencies beyond Node itself and the project's wrangler.

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Starts `wrangler dev` on a free port with fresh tokens and empty storage.
 * `vars` overrides wrangler.jsonc vars (and any .dev.vars), for example { KEEP_SECONDS: "2" }.
 */
export async function startServer(vars = {}) {
  const port = await freePort();
  const persistTo = mkdtempSync(join(tmpdir(), "fwrd-sms-mcp-test-"));
  const fwrdToken = randomBytes(24).toString("hex");
  const mcpToken = randomBytes(24).toString("hex");
  const args = [
    "dev",
    "--ip", "127.0.0.1",
    "--port", String(port),
    "--persist-to", persistTo,
    "--show-interactive-dev-session=false",
  ];
  for (const [key, value] of Object.entries({ FWRD_TOKEN: fwrdToken, MCP_TOKEN: mcpToken, ...vars })) {
    args.push("--var", `${key}:${value}`);
  }
  // detached: wrangler starts workerd as a child, so stop() ends the whole process group.
  const child = spawn(join(ROOT, "node_modules", ".bin", "wrangler"), args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.once("exit", resolve));

  const url = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${output}`);
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() - startedAt > 90_000) {
      stopProcessGroup(child);
      throw new Error(`wrangler dev didn't start within 90 seconds:\n${output}`);
    }
    await sleep(250);
  }

  return {
    url,
    fwrdToken,
    mcpToken,
    output: () => output,
    async stop() {
      stopProcessGroup(child);
      await exited;
      rmSync(persistTo, { recursive: true, force: true });
    },
  };
}

function stopProcessGroup(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends exactly what Fwrd sends for one forwarded text: a POST with Content-Type and an
 * Idempotency-Key header (an uppercase UUID, as iOS makes them), and the message twice.
 * "sender" is included only when given, as with Include Who Sent It.
 */
export async function sendLikeFwrd(url, message, { sender, key = randomUUID().toUpperCase() } = {}) {
  const body = { content: message, text: message };
  if (sender !== undefined) body.sender = sender;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text(), key };
}

/** POSTs a JSON-RPC body to /mcp and returns the status, headers and parsed JSON (if any). */
export async function postMcp(server, body, { headers = {}, path = "/mcp", auth = true, signal } = {}) {
  const response = await fetch(server.url + path, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(auth ? { Authorization: `Bearer ${server.mcpToken}` } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: text ? JSON.parse(text) : undefined };
}

let nextId = 1;

/** A client on a handshake-era version: initialize once, then the version header on every call. */
export function legacyClient(server, version = "2025-11-25") {
  return {
    async initialize(requested = version) {
      return postMcp(server, {
        jsonrpc: "2.0",
        id: nextId++,
        method: "initialize",
        params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: "e2e-test", version: "1.0.0" } },
      });
    },
    async notify(method) {
      return postMcp(server, { jsonrpc: "2.0", method }, { headers: { "MCP-Protocol-Version": version } });
    },
    async request(method, params) {
      return postMcp(
        server,
        { jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) },
        { headers: { "MCP-Protocol-Version": version } },
      );
    },
    async callTool(name, args = {}) {
      return this.request("tools/call", { name, arguments: args });
    },
  };
}

/** A 2026-07-28 client: no handshake; version and capabilities in every request's _meta, mirrored in headers. */
export function modernClient(server, version = "2026-07-28") {
  return {
    async request(method, params = {}, { headers = {} } = {}) {
      const name = method === "tools/call" ? { "Mcp-Name": params.name } : {};
      return postMcp(
        server,
        {
          jsonrpc: "2.0",
          id: nextId++,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": version,
              "io.modelcontextprotocol/clientInfo": { name: "e2e-test", version: "1.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        },
        { headers: { "MCP-Protocol-Version": version, "Mcp-Method": method, ...name, ...headers } },
      );
    },
    async callTool(name, args = {}) {
      return this.request("tools/call", { name, arguments: args });
    },
  };
}

/** Rows in the inbox's SQLite, read through wrangler's local explorer, without calling the Worker. */
export async function storedTextCount(server) {
  const response = await fetch(
    `${server.url}/cdn-cgi/local/explorer/api/workers/durable_objects/namespaces/fwrd-sms-mcp-Inbox/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ durable_object_name: "inbox", queries: [{ sql: "SELECT COUNT(*) FROM texts" }] }),
    },
  );
  const body = await response.json();
  if (!body.success) throw new Error(`explorer query failed: ${JSON.stringify(body)}`);
  return body.result[0].rows[0][0];
}
