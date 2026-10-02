// The aify-dashboard plugin's key goes to its entry's endpoint and nowhere else, redirects included.
//
// A fetch follows a 3xx by default, carrying every header with it. A dashboard (or anything answering on its port)
// that redirected would hand the key to wherever the redirect pointed. Both calls the plugin makes carry the key, so
// both are asserted, against a real listener that would receive the redirected request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { DashboardApi, DashboardApiError } from "../lib/plugins/aify-dashboard/dashboard-api.mjs";

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("a redirect is refused, and the place it points to never sees the key", async (t) => {
  const elsewhere = [];
  const target = await listen((request, response) => {
    elsewhere.push({ url: request.url, key: request.headers["x-api-key"] });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ hostKey: "h", projects: [] }));
  });
  t.after(target.close);
  const redirecting = await listen((request, response) => {
    response.writeHead(request.method === "POST" ? 307 : 302, { location: `${target.origin}${request.url}` });
    response.end();
  });
  t.after(redirecting.close);

  // Positive control: the listener the redirect points to records what reaches it, key and all.
  await fetch(`${target.origin}/control`, { headers: { "x-api-key": "control" } });
  assert.deepEqual(elsewhere, [{ url: "/control", key: "control" }]);
  elsewhere.length = 0;

  const api = new DashboardApi({ endpoint: redirecting.origin, credential: async () => "the-key" });
  await assert.rejects(api.watchList("h"), (error) => error instanceof DashboardApiError && error.status === 302);
  await assert.rejects(api.reportHead({ machineId: "win32:h", path: "C:/x", head: "a".repeat(40), reporter: "r" }),
    (error) => error instanceof DashboardApiError && error.status === 307);
  assert.deepEqual(elsewhere, [], "nothing reached the redirect's target");
});
