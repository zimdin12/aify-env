// One bounded TERM/KILL schedule. Callers own acquisition/identity; this schedule creates no kill authority.
import { STOP_EXIT_WAIT_MS } from './kill-tree.mjs';

export async function endObservedProcessGroup({ observe, send, canBegin, failure, now, wait,
  timeoutMs = STOP_EXIT_WAIT_MS, phase = () => {}, force = false }) {
  const initial = observe();
  if (initial === 'gone') return;
  if (initial !== 'present' || !canBegin()) throw failure('unknown');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw failure('unknown');
  const started = now();
  if (!Number.isFinite(started)) throw failure('unknown');
  const graceEnds = started + timeoutMs / 2, deadline = started + timeoutMs;
  const until = async end => {
    for (;;) {
      const state = observe();
      if (state !== 'present') return state;
      const clock = now();
      if (!Number.isFinite(clock)) return 'unknown';
      const remaining = end - clock;
      if (!(remaining > 0)) return 'present';
      await wait(Math.min(10, remaining));
    }
  };
  let state;
  if (force !== true) {
    phase('group-term');
    send('SIGTERM');
    state = await until(graceEnds);
    if (state === 'gone') return;
    if (state !== 'present') throw failure('unknown');
  }
  phase('group-kill');
  send('SIGKILL');
  state = await until(deadline);
  if (state !== 'gone') throw failure(state);
}
