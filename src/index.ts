import { errorReply, errorText, handleMcpBody, INTERNAL_ERROR, INVALID_REQUEST, PARSE_ERROR, type Reply } from "./mcp";

export { Inbox } from "./inbox";

/** Fwrd posts one short text at a time; anything bigger than this isn't from Fwrd. */
const MAX_BODY_BYTES = 64 * 1024;
/** A shorter secret could be guessed, and both secrets live in URLs. */
const MIN_SECRET_LENGTH = 16;

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);
      // "/fwrd/<token>" -> ["fwrd", "<token>"]
      const [route, token, ...rest] = url.pathname.split("/").filter((part) => part !== "");
      if (route === "fwrd" && rest.length === 0) return await receiveText(request, env, url, token);
      if (route === "mcp" && rest.length === 0) return await serveMcp(request, env, token);
      if (route === undefined && (request.method === "GET" || request.method === "HEAD")) {
        return new Response(
          "fwrd-sms-mcp is running. Fwrd posts texts to /fwrd/<FWRD_TOKEN>; MCP clients connect to /mcp.\n",
          { headers: { "Content-Type": "text/plain; charset=utf-8" } },
        );
      }
      return new Response("Not found\n", { status: 404 });
    } catch (error) {
      console.error(JSON.stringify({ message: "unhandled error", error: errorText(error) }));
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * The URL pasted into Fwrd's Webhook destination: POST /fwrd/<FWRD_TOKEN>, or
 * POST /fwrd?token=<FWRD_TOKEN>. Fwrd sends no auth header, so the secret is in the URL.
 */
async function receiveText(request: Request, env: Env, url: URL, pathToken: string | undefined): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "Fwrd sends POST requests here." }, { status: 405, headers: { Allow: "POST" } });
  }
  const setupProblem = secretProblem("FWRD_TOKEN", env.FWRD_TOKEN);
  if (setupProblem) return Response.json({ error: setupProblem }, { status: 500 });

  const given = pathToken !== undefined ? decodePathPart(pathToken) : url.searchParams.get("token");
  if (given === null || !(await sameSecret(given, env.FWRD_TOKEN))) {
    return Response.json({ error: "Wrong or missing token." }, { status: 401 });
  }

  const raw = await readBody(request);
  if (raw === null) return Response.json({ error: "The body is over 64 KB." }, { status: 413 });
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json({ error: "The body isn't JSON." }, { status: 400 });
  }
  // Fwrd sends the message twice, as "content" and "text"; "content" is the one kept.
  if (typeof payload !== "object" || payload === null || !("content" in payload) || typeof payload.content !== "string") {
    return Response.json({ error: 'The body needs a "content" string.' }, { status: 400 });
  }
  const sender =
    "sender" in payload && typeof payload.sender === "string" && payload.sender.trim() !== ""
      ? payload.sender
      : null;
  const key = request.headers.get("Idempotency-Key");
  if (key !== null && key.length > 200) {
    return Response.json({ error: "The Idempotency-Key header is too long." }, { status: 400 });
  }

  const stored = await env.INBOX.getByName("inbox").addText(payload.content, sender, key || null);
  log(env, { message: stored ? "text stored" : "repeat ignored" }, payload.content);
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * The MCP endpoint: POST /mcp with "Authorization: Bearer <MCP_TOKEN>", or POST
 * /mcp/<MCP_TOKEN> for clients that can't send headers.
 */
async function serveMcp(request: Request, env: Env, pathToken: string | undefined): Promise<Response> {
  // No SSE stream and no sessions, so GET and DELETE aren't offered.
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

  // The MCP spec asks servers to check Origin against DNS rebinding. Every request here needs
  // MCP_TOKEN anyway; set ALLOWED_ORIGINS to also refuse calls from other websites.
  const origin = request.headers.get("Origin");
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (origin !== null && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
    return rpcResponse(errorReply(403, undefined, INVALID_REQUEST, `Origin ${origin} isn't in ALLOWED_ORIGINS.`));
  }

  const setupProblem = secretProblem("MCP_TOKEN", env.MCP_TOKEN);
  if (setupProblem) return rpcResponse(errorReply(500, undefined, INTERNAL_ERROR, setupProblem));
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1]?.trim() ?? null;
  const fromPath = pathToken !== undefined ? decodePathPart(pathToken) : null;
  const authorized =
    (bearer !== null && (await sameSecret(bearer, env.MCP_TOKEN))) ||
    (fromPath !== null && (await sameSecret(fromPath, env.MCP_TOKEN)));
  if (!authorized) {
    const reply = errorReply(
      401,
      undefined,
      INVALID_REQUEST,
      "Unauthorized. Send Authorization: Bearer <MCP_TOKEN>, or connect to /mcp/<MCP_TOKEN>.",
    );
    return rpcResponse(reply, { "WWW-Authenticate": 'Bearer realm="fwrd-sms-mcp"' });
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json(\s*;|\s*$)/i.test(contentType)) {
    return rpcResponse(errorReply(415, undefined, INVALID_REQUEST, "Content-Type must be application/json."));
  }
  const accept = request.headers.get("Accept");
  if (accept !== null && !/application\/json|application\/\*|\*\/\*/i.test(accept)) {
    return rpcResponse(errorReply(406, undefined, INVALID_REQUEST, "This server answers with application/json."));
  }

  const raw = await readBody(request);
  if (raw === null) return rpcResponse(errorReply(413, undefined, INVALID_REQUEST, "The body is over 64 KB."));
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return rpcResponse(errorReply(400, undefined, PARSE_ERROR, "Parse error: the body isn't JSON."));
  }

  const reply = await handleMcpBody(body, request.headers, {
    inbox: env.INBOX.getByName("inbox"),
    signal: request.signal,
  });
  return rpcResponse(reply);
}

function rpcResponse(reply: Reply, extraHeaders: Record<string, string> = {}): Response {
  if (reply.body === undefined) return new Response(null, { status: reply.status, headers: extraHeaders });
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

/** Why a secret can't be used yet, or null when it's fine. */
function secretProblem(name: string, value: string | undefined): string | null {
  if (!value) return `${name} isn't set. Run: npx wrangler secret put ${name}`;
  if (value.length < MIN_SECRET_LENGTH) {
    return `${name} is too short. Use at least ${MIN_SECRET_LENGTH} characters, for example from: openssl rand -hex 32`;
  }
  return null;
}

/** Compares secrets without leaking, through timing, how much of a guess was right. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function decodePathPart(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/** The body as text, or null when it's over the size limit. */
async function readBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("Content-Length") ?? "0") > MAX_BODY_BYTES) return null;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** One JSON line per event. Message text is added only when DEBUG is "true". */
function log(env: Env, fields: Record<string, unknown>, content: string): void {
  // String(): wrangler types the var as its default value, the literal "false".
  console.log(JSON.stringify(String(env.DEBUG) === "true" ? { ...fields, content } : fields));
}
