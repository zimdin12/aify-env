// The three calls this plugin makes to aify-comms, and the identity they carry.
//
// WHAT THESE PIN. The credential is fetched per call rather than captured, because a client holding
// a boot-time copy keeps presenting a rotated key until restarted -- measured 2026-09-02, a
// credential was stored while the process needing it had read its absence at boot and every request
// 401'd for hours with both sides reporting healthy. The heartbeat carries a `bridgeId`, which is
// the ONLY reason the service stamps `bridgeLastSeen` and therefore the only reason a spawn can be
// claimed at all. And "unreachable" is kept distinguishable from "refused": one means retry, the
// other means a person has to change something.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CLAIM_WAIT_MS,
  CLAIM_TIMEOUT_MS,
  CommsApi,
  CommsApiError,
  REQUEST_TIMEOUT_MS,
  mintBridgeIdentity,
} from "../lib/plugins/aify-comms/api.mjs";

/** A fetch stand-in that records calls and answers however the test needs. */
function fakeFetch({ status = 200, json = {}, text = "", throws = null } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    if (throws) throw new Error(throws);
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return json; },
      async text() { return text; },
    };
  };
  impl.calls = calls;
  return impl;
}

const IDENTITY = mintBridgeIdentity({ version: "0.6.1" });

function api(fetchImpl, { credential = async () => "banana" } = {}) {
  return new CommsApi({
    endpoint: "http://127.0.0.1:8800",
    credential,
    identity: IDENTITY,
    fetchImpl,
  });
}

