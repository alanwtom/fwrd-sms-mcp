// End-to-end tests against `wrangler dev`: real HTTP, the real Durable Object and SQLite.
// Run with `npm test`. Each test uses its own random word ("AcmeQZKRTB") in the texts it
// sends and in `contains`, so tests don't pick up each other's codes.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  legacyClient,
  modernClient,
  postMcp,
  sendLikeFwrd,
  sleep,
  startServer,
  storedTextCount,
} from "./helpers.mjs";

const ALLOWED_ORIGIN = "https://allowed.example";

let server;
let fwrdUrl;
// Letters only and all the same length, so one word is never part of another and never adds digits.
const uniqueWord = () =>
  `Acme${Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("")}`;

before(async () => {
  server = await startServer({ ALLOWED_ORIGINS: ALLOWED_ORIGIN });
  fwrdUrl = `${server.url}/fwrd/${server.fwrdToken}`;
});

after(async () => {
  await server?.stop();
});

/** The structured result of a tools/call, checked against the JSON copy in the text block. */
function toolResult(response) {
  assert.equal(response.status, 200, response.text);
  const { result } = response.json;
  assert.ok(result, response.text);
  if (result.structuredContent !== undefined) {
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
  return result;
}

describe("Fwrd webhook", () => {
  test("accepts exactly what Fwrd sends and answers {\"ok\":true}", async () => {
    const sent = await sendLikeFwrd(fwrdUrl, `Your ${uniqueWord()} verification code is 482913.`);
    assert.equal(sent.status, 200);
    assert.equal(sent.text, '{"ok":true}');
  });

  test("a retry with the same Idempotency-Key is stored once", async () => {
    const name = uniqueWord();
    const first = await sendLikeFwrd(fwrdUrl, `${name} code 135790`);
    const retry = await sendLikeFwrd(fwrdUrl, `${name} code 135790`, { key: first.key });
    assert.equal(first.text, '{"ok":true}');
    assert.equal(retry.status, 200);
    assert.equal(retry.text, '{"ok":true}');
    const listed = toolResult(await legacyClient(server).callTool("list_recent_texts", { contains: name }));
    assert.equal(listed.structuredContent.texts.length, 1);
  });

  test("accepts the token as ?token= and keeps the sender when Fwrd sends one", async () => {
    const name = uniqueWord();
    const sent = await sendLikeFwrd(`${server.url}/fwrd?token=${server.fwrdToken}`, `${name}: 4321 is your code`, {
      sender: "+15555550123",
    });
    assert.equal(sent.status, 200);
    const [text] = toolResult(await legacyClient(server).callTool("list_recent_texts", { contains: name }))
      .structuredContent.texts;
    assert.equal(text.sender, "+15555550123");
    assert.equal(text.code, "4321");
  });

  test("refuses a wrong or missing token with 401", async () => {
    for (const url of [`${server.url}/fwrd/wrong-token-1234567890`, `${server.url}/fwrd`, `${server.url}/fwrd?token=nope`]) {
      assert.equal((await sendLikeFwrd(url, "Code 111111")).status, 401, url);
    }
  });

  test("refuses other methods (405), bad JSON (400), no content (400) and bodies over 64 KB (413)", async () => {
    assert.equal((await fetch(fwrdUrl)).status, 405);
    const post = (body) => fetch(fwrdUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal((await post("{not json")).status, 400);
    assert.equal((await post(JSON.stringify({ text: "only text" }))).status, 400);
    const big = "x".repeat(70 * 1024);
    assert.equal((await post(JSON.stringify({ content: big, text: big }))).status, 413);
  });
});

describe("MCP endpoint security", () => {
  test("refuses a missing token, a wrong bearer and a wrong path token with 401", async () => {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const missing = await postMcp(server, ping, { auth: false });
    const wrong = await postMcp(server, ping, { auth: false, headers: { Authorization: "Bearer not-the-token-123456" } });
    const wrongPath = await postMcp(server, ping, { auth: false, path: "/mcp/not-the-token-123456" });
    for (const response of [missing, wrong, wrongPath]) {
      assert.equal(response.status, 401);
      assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer/);
    }
  });

  test("accepts the token as a path segment, for clients that can't send headers", async () => {
    const response = await postMcp(
      server,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } },
      { auth: false, path: `/mcp/${server.mcpToken}` },
    );
    assert.equal(response.status, 200);
    assert.equal(response.json.result.serverInfo.name, "fwrd-sms-mcp");
  });

  test("GET and DELETE /mcp are 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`${server.url}/mcp`, { method, headers: { Authorization: `Bearer ${server.mcpToken}` } });
      assert.equal(response.status, 405, method);
    }
  });

  test("with ALLOWED_ORIGINS set, refuses any other Origin with 403", async () => {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    assert.equal((await postMcp(server, ping, { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await postMcp(server, ping, { headers: { Origin: ALLOWED_ORIGIN } })).status, 200);
    assert.equal((await postMcp(server, ping)).status, 200, "no Origin header, as from a desktop or server client");
  });
});

