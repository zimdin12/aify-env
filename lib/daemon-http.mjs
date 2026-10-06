// HTTP transport only. Dependency resolution stays lazy and inside each request's catch.
import { handleRequest } from "./protocol.mjs";
import { browserOriginatedRequest } from "./browser-requests.mjs";
import { dataFrame, exitFrame, keepStreamAlive, namedFrame } from "./sse-frames.mjs";

const chr10 = String.fromCharCode(10);

export function createDaemonHttp({ runner, traffic, protocolDeps }) {
  return async (request, response) => {
  traffic.requests += 1;

  // BEFORE THE BODY IS READ, and before anything is dispatched. A page the operator merely visits can
  // reach this loopback port; binding 127.0.0.1 keeps the network out but not the browser, which is
  // already on the machine. See lib/browser-requests.mjs for the request shape that needs no
  // preflight. Refused here rather than in `handleRequest` because it is a property of the TRANSPORT,
  // not of any route, and a route added later must inherit it without anyone remembering to ask.
  const browser = browserOriginatedRequest({ method: request.method, headers: request.headers });
  if (browser.refuse) {
    process.stderr.write(`[aify-env] ${browser.reason}${chr10}`);
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: browser.reason }));
    return;
  }

  let body = null;
  if (request.method === "POST" || request.method === "PUT") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
    } catch {
      body = undefined;
    }
  }

  let result;
  try {
    result = await handleRequest(
      { method: request.method, path: new URL(request.url, "http://localhost").pathname, body },
      await protocolDeps(),
    );
  } catch (failure) {
    // An unexpected throw must not leave a caller hanging, and must not leak a stack to it either.
    process.stderr.write(`[aify-env] unhandled: ${failure.stack ?? failure}\n`);
    result = { status: 500, body: { error: "internal error" } };
  }

  // A stream, not an answer. Server-sent events because a console only ever reads: no framing to get
  // wrong, no upgrade handshake, and it reconnects by itself when a viewer's tab wakes up.
  if (result.stream) {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    // A QUIET PROCESS MUST NOT LET A VIEWER'S FETCH TIME OUT: Node aborts a body after 300s with no bytes.
    // Idle Claude Code panes died exactly that way on 2026-09-14; the heartbeat's reasons live with it.
    keepStreamAlive(response);
    // META FIRST, then the replay -- or, for a PTY, the daemon's checkpointed screen -- then live bytes.
    // `subscribeScreen` owns that order and why it is exact; `namedFrame` says why a new fact can join
    // an existing stream safely.
    const unsubscribe = runner.subscribeScreen(result.stream, {
      onMeta: (meta) => response.write(namedFrame("meta", meta)),
      onOutput: (chunk) => {
        response.write(dataFrame(chunk));
        traffic.bytesOut += Buffer.byteLength(chunk);
      },
      onExit: (code, signal) => {
        // THEN THE STREAM ENDS. A console told the process is gone has nothing left to wait for, and
        // leaving it open makes a dead agent look like a thinking one -- which is the failure this
        // event exists to prevent. The frame's own rules live in `lib/sse-frames.mjs`.
        response.write(exitFrame(code, signal));
        response.end();
      },
      // A RESIZE IS A NEW `meta`, not a new frame type; a consumer takes only its geometry.
      onResize: ({ cols, rows }) => {
        response.write(namedFrame("meta", { ...(runner.streamMeta?.(result.stream) ?? {}), cols, rows }));
      },
    });
    if (!unsubscribe) {
      // Raced: the process went between the route check and here.
      response.end();
      return;
    }
    // A viewer closing its tab must release the subscription, or every visit leaks one.
    request.on("close", () => unsubscribe());
    return;
  }

  if (result.body === null) {
    response.writeHead(result.status);
    response.end();
    return;
  }
  const payload = JSON.stringify(result.body);
  traffic.bytesOut += Buffer.byteLength(payload);
  response.writeHead(result.status, { "content-type": "application/json" });
  response.end(payload);
  };
}
