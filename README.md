# fwrd-sms-mcp

An MCP server that hands your AI agent the SMS verification codes sent to your iPhone. It needs
the [Fwrd](https://www.fwrdsms.com) iPhone app, which forwards each text to the server, and you
deploy it to your own Cloudflare account.

**How it works:** a text reaches your iPhone → Fwrd posts it to your Worker → your agent calls
`wait_for_sms_code` and gets the code.

Fwrd has no server and no account. The iPhone posts each text straight to your Worker, which
keeps it for 15 minutes.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alanwtom/fwrd-sms-mcp)

The button copies this repo to your GitHub account and deploys it, Durable Object included. It
asks for the two secrets listed in `.dev.vars.example`. Make each with `openssl rand -hex 32`, and
use two different values:

- `FWRD_TOKEN`: the end of the URL you paste into Fwrd.
- `MCP_TOKEN`: what your AI client sends.

Or with wrangler (Node 22 or later):

```sh
git clone https://github.com/alanwtom/fwrd-sms-mcp && cd fwrd-sms-mcp
npm install
npx wrangler login
npx wrangler deploy                  # prints https://fwrd-sms-mcp.<your-subdomain>.workers.dev
npx wrangler secret put FWRD_TOKEN   # paste a value from: openssl rand -hex 32
npx wrangler secret put MCP_TOKEN    # a different value
```

Until both secrets are set, the endpoints answer with an error that says which one is missing.

## Set up Fwrd on the iPhone

1. In Fwrd, tap +, choose **Webhook**, and paste
   `https://fwrd-sms-mcp.<your-subdomain>.workers.dev/fwrd/<FWRD_TOKEN>` into the Configuration
   field. Tap **Send Test Message** (it shows up in `list_recent_texts`), then save with the tick.
2. In the same destination, choose **Only Some Texts** under Which Texts and turn on **Looks Like
   a Code**. Then only texts with a 4 to 8 digit code leave the phone.