describe("MCP with the initialize handshake (2025-11-25)", () => {
  const client = () => legacyClient(server, "2025-11-25");

  test("initialize negotiates 2025-11-25 and names the server", async () => {
    const { status, json } = await client().initialize();
    assert.equal(status, 200);
    assert.equal(json.result.protocolVersion, "2025-11-25");
    assert.equal(json.result.serverInfo.name, "fwrd-sms-mcp");
    assert.deepEqual(json.result.capabilities, { tools: { listChanged: false } });
  });

  test("notifications/initialized gets 202 with no body", async () => {
    const response = await client().notify("notifications/initialized");
    assert.equal(response.status, 202);
    assert.equal(response.text, "");
  });

  test("ping answers with an empty result", async () => {
    assert.deepEqual((await client().request("ping")).json.result, {});
  });

  test("tools/list returns both tools with input and output schemas", async () => {
    const { tools } = (await client().request("tools/list")).json.result;
    assert.deepEqual(tools.map((tool) => tool.name), ["wait_for_sms_code", "list_recent_texts"]);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.outputSchema.type, "object");
      assert.ok(tool.description.length > 50);
    }
  });

  test("wait_for_sms_code returns a code that's already waiting, once", async () => {
    const name = uniqueWord();
    await sendLikeFwrd(fwrdUrl, `${name}: your verification code is 482913. It expires in 10 minutes.`, {
      sender: "12345",
    });
    const result = toolResult(await client().callTool("wait_for_sms_code", { contains: name, timeout_seconds: 5 }));
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.found, true);
    assert.equal(result.structuredContent.code, "482913");
    assert.equal(result.structuredContent.sender, "12345");
    assert.match(result.structuredContent.text, /482913/);

    const again = toolResult(await client().callTool("wait_for_sms_code", { contains: name, timeout_seconds: 0 }));
    assert.equal(again.structuredContent.found, false, "a code is handed out only once");
  });

  test("wait_for_sms_code waits for a code that arrives mid-wait", async () => {
    const name = uniqueWord();
    const startedAt = Date.now();
    const call = client().callTool("wait_for_sms_code", { contains: name, timeout_seconds: 20 });
    await sleep(1500);
    await sendLikeFwrd(fwrdUrl, `${name} code: 246 810`);
    const result = toolResult(await call);
    const elapsed = Date.now() - startedAt;
    assert.equal(result.structuredContent.found, true);
    assert.equal(result.structuredContent.code, "246810");
    assert.ok(elapsed >= 1400 && elapsed < 10_000, `answered after ${elapsed} ms`);
  });

  test("wait_for_sms_code times out with a plain result that says to resend", async () => {
    const startedAt = Date.now();
    const result = toolResult(
      await client().callTool("wait_for_sms_code", { contains: "nothing-sends-this", timeout_seconds: 2 }),
    );
    assert.ok(Date.now() - startedAt >= 1900);
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.found, false);
    assert.match(result.structuredContent.message, /send the code again/);
  });

  test("max_age_seconds leaves out codes that arrived earlier", async () => {
    const name = uniqueWord();
    await sendLikeFwrd(fwrdUrl, `${name} code 908172`);
    await sleep(1500);
    const result = toolResult(
      await client().callTool("wait_for_sms_code", { contains: name, max_age_seconds: 1, timeout_seconds: 0 }),
    );
    assert.equal(result.structuredContent.found, false);
  });

  test("list_recent_texts shows texts with and without codes, newest first", async () => {
    const name = uniqueWord();
    await sendLikeFwrd(fwrdUrl, `${name} sign-in link: https://example.com/login/abc`, { sender: "Acme" });
    await sleep(20);
    await sendLikeFwrd(fwrdUrl, `${name} code 556 677`);
    const { texts } = toolResult(await client().callTool("list_recent_texts", { contains: name, minutes: 5 }))
      .structuredContent;
    assert.equal(texts.length, 2);
    assert.equal(texts[0].code, "556677");
    assert.equal(texts[1].code, undefined);
    assert.equal(texts[1].sender, "Acme");
    assert.match(texts[1].text, /example\.com\/login/);
    assert.ok(!Number.isNaN(Date.parse(texts[0].received_at)));
    assert.equal(typeof texts[0].seconds_ago, "number");
  });

  test("bad arguments come back as a tool error the agent can read", async () => {
    const result = toolResult(await client().callTool("wait_for_sms_code", { service: "github" }));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown argument "service"/);
  });

  test("unknown tools, unknown methods and malformed messages are JSON-RPC errors", async () => {
    assert.equal((await client().callTool("send_sms")).json.error.code, -32602);
    const unknown = await client().request("resources/list");
    assert.equal(unknown.status, 200);
    assert.equal(unknown.json.error.code, -32601);
    const notJson = await postMcp(server, "{nope");
    assert.equal(notJson.status, 400);
    assert.equal(notJson.json.error.code, -32700);
    const notRpc = await postMcp(server, { id: 1, method: "ping" });
    assert.equal(notRpc.status, 400);
    assert.equal(notRpc.json.error.code, -32600);
  });
});

