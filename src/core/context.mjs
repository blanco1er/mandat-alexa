// Per-request context for the MCP server: which household, which voice turn (for the live activity feed) and which
// locale the user speaks. Set once by the tool wrapper (src/mcp/server.mjs) from the request headers, then read
// anywhere below without threading arguments through every call.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();
export const TURN_RE = /^[a-z0-9-]{6,48}$/i;

export const runWith = (ctx, fn) => als.run(ctx, fn);
export const current = () => als.getStore() || {};

// One header value from MCP request info (Node headers object: string | string[]).
export function header(extra, name) {
  const h = extra?.requestInfo?.headers?.[name];
  return Array.isArray(h) ? h[0] : h;
}
