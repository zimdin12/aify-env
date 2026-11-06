// A real loopback HTTP socket around the inert transport, never the daemon entry or a live endpoint.
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import { createDaemonHttp } from '../../lib/daemon-http.mjs';
import { hostConfigFrom } from '../../lib/host-config.mjs';

export async function authorityServer(t, settings = {}, { worker = false } = {}) {
  const seen = { bodies: 0, deps: 0, streams: 0, hosts: [], requests: [] };
  const record = { id: 'p', pid: 123, terminal: true, startedAtMs: Date.now(), label: 'fixture' };
  const runner = {
    instance: () => 'fixture', list: () => worker ? [record] : [], canStream: () => true,
    start: async () => record,
    subscribeScreen(_id, events) {
      seen.streams++;
      events.onMeta({ cols: 80, rows: 24 });
      const end = setImmediate(() => events.onExit(0, null));
      return () => clearImmediate(end);
    },
  };
  const answer = (_id, _body) => ({ status: 200, body: { ok: true, applied: true } });
  const handler = createDaemonHttp({ runner, traffic: { requests: 0, bytesOut: 0 },
    hostConfig: hostConfigFrom(JSON.stringify(settings)),
    protocolDeps: async () => {
      seen.deps++;
      return { runner, version: 'fixture', readFile: file => fs.readFileSync(file, 'utf8'), turnEvents: { receive: answer },
        gateways: { receive: () => ({ status: 200, body: { ok: true, live: true, port: 4444, token: 'fixture', wsUrl: 'ws://127.0.0.1:4444/' } }) },
        lifecycle: { residentStarted: answer }, agents: { start: async () => ({ started: true }) },
        agentServices: [{ service: 'fixture', importable: async () => ({ agents: [] }) }] };
    },
  });
  const server = http.createServer((request, response) => {
    seen.hosts.push(request.headers.host ?? null);
    response.once('finish', () => seen.requests.push({ method: request.method, path: request.url, host: request.headers.host ?? null, status: response.statusCode }));
    const iterate = request[Symbol.asyncIterator].bind(request);
    request[Symbol.asyncIterator] = () => { seen.bodies++; return iterate(); };
    void handler(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const port = server.address().port;
  return { server, port, endpoint: `http://127.0.0.1:${port}`, seen };
}

export function authorityRequest(port, { method = 'GET', path = '/health', host = `127.0.0.1:${port}`, headers = {}, body = '', rawHeaders } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method, path, agent: false,
      setHost: false, headers: rawHeaders ?? { ...(host === null ? {} : { Host: host }), ...headers },
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text, headers: response.headers }));
    });
    request.setTimeout(5000, () => request.destroy(new Error('fixture HTTP request timed out')));
    request.on('error', reject);
    request.end(body);
  });
}
