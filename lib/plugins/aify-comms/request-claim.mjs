// Legacy pause for an empty reply without evidence of a hold, or for a failed claim.
export const REQUEST_POLL_MS = 10_000;

export async function claimBatch(request, queue) {
  const answer = await request();
  if (!Array.isArray(answer?.requests)) throw new Error(`invalid ${queue} claim`);
  const requests = answer.requests;
  // Work can arrive on the first attempt, before the server takes the held path.
  return { requests, rearm: requests.length > 0 || answer.held === true };
}
