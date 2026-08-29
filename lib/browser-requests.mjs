// Refusing the one caller that can reach a loopback daemon without being on the machine.
//
// THE HOLE. aify-env binds 127.0.0.1, which keeps the network out, and that was taken as the whole
// boundary. It is not: a page the operator merely VISITS runs in a browser that IS on the machine.
// `POST /processes` with `content-type: text/plain` and a JSON body is a CORS "simple request" -- no
// preflight, so nothing asks this server for permission first -- and the body is `JSON.parse`d here
// regardless of the content type it arrived under. The attacker cannot READ the response, and does
// not need to: the process has started.
//
// WHAT AN ATTACKER GETS. `allowlist.mjs` still applies, so only a file carrying the harness contract
// marker will run -- which is to say, exactly the coding agents, with attacker-chosen args and
// working directory. The allowlist bounds the blast radius; it does not close the door.
//
// WHY A HEADER CHECK AND NOT A TOKEN. A token has to be generated, stored, distributed to every
// caller and rotated, and the operator asked for safety that is painless. Browsers ATTACH these
// headers themselves and a page cannot suppress them -- `Origin` is mandatory on any cross-origin
// request with side effects, and `Sec-Fetch-*` is set by the browser, not by the page. Meanwhile the
// only real client is Node, which sends neither. So the check costs nothing to install and nothing to
// keep working. A token remains the answer for a DIFFERENT threat -- another local user account --
// and is a separate decision.
//
// MEASURED before writing this: nothing in the dashboard, and nothing anywhere in aify-comms, calls
// aify-env from a browser. `EnvClient` is Node, and `8802` appears in zero dashboard sources.

/** Header names read here, lowercased once so a caller need not care how its server cased them. */
function headerOf(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const direct = headers[name];
  if (typeof direct === "string") return direct;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return "";
}

/**
 * Is this request one a browser made from a page, rather than one a program made?
 *
 * `SEC-FETCH-MODE` IS NOT A BROWSER SIGNAL, and reading it as one refused the only real client this
 * daemon has. Node's `fetch` sends `sec-fetch-mode: cors` on every request -- measured against a local
 * server, not assumed -- so a rule keyed on it rejected the bridge's own POSTs with 403. Seven
 * daemon tests went red and that is the only reason it did not ship. The signals that DO separate a
 * browser from a program are `Origin` and `Sec-Fetch-Site`: Node sends neither, and a browser cannot
 * omit them on a cross-origin request with side effects.
 *
 * ONLY A POSITIVE IDENTIFICATION REFUSES. Absent headers mean "not a browser" -- every CLI, every
 * Node client, every curl -- and refusing on absence would refuse the only real callers this daemon
 * has. That is not fail-open in the dangerous sense: a browser cannot OMIT these on a cross-origin
 * request with side effects. The browser attaches them, and page script cannot remove them.
 *
 * `Sec-Fetch-Site: none` is a direct navigation -- someone typing the URL or opening a bookmark --
 * which can only be a GET, and reading `/health` in a browser tab is a thing an operator does. It is
 * allowed for safe methods and refused for anything that changes state, because a navigation that
 * POSTs is a form submission from a page, which is the attack in its oldest form.
 *
 * @param {{method?: string, headers?: object}} request
 * @returns {{refuse: boolean, reason: string}}
 */
export function browserOriginatedRequest({ method = "GET", headers = {} } = {}) {
  const safe = ["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase());
  const origin = headerOf(headers, "origin").trim();
  const site = headerOf(headers, "sec-fetch-site").trim().toLowerCase();

  if (origin !== "") {
    // ANY Origin, including the literal "null" a sandboxed iframe and a file:// page send. An earlier
    // draft exempted "null" because it is not a hostname, which is true and is not a reason: those are
    // browser contexts too, and on an old browser that sends no Sec-Fetch-* headers the exemption was
    // the only thing standing between that page and this daemon. There is no legitimate caller that
    // sets Origin -- the only real one is Node's fetch, which does not.
    return { refuse: true, reason: `refusing a request carrying Origin: ${origin}` };
  }
  if (site === "cross-site" || site === "same-site") {
    return { refuse: true, reason: `refusing a browser request from a ${site} page` };
  }
  if (site === "same-origin") {
    // A page loaded from this daemon's own port -- only the SSE console stream, never a POST.
    if (!safe) return { refuse: true, reason: "refusing a state-changing request made from a page" };
  }
  if (site === "none" && !safe) {
    return { refuse: true, reason: "refusing a state-changing request from a browser navigation" };
  }
  return { refuse: false, reason: "" };
}
