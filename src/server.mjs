// Local server: node src/server.mjs (PORT, default 8787). Node's http module in front of the web-standard router,
// so the exact code that runs on Lambda runs here too.
import http from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.mjs';
import { Mandat } from './mandat.mjs';
import { createStore } from './store/index.mjs';
import { createProvider } from './providers/index.mjs';
import { SimulatedBrain } from './brain/simulated.mjs';

export function toRequest(req, base) {
  const url = new URL(req.url, base);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  headers.set('x-mandat-client-ip', req.socket?.remoteAddress || 'local');
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  return new Request(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: hasBody ? 'half' : undefined });
}

export async function sendResponse(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, headers);
  if (response.body) for await (const chunk of response.body) res.write(chunk);
  res.end();
}

// Builds everything from env; returns { server, url, service, close }. port 0 = random (tests).
export async function start({ port = Number(process.env.PORT) || 8787, host = process.env.HOST || '127.0.0.1', storeKind, modelKind, brainKind = process.env.MANDAT_BRAIN || 'simulated' } = {}) {
  const service = new Mandat({ store: createStore(storeKind), provider: createProvider(modelKind) });
  let brain = null;
  const server = http.createServer();
  await new Promise((r) => server.listen(port, host, r));
  const url = `http://${host}:${server.address().port}`;
  service.publicUrl = process.env.MANDAT_PUBLIC_URL || url;
  if (brainKind === 'simulated') brain = new SimulatedBrain({ mcpUrl: process.env.MANDAT_MCP_URL || `${url}/mcp`, headers: process.env.MANDAT_DEMO_TOKEN ? { Authorization: `Bearer ${process.env.MANDAT_DEMO_TOKEN}` } : {} });
  if (brainKind === 'strands') brain = await (await import('../orchestrator/brain.mjs')).createStrandsBrain({ mcpUrl: `${url}/mcp` });
  const app = createApp({ service, brain, mcpUrl: `${url}/mcp`, allowedOrigins: (process.env.MANDAT_ALLOWED_ORIGINS || `${url},http://localhost:${server.address().port}`).split(',') });
  server.on('request', async (req, res) => {
    try { await sendResponse(res, await app(toRequest(req, url))); } catch (e) { console.error(e); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  return { server, url, service, close: () => new Promise((r) => server.close(r)) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url, service } = await start();
  console.log(`Mandat for Alexa+ on ${url}`);
  console.log(`  MCP endpoint   ${url}/mcp   (Streamable HTTP, stateless, JSON responses)`);
  console.log(`  Simulator      ${url}/simulator/`);
  console.log(`  model=${service.provider.name} store=${service.store.kind} paypal=${(await import('./core/paypal.mjs')).MODE}`);
}
