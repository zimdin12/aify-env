// The old short-poll interval is also how we distinguish a fast empty reply from a held claim.
export const REQUEST_POLL_MS = 10_000;

export async function claimBatch(request, queue) {
  const started = performance.now();
  const answer = await request();
  if (!Array.isArray(answer?.requests)) throw new Error(`invalid ${queue} claim`);
  const requests = answer.requests;
  // Work may wake a held claim early. A fast *empty* reply can be an older service ignoring waitMs.
  return { requests, rearm: requests.length > 0 || performance.now() - started >= REQUEST_POLL_MS };
}