describe("MCP with older protocol versions", () => {
  test("initialize keeps 2024-11-05 and answers 2025-11-25 to a version it doesn't know", async () => {
    assert.equal((await legacyClient(server).initialize("2024-11-05")).json.result.protocolVersion, "2024-11-05");
    assert.equal((await legacyClient(server).initialize("1999-01-01")).json.result.protocolVersion, "2025-11-25");
  });

  test("2025-03-26 (and no version header) gets results without outputSchema or structuredContent", async () => {
    const name = uniqueWord();
    await sendLikeFwrd(fwrdUrl, `${name} code 314159`);
    const client = legacyClient(server, "2025-03-26");
    const { tools } = (await client.request("tools/list")).json.result;
    assert.equal(tools[0].outputSchema, undefined);
    const result = toolResult(await client.callTool("wait_for_sms_code", { contains: name, timeout_seconds: 2 }));
    assert.equal(result.structuredContent, undefined);
    assert.equal(JSON.parse(result.content[0].text).code, "314159");

    const noHeader = await postMcp(server, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(noHeader.json.result.tools[0].outputSchema, undefined);
  });

  test("an MCP-Protocol-Version header it doesn't support is a 400", async () => {
    const response = await legacyClient(server, "2099-01-01").request("tools/list");
    assert.equal(response.status, 400);
  });
});

describe("MCP without a handshake (2026-07-28)", () => {
  const client = () => modernClient(server);

  test("server/discover lists the supported versions, capabilities and caching hints", async () => {
    const { status, json } = await client().request("server/discover");
    assert.equal(status, 200);
    assert.equal(json.result.resultType, "complete");
    assert.deepEqual(json.result.supportedVersions, ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
    assert.deepEqual(json.result.capabilities, { tools: { listChanged: false } });
    assert.equal(json.result.cacheScope, "public");
    assert.ok(Number.isInteger(json.result.ttlMs) && json.result.ttlMs >= 0);
    assert.equal(json.result._meta["io.modelcontextprotocol/serverInfo"].name, "fwrd-sms-mcp");
  });

  test("tools/list and tools/call work with no initialize", async () => {
    const list = (await client().request("tools/list")).json.result;
    assert.equal(list.resultType, "complete");
    assert.equal(list.tools.length, 2);
    assert.ok(Number.isInteger(list.ttlMs));

    const name = uniqueWord();
    await sendLikeFwrd(fwrdUrl, `${name}: 778899 is your code`);
    const result = toolResult(await client().callTool("wait_for_sms_code", { contains: name, timeout_seconds: 5 }));
    assert.equal(result.resultType, "complete");
    assert.equal(result.structuredContent.code, "778899");
  });

  test("headers that don't match the body are a 400 with -32020", async () => {
    const wrongMethod = await client().request("tools/list", {}, { headers: { "Mcp-Method": "prompts/list" } });
    const noName = await postMcp(
      server,
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "list_recent_texts",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
      { headers: { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call" } },
    );
    const wrongVersion = await client().request("tools/list", {}, { headers: { "MCP-Protocol-Version": "2025-11-25" } });
    for (const response of [wrongMethod, noName, wrongVersion]) {
      assert.equal(response.status, 400, response.text);
      assert.equal(response.json.error.code, -32020);
    }
  });

  test("an unsupported version is a 400 with -32022 and the supported list", async () => {
    const response = await modernClient(server, "2027-01-01").request("tools/list");
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, -32022);
    assert.deepEqual(response.json.error.data.requested, "2027-01-01");
    assert.ok(response.json.error.data.supported.includes("2026-07-28"));
  });

  test("methods it doesn't have (ping was removed in 2026-07-28) are a 404 with -32601", async () => {
    const response = await client().request("ping");
    assert.equal(response.status, 404);
    assert.equal(response.json.error.code, -32601);
  });
});

describe("Deleting old texts (KEEP_SECONDS=2)", () => {
  let shortServer;
  before(async () => {
    shortServer = await startServer({ KEEP_SECONDS: "2" });
  });
  after(async () => {
    await shortServer?.stop();
  });

  test("the alarm deletes an expired text with no request coming in", async () => {
    await sendLikeFwrd(`${shortServer.url}/fwrd/${shortServer.fwrdToken}`, "Code 123456");
    assert.equal(await storedTextCount(shortServer), 1);
    // The alarm is set for 1 second after the text expires.
    await sleep(4500);
    assert.equal(await storedTextCount(shortServer), 0);
  });

  test("a request deletes expired texts before it reads", async () => {
    await sendLikeFwrd(`${shortServer.url}/fwrd/${shortServer.fwrdToken}`, "Code 654321");
    await sleep(2300); // expired, but before the alarm at about 3 seconds
    const { texts } = toolResult(await legacyClient(shortServer).callTool("list_recent_texts")).structuredContent;
    assert.deepEqual(texts, []);
    assert.equal(await storedTextCount(shortServer), 0);
  });
});
