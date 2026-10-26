// Runs the official MCP Inspector, in CLI mode, against a local `wrangler dev`: tools/list and
// a wait_for_sms_code call, once in each protocol era (legacy = initialize handshake, modern =
// 2026-07-28). Run with `npm run test:inspector`. The first run needs the network, for npx to
// fetch the pinned Inspector. Its files and secrets stay in a temporary folder.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendLikeFwrd, startServer } from "./helpers.mjs";

const INSPECTOR = "@modelcontextprotocol/inspector@2.12.0";
const CODES = { legacy: "246810", modern: "135791" };

const server = await startServer();
const scratch = mkdtempSync(join(tmpdir(), "fwrd-sms-mcp-inspector-"));
let failures = 0;

try {
  for (const era of ["legacy", "modern"]) {
    await sendLikeFwrd(`${server.url}/fwrd/${server.fwrdToken}`, `Your Inspector code is ${CODES[era]}.`);
    const common = [
      `${server.url}/mcp`,
      "--transport", "http",
      "--protocol-era", era,
      "--header", `Authorization: Bearer ${server.mcpToken}`,
      "--format", "json",
    ];

    const list = await inspector([...common, "--method", "tools/list"]);
    const names = list.result.tools.map((tool) => tool.name).join(", ");
    report(era, "tools/list", names === "wait_for_sms_code, list_recent_texts", names);

    const call = await inspector([
      ...common,
      "--method", "tools/call",
      "--tool-name", "wait_for_sms_code",
      "--tool-arg", "contains=Inspector",
      "--tool-arg", "timeout_seconds=5",
    ]);
    const found = JSON.parse(call.result.content[0].text);
    report(era, "tools/call wait_for_sms_code", found.code === CODES[era], `found ${found.code}`);
  }
} catch (error) {
  failures++;
  console.error(error.message);
} finally {
  await server.stop();
  rmSync(scratch, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} Inspector check(s) failed`);
  process.exit(1);
}
console.log("All Inspector checks passed");

function report(era, what, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${era.padEnd(6)} ${what} -> ${detail}`);
}

function inspector(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["-y", INSPECTOR, "--cli", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MCP_INSPECTOR_SECRET_STORE: "memory",
        MCP_STORAGE_DIR: join(scratch, "storage"),
        MCP_CATALOG_PATH: join(scratch, "mcp.json"),
        MCP_CLIENT_CONFIG_PATH: join(scratch, "client.json"),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`Inspector exited with ${code}:\n${stderr}\n${stdout}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Inspector printed something other than JSON:\n${stdout}\n${stderr}`));
      }
    });
  });
}
