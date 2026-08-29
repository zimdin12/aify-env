// A page the operator visits must not be able to start a coding agent on their machine.
//
// THE SHAPE, verified against this daemon's own request handling before it was written: the body is
// `JSON.parse`d whatever content type it arrives under, so `fetch("http://127.0.0.1:8802/processes",
// {method:"POST", headers:{"content-type":"text/plain"}, body: "..."})` is a CORS SIMPLE REQUEST --
// no preflight, nothing asked, the process starts. The attacker never reads the response and does not
// need to.
//
// WHAT MAKES THE CHECK SOUND. A page cannot suppress these headers. `Origin` is attached by the
// browser on every cross-origin request with side effects, and `Sec-Fetch-*` is set by the browser
// rather than by script. The only real client of this daemon is Node, which sends none of them --
// measured: `8802` appears in zero dashboard sources, and `EnvClient` is Node.

import assert from "node:assert/strict";
import test from "node:test";

import { browserOriginatedRequest } from "../lib/browser-requests.mjs";

const START = { method: "POST", headers: {} };

// ── the attack ───────────────────────────────────────────────────────────────────────────────

test("a cross-origin POST from a page is refused", () => {
  const verdict = browserOriginatedRequest({
    method: "POST",
    headers: { origin: "https://evil.example", "content-type": "text/plain" },
  });
  assert.equal(verdict.refuse, true);
  assert.match(verdict.reason, /evil\.example/, "the refusal must name what it refused");
});

test("Sec-Fetch-Site alone is enough, with no Origin at all", () => {
  // A same-SITE page -- another port on localhost, say a dev server the operator is running -- sends
  // `sec-fetch-site: same-site` and, for some request kinds, no Origin.
  for (const site of ["cross-site", "same-site"]) {
    const verdict = browserOriginatedRequest({ method: "POST", headers: { "sec-fetch-site": site } });
    assert.equal(verdict.refuse, true, `${site} was allowed to POST`);
  }
});

test("a page cannot dress itself up as a program by lowering its own headers", () => {
  // Header case is not a signal: browsers send lowercase over HTTP/2 and mixed case over HTTP/1.1,
  // and a check that read only one spelling would be bypassed by the other.
  for (const name of ["Origin", "ORIGIN", "origin"]) {
    const verdict = browserOriginatedRequest({ method: "POST", headers: { [name]: "https://evil.example" } });
    assert.equal(verdict.refuse, true, `${name} was not recognised`);
  }
});

test("a state-changing request from ANY page is refused, whatever the site relation says", () => {
  for (const headers of [
    { "sec-fetch-site": "same-origin" },
    { "sec-fetch-site": "none" },
  ]) {
    const verdict = browserOriginatedRequest({ method: "POST", headers });
    assert.equal(verdict.refuse, true, `${JSON.stringify(headers)} was allowed to POST`);
  }
  assert.equal(browserOriginatedRequest({ method: "DELETE", headers: { "sec-fetch-site": "none" } }).refuse,
    true, "a browser navigation must not be able to stop a process");
});

// ── the clients that must keep working ───────────────────────────────────────────────────────

test("the Node client, which sends none of these, is allowed", () => {
  // The control, and the one that matters most: refusing on ABSENCE would refuse every real caller
  // this daemon has, which is a far worse failure than the one being fixed.
  assert.equal(browserOriginatedRequest(START).refuse, false);
  assert.equal(browserOriginatedRequest({ method: "POST", headers: { "content-type": "application/json" } }).refuse,
    false);
  assert.equal(browserOriginatedRequest({ method: "DELETE", headers: { host: "127.0.0.1:8802" } }).refuse, false);
});

test("reading /health in a browser tab still works", () => {
  // A direct navigation is a GET, and an operator opening the endpoint to see if it is up is a thing
  // that should keep working. Only state-changing methods are refused on it.
  assert.equal(browserOriginatedRequest({ method: "GET", headers: { "sec-fetch-site": "none" } }).refuse, false);
  assert.equal(browserOriginatedRequest({ method: "HEAD", headers: { "sec-fetch-site": "none" } }).refuse, false);
});

test("a cross-site GET is still refused, because reading is a leak of its own", () => {
  // The process list names every agent, its pid and its working directory. A page cannot read a
  // no-cors response, but it must not be answered on the chance that a future header lets it.
  assert.equal(browserOriginatedRequest({ method: "GET", headers: { origin: "https://evil.example" } }).refuse,
    true);
});

test("a malformed or missing header block does not throw", () => {
  // This runs on every request. An exception here is a daemon that answers nothing at all.
  for (const headers of [undefined, null, "", 0, [], { origin: undefined }, { origin: 42 }]) {
    assert.doesNotThrow(() => browserOriginatedRequest({ method: "POST", headers }));
  }
  assert.equal(browserOriginatedRequest({ method: "POST", headers: { origin: 42 } }).refuse, false,
    "a non-string header is not an Origin, and must not refuse the caller that sent it");
});

test('the literal "null" origin is refused too', () => {
  // A sandboxed iframe sends `Origin: null`, and so does a `file://` page. An earlier draft exempted
  // it on the grounds that it is not a hostname -- true, and not a reason to answer it. On a browser
  // old enough to send no Sec-Fetch-* headers that exemption was the only thing left in the way.
  for (const method of ["POST", "GET", "DELETE"]) {
    assert.equal(browserOriginatedRequest({ method, headers: { origin: "null" } }).refuse, true,
      `a ${method} from a null-origin page was answered`);
  }
});

test("sec-fetch-mode: cors is NOT a browser signal — Node's own fetch sends it", () => {
  // The false positive this guard shipped with for one test run. Measured against a local server:
  // Node's `fetch` sets `sec-fetch-mode: cors` on every request, so a rule keyed on it refused the
  // bridge's own POSTs with 403. Seven daemon tests going red is the only reason it did not ship.
  assert.equal(
    browserOriginatedRequest({
      method: "POST",
      headers: { "sec-fetch-mode": "cors", "content-type": "application/json", "user-agent": "node" },
    }).refuse,
    false,
    "the only real client of this daemon was refused",
  );
});
