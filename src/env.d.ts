// FWRD_TOKEN and MCP_TOKEN are secrets, set with `wrangler secret put` (or in .dev.vars for
// local dev), so `wrangler types` can't see them in wrangler.jsonc. They're declared here
// with the same type wrangler would give them. The code still handles a missing value,
// because a Worker can be deployed before its secrets are set.
interface Env {
  FWRD_TOKEN: string;
  MCP_TOKEN: string;
}
