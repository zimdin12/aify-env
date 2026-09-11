/**
 * POST one advertisement. Injected into `advertiseTo`, which is otherwise pure.
 *
 * The key is an ARGUMENT, resolved by `credentialFor` from the names the registry declares. It sent
 * none at all until 2026-08-30, so turning `API_KEY` on 401'd every advertisement -- and the daemon
 * reported `advertising: true` through all of it while the bridge stood down. `X-API-Key` is the
 * header the service accepts (`service/main.py`); an empty key sends no header rather than an empty
 * one, because a blank credential is a 401 with a more confusing cause.
 */
export async function postAdvertisement(url, body, apiKey = "") {
  const headers = { "content-type": "application/json" };
  // SENT EXACTLY AS RESOLVED. This trimmed, which would put a DIFFERENT key on the wire from the one
  // the store holds -- and the resulting 401 would have no visible cause on either side. The
  // resolver validates the bytes and refuses anything with surrounding whitespace, so by the time a
  // key reaches here there is nothing left to tidy and tidying it can only introduce a mismatch.
  if (String(apiKey || "") !== "") headers["X-API-Key"] = String(apiKey);
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    // The key must never follow a redirect: a 3xx from the endpoint would carry X-API-Key to
    // wherever it pointed. The bridge applies the same policy at every one of its fetch sites.
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
}
