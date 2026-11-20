// The service may still consume activity frames. Serialize them without owning the screen observation.
export function screenActivitySender({ send, log }) {
  let pending = null, sending = false, closed = false, state = null;
  return {
    note(sighting) {
      if (closed || (sighting?.state ?? null) === state) return;
      state = sighting?.state ?? null;
      pending = sighting;
      if (sending || !pending) return;
      sending = true;
      void (async () => {
        while (!closed && pending) {
          const activity = pending;
          pending = null;
          try { await send(activity); }
          catch (error) { try { log(`screen state ${activity.state} not delivered: ${error?.message || error}`); } catch { /* ignored */ } }
        }
        sending = false;
      })();
    },
    close() { closed = true; pending = null; },
  };
}