test("a bridge identity is minted once and is not derived from the machine", () => {
  // Restarting must read as a NEW claimer: the previous one's in-flight work is no longer tracked,
  // and reusing an id would make the service believe it still is.
  const a = mintBridgeIdentity({ version: "0.6.1" });
  const b = mintBridgeIdentity({ version: "0.6.1" });
  assert.notEqual(a.bridgeId, b.bridgeId);
  assert.equal(a.bridgeVersion, "0.6.1");
  assert.match(a.bridgeStartedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("the heartbeat carries the bridgeId, which is the whole reason it exists", async () => {
  // This host's ordinary advertisement deliberately omits the id -- it describes the host rather
  // than offering to run things -- so without this the row reads `online` and every spawn is refused.
  const f = fakeFetch();
  await api(f).heartbeat({ hostname: "StevenZ-L", kind: "windows" });
  const body = JSON.parse(f.calls[0].options.body);

  // `bridgeId` TOP-LEVEL. The service reads `req.bridgeId` to decide whether the caller is a bridge
  // at all, and nothing else stamps `bridgeLastSeen`.
  assert.equal(body.bridgeId, IDENTITY.bridgeId);

  // AND THE REST INSIDE `metadata`, which is WHERE, not merely THAT -- the distinction this test
  // missed and the defect it let through. Supersession arbitration reads the incoming start time
  // from `metadata`; sent top-level it is invisible, so the service takes the "keep the existing
  // bridge" branch and returns ok:true while stamping NOTHING. An accepted-and-ignored heartbeat is
  // indistinguishable from one that worked, so this cost a live debugging session against the real
  // service rather than one red test here.
  assert.equal(body.metadata?.bridgeStartedAt, IDENTITY.bridgeStartedAt,
    "bridgeStartedAt must be inside metadata; top-level it is silently ignored");
  assert.equal(body.metadata?.bridgeVersion, "0.6.1");
  assert.equal(body.bridgeStartedAt, undefined,
    "sending it top-level as well would be the shape that failed");

  assert.equal(body.hostname, "StevenZ-L", "the generic advertisement must survive alongside it");
  assert.match(f.calls[0].url, /\/api\/v1\/environments\/heartbeat$/);
});

test("the credential is read on EVERY call, not captured at construction", async () => {
  let current = "first";
  const f = fakeFetch();
  const client = api(f, { credential: async () => current });
  await client.heartbeat({});
  current = "rotated";
  await client.heartbeat({});
  assert.equal(f.calls[0].options.headers["X-API-Key"], "first");
  assert.equal(f.calls[1].options.headers["X-API-Key"], "rotated",
    "a client holding a boot-time key keeps presenting it after a rotation");
});

test("no key means no header, rather than an empty one", async () => {
  // An empty `X-API-Key` is a WRONG key to a service that requires one, and the two produce
  // different diagnoses -- "the key is wrong" sends someone somewhere else than "there is no key".
  const f = fakeFetch();
  await api(f, { credential: async () => "" }).heartbeat({});
  assert.equal("X-API-Key" in f.calls[0].options.headers, false);
});

test("a claim asks for one request and says how long it may wait", async () => {
  const f = fakeFetch({ json: { spawnRequest: { id: "req-1" } } });
  const result = await api(f).claim({ environmentId: "windows:host:default", machineId: "m1" });
  const body = JSON.parse(f.calls[0].options.body);
  assert.equal(body.environmentId, "windows:host:default");
  assert.equal(body.bridgeId, IDENTITY.bridgeId);
  assert.equal(body.waitMs, CLAIM_WAIT_MS);
  assert.equal(result.spawnRequest.id, "req-1");
});

test("the claim wait is shorter than the claim timeout", () => {
  // A quiet period must end with the SERVICE answering "nothing", not with this side timing out.
  // From here a timeout and an idle claim look identical, and one of them is a fault.
  assert.ok(CLAIM_WAIT_MS < CLAIM_TIMEOUT_MS,
    `waiting ${CLAIM_WAIT_MS}ms under a ${CLAIM_TIMEOUT_MS}ms budget makes every idle claim a timeout`);
  assert.ok(REQUEST_TIMEOUT_MS < CLAIM_TIMEOUT_MS, "an ordinary call must not wait as long as a claim");
});

test("a report names the request and the claimer that is reporting", async () => {
  const f = fakeFetch({ status: 204 });
  await api(f).report("req 1/needs encoding", { status: "running" });
  assert.match(f.calls[0].url, /\/spawn-requests\/req%201%2Fneeds%20encoding$/,
    "an unencoded id would address a different resource, or none");
  const body = JSON.parse(f.calls[0].options.body);
  assert.equal(body.status, "running");
  assert.equal(body.bridgeId, IDENTITY.bridgeId,
    "the service must be able to tell whether the claimer reporting still owns the work");
});

test("UNREACHABLE and REFUSED are distinguishable", async () => {
  // One means retry, the other means a person has to change something. Collapsing them is how "the
  // service did not answer" gets reported about a service that is up and rejecting every request.
  const down = api(fakeFetch({ throws: "connect ECONNREFUSED" }));
  const refused = api(fakeFetch({ status: 401, text: "Unauthorized" }));

  const downError = await down.heartbeat({}).catch((e) => e);
  assert.ok(downError instanceof CommsApiError);
  assert.equal(downError.status, 0, "unreachable carries no HTTP status");

  const refusedError = await refused.heartbeat({}).catch((e) => e);
  assert.equal(refusedError.status, 401);
  assert.match(refusedError.message, /401/);
});

test("a 204 is a success with no body, not a parse failure", async () => {
  const result = await api(fakeFetch({ status: 204 })).report("r", { status: "starting" });
  assert.deepEqual(result, {});
});

test("the endpoint is refused when missing, rather than building a relative URL", () => {
  const good = { credential: async () => "", identity: IDENTITY, fetchImpl: fakeFetch() };
  assert.throws(() => new CommsApi({ ...good, endpoint: "" }), TypeError);
  assert.throws(() => new CommsApi({ ...good, endpoint: "http://x", credential: null }), TypeError);
  assert.throws(() => new CommsApi({ ...good, endpoint: "http://x", identity: null }), TypeError);
});

test("a trailing slash on the endpoint does not produce a double slash", () => {
  const client = new CommsApi({
    endpoint: "http://127.0.0.1:8800/",
    credential: async () => "",
    identity: IDENTITY,
    fetchImpl: fakeFetch(),
  });
  assert.ok(client.identity.bridgeId, "identity survives normalisation");
});

test("an advertisement's own metadata survives the bridge fields", () => {
  // The plugin merges its identity INTO whatever metadata the host advertised. Overwriting the
  // caller's metadata wholesale would erase host facts the service preserves on its behalf.
  const f = fakeFetch();
  return api(f).heartbeat({ hostname: "h", kind: "windows", metadata: { advertiser: "aify-env" } })
    .then(() => {
      const body = JSON.parse(f.calls[0].options.body);
      assert.equal(body.metadata.advertiser, "aify-env", "the caller's metadata was discarded");
      assert.ok(body.metadata.bridgeStartedAt, "and the bridge fields must still be there");
    });
});

// ── the three READ/CONTROL calls behind "start an available agent" ────────────────────────────────

test("the roster and the session listing are plain reads, with no body", async () => {
  const fetchImpl = fakeFetch({ json: { agents: {} } });
  await api(fetchImpl).agents();
  await api(fetchImpl).sessionsFor("ef tester/1");
  assert.deepEqual(fetchImpl.calls.map((c) => [c.options.method, c.url]), [
    ["GET", "http://127.0.0.1:8800/api/v1/agents"],
    // ENCODED, so an id carrying a space or a slash cannot address another route or split the query.
    ["GET", "http://127.0.0.1:8800/api/v1/sessions?agentId=ef%20tester%2F1"],
  ]);
  for (const call of fetchImpl.calls) assert.equal(call.options.body, undefined);
});

test("A SESSION CONTROL CARRIES NO BRIEF, AND THAT IS THE MOST EXPENSIVE LINE IN THIS FILE", async () => {
  // `/sessions/:id/control` stores `body` as the spawn request's `initial_message`, and the service
  // turns a non-empty one into a real `type=request` MESSAGE plus a dispatch run addressed to the
  // agent that just came up. A polite receipt therefore reaches a freshly-started agent as an
  // instruction owing a reply, and the obvious reply is to restart itself.
  //
  // MEASURED ON THIS FLEET: all 21 self-issued spawn requests were preceded, 45 to 75 seconds
  // earlier, by exactly one dashboard `Restart <agent>` message of type=request. That is the whole
  // of the operator's "agents exited even though I never stopped them".
  const fetchImpl = fakeFetch({ json: { ok: true } });
  await api(fetchImpl).controlSession("s1/2");
  const [call] = fetchImpl.calls;
  assert.equal(call.options.method, "POST");
  assert.equal(call.url, "http://127.0.0.1:8800/api/v1/sessions/s1%2F2/control");
  const sent = JSON.parse(call.options.body);
  // THE WHOLE FIELD SET, listed rather than spot-checked, because what this test exists to stop
  // is a field ARRIVING -- `body` above all. `only_if_no_live_session` joined it deliberately in
  // v0.6.3: it carries the caller's precondition to the authority so a start cannot become a stop
  // of a worker that appeared in between.
  assert.deepEqual(Object.keys(sent).sort(),
    ["action", "from_agent", "only_if_no_live_session"],
    `the control carried a field beyond the action, the actor and the precondition: ${call.options.body}`);
  assert.equal(sent.only_if_no_live_session, false,
    "an unconditional control must say so explicitly, not by omission");
  assert.equal(sent.action, "restart");
  // THE ACTOR IS THIS TIER, BY NAME. Never a person, and never read from an environment variable:
  // a control attributed to whichever agent happened to be in `AIFY_AGENT_ID` puts somebody else's
  // name on a restart they did not ask for.
  assert.equal(sent.from_agent, "aify-env");
});

test("THE PRECONDITION TRAVELS when the caller states one", async () => {
  // `AgentStarter` picks a session BECAUSE the listing showed no live one, and that reading is a
  // round trip old by the time this request lands. The flag is how the authority gets to
  // re-evaluate the belief against the rows it is about to act on; a client-side re-read only
  // shortens the window. Review traced the race and asked for exactly this shape.
  const fetchImpl = fakeFetch({ json: { ok: true } });
  await api(fetchImpl).controlSession("s1", "restart", { onlyIfNoLiveSession: true });
  assert.equal(JSON.parse(fetchImpl.calls[0].options.body).only_if_no_live_session, true);
});

test("AND ANYTHING BUT A LITERAL TRUE IS UNCONDITIONAL, because a truthy value is not a claim", async () => {
  // A guard that passes on a missing input is decoration, and so is one that fires on a stray
  // string. The route stops a restart; "yes" arriving from a config file must not turn one off.
  const fetchImpl = fakeFetch({ json: { ok: true } });
  await api(fetchImpl).controlSession("s1", "restart", { onlyIfNoLiveSession: "yes" });
  assert.equal(JSON.parse(fetchImpl.calls[0].options.body).only_if_no_live_session, false);
});

test("the control's action travels, so a future verb cannot silently become a restart", async () => {
  const fetchImpl = fakeFetch({ json: { ok: true } });
  await api(fetchImpl).controlSession("s1", "recreate");
  assert.equal(JSON.parse(fetchImpl.calls[0].options.body).action, "recreate");
});

test("a refused control raises a CommsApiError carrying the status, like every other call here", async () => {
  // The caller has to tell "the service said no" from "the service was not there": one means a
  // person must change something, the other means retry.
  const refused = fakeFetch({ status: 409, text: "environment offline" });
  await assert.rejects(() => api(refused).controlSession("s1"), (error) => {
    assert.ok(error instanceof CommsApiError);
    assert.equal(error.status, 409);
    return true;
  });
  const unreachable = fakeFetch({ throws: "ECONNREFUSED" });
  await assert.rejects(() => api(unreachable).controlSession("s1"), (error) => {
    assert.equal(error.status, 0, "an unreachable service was reported with a refusal's status");
    return true;
  });
});