3. Create the Message automation in Shortcuts that hands each text to Fwrd:
   [automation guide](https://www.fwrdsms.com/guides/automation). The
   [webhook guide](https://www.fwrdsms.com/guides/webhook) covers the destination in full.

## Connect your AI client

Replace `<worker>` with your `fwrd-sms-mcp.<your-subdomain>.workers.dev` address.

**Claude Code**

```sh
claude mcp add --transport http fwrd-sms https://<worker>/mcp --header "Authorization: Bearer <MCP_TOKEN>"
```

**Cursor**: in `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project). `${env:FWRD_MCP_TOKEN}`
reads the token from your environment; you can paste it in instead.

```json
{
  "mcpServers": {
    "fwrd-sms": {
      "url": "https://<worker>/mcp",
      "headers": { "Authorization": "Bearer ${env:FWRD_MCP_TOKEN}" }
    }
  }
}
```

**claude.ai and Claude Desktop**: Customize → Connectors → + Add → Add custom connector (on Team
and Enterprise plans an Owner adds it under Organization settings → Connectors). Enter the URL
`https://<worker>/mcp` and set Authentication to **No sign-in**. If the dialog has **Request
headers** (a beta that Anthropic says only some organizations have), add an `authorization` header
with the value `Bearer <MCP_TOKEN>`. If it doesn't, enter `https://<worker>/mcp/<MCP_TOKEN>` as the
URL instead. These connectors reach your Worker from Anthropic's cloud, not from your computer.

**Any client that supports Streamable HTTP**: `https://<worker>/mcp` with the header
`Authorization: Bearer <MCP_TOKEN>`. If it can't send headers, use
`https://<worker>/mcp/<MCP_TOKEN>`, and keep that URL as private as a password.

## Agent skill

[`skills/sms-verification-codes`](skills/sms-verification-codes/SKILL.md) teaches a coding agent
when to call these tools and how to set all this up with you. Install it with
[skills](https://skills.sh) for Claude Code, Cursor, Codex and other agents:

```sh
npx skills add alanwtom/fwrd-sms-mcp
```

## Tools

| Tool | Arguments | What it does |
|---|---|---|
| `wait_for_sms_code` | `contains` (optional word the text must include, such as the service's name), `max_age_seconds` (default 120), `timeout_seconds` (default 50, up to 100) | Returns the newest code not yet handed out, including one that arrived up to `max_age_seconds` before the call. Otherwise waits until one arrives or the time runs out. Each code is handed out once. On a timeout it returns a normal result telling the agent no code arrived and to ask the site to resend. |
| `list_recent_texts` | `minutes` (1 to 15, default 10), `contains` (optional) | The texts from the last few minutes, newest first, with sender (when Fwrd sends it), time and any code. For login links and messages that aren't digit codes. |

The default wait is 50 seconds because Claude Code, and clients built on the official TypeScript
SDK, stop waiting for a request after 60 seconds unless configured otherwise. claude.ai and Claude
Desktop allow 240 seconds per tool call. In Claude Code, a `timeout` field (in milliseconds) on the
server's configuration entry raises the limit, and then agents can ask for up to 100 seconds.

## What Fwrd sends

Checked in the source of the shipped Fwrd 1.2.1 and of 1.3.1:

| | |
|---|---|
| Request | One `POST` per forwarded text, to an `https://` URL on a public hostname: not localhost, IP addresses, `.local`, `.lan`, `.internal` or `.test`; no `user:pass@`, no `#fragment`. A `workers.dev` address is fine. |
| Headers | `Content-Type: application/json` and `Idempotency-Key: <UUID>`, the same key on retries. No auth header, so the secret lives in the URL. |
| Body | `{"content": "<message exactly as it arrived>", "text": "<the same message again>"}`, plus `"sender": "<who sent it>"` only when Include Who Sent It is on in Fwrd's Settings and the Sender field is set on Fwrd's Shortcuts action. |
| Success | Any `2xx` within 15 seconds. This server answers `200 {"ok":true}` straight away. |
| Retries | On `429`, `5xx` or a dropped connection, at most twice, honouring `Retry-After`. Redirects aren't followed. This server stores a repeated `Idempotency-Key` once. |
| Which texts | Only new texts that match the Shortcuts automation, and Fwrd's filters on the destination: Looks Like a Code, certain words, time of day. |

The webhook answers `401` for a wrong token, `400` for a body that isn't JSON or has no
`content`, `413` over 64 KB, and `405` for anything but `POST`. It accepts the token as
`/fwrd/<FWRD_TOKEN>` or `/fwrd?token=<FWRD_TOKEN>`.

## Protocol

MCP Streamable HTTP at `/mcp`: stateless, JSON responses, no SSE, no sessions. It speaks
`2026-07-28` (no handshake: `server/discover`, with the version in every request) and the
handshake versions `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05` (`initialize`,
`notifications/initialized`, `ping`). `tools/list` and `tools/call` work in both. `GET /mcp` is `405`.

Every request needs `MCP_TOKEN`. The MCP spec asks servers to check the `Origin` header against DNS
rebinding: set `ALLOWED_ORIGINS` in `wrangler.jsonc` to a comma-separated list, and a request whose
`Origin` isn't on it gets `403`. Requests with no `Origin` (desktop apps, servers) aren't affected.
While the list is empty, any `Origin` is accepted.

## Privacy

- It runs in your Cloudflare account. Fwrd never sees your texts.
- Each text is deleted 15 minutes after it arrives: on every webhook and tool call, and by a Durable
  Object alarm when nothing comes in. Set `KEEP_SECONDS` lower to delete sooner.
- It stores only what Fwrd sends (the message, and the sender if sent), when it arrived, the code
  found in it, the `Idempotency-Key`, and whether the code was handed out.
- The Worker's own log lines never contain message text or tokens. Cloudflare's request logs and
  traces, which record each URL and so your tokens, are off in `wrangler.jsonc`. `DEBUG` set to
  `"true"` logs message text, for local debugging.

## Use it responsibly

Use it only for accounts you own or are allowed to automate. Where a service offers API tokens, an
authenticator app or passkeys, prefer those to SMS codes. Some banks' terms forbid sharing one-time
codes, so check before you forward them. Message text comes from whoever sent the SMS; the tool
descriptions tell agents to treat it as data, not instructions.

## Develop

```sh
cp .dev.vars.example .dev.vars   # then fill in both tokens
npm run dev                      # http://localhost:8787
npm test                         # end-to-end tests against wrangler dev
npm run test:inspector           # the official MCP Inspector, both protocol eras
npm run typecheck
```

**Tested** on 2026-10-26 with `wrangler dev` 4.152.0: `npm test` passes all 30 end-to-end checks,
and the official MCP Inspector 2.12.0 in CLI mode (`npm run test:inspector`) lists both tools and
gets the waiting code back from `wait_for_sms_code`, with `--protocol-era legacy` (negotiates
`2025-11-25`) and `--protocol-era modern` (`2026-07-28`). The Inspector command, per era:

```sh
npx @modelcontextprotocol/inspector@2.12.0 --cli http://127.0.0.1:8787/mcp --transport http \
  --protocol-era modern --header "Authorization: Bearer $MCP_TOKEN" --format json \
  --method tools/call --tool-name wait_for_sms_code --tool-arg contains=Inspector --tool-arg timeout_seconds=5
```

The same with `--method tools/list` lists `wait_for_sms_code, list_recent_texts`, and `--strict`
reports no schema portability problems.

## Fwrd

Fwrd is free for 15 forwarded texts a month (one text counts once, however many places it goes).
Fwrd Pro is $4.99 a month or $29.99 a year (US prices, October 2026).

[fwrdsms.com](https://www.fwrdsms.com) ·
[Fwrd on the App Store](https://apps.apple.com/app/apple-store/id6759069713?pt=128544281&ct=github-mcp&mt=8) ·
[Webhook examples](https://github.com/alanwtom/fwrd-sms-webhook-examples) ·
[Let an AI agent read SMS verification codes](https://www.fwrdsms.com/blog/ai-agent-sms-verification-codes)

MIT licensed.
