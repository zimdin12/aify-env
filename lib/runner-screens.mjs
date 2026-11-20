import { harnessLauncherInventory } from './harness-launchers.mjs';
import { observeScreen } from './harness-screens/screen-observer.mjs';

function notify(listener, value) {
  try { listener?.(value); } catch { /* A departed reader cannot stop the PTY. */ }
}

/** One observation for each admitted, supported PTY. Subscribers never own or recreate it. */
export class RunnerScreens {
  #byHandle = new Map();
  #changed;
  #timers;

  constructor({ changed = null, timers = {} } = {}) {
    this.#changed = changed;
    this.#timers = timers;
  }

  start({ handle, lifetime, launcher, fileText, read }) {
    if (this.#byHandle.has(handle)) return;
    const facts = harnessLauncherInventory([{ file: launcher, text: fileText }]).known[0];
    if (facts?.capabilities.screen !== true) return;
    const readers = new Set();
    const observer = observeScreen({
      ...this.#timers, runtime: facts.client, read,
      onScreen: screen => { for (const reader of readers) notify(reader.onScreen, screen); },
      onChanged: activity => {
        notify(this.#changed);
        for (const reader of readers) notify(reader.onActivity, activity);
      },
    });
    if (observer) {
      this.#byHandle.set(handle, { lifetime, readers, observer });
      observer.noteOutput('');
    }
  }

  output(handle, chunk) { this.#byHandle.get(handle)?.observer.noteOutput(chunk); }

  end(handle) {
    const closed = this.#byHandle.get(handle);
    if (!closed) return;
    this.#byHandle.delete(handle);
    closed.readers.clear();
    closed.observer.dispose();
    notify(this.#changed);
  }

  current(handle) { return this.#byHandle.get(handle)?.observer.current() ?? null; }

  sightings() {
    return [...this.#byHandle].flatMap(([handle, { lifetime, observer }]) => {
      const activity = observer.current();
      return lifetime && activity ? [{ handle, lifetime, ...activity }] : [];
    });
  }

  watch(handle, reader) {
    const slot = this.#byHandle.get(handle);
    if (!slot) return null;
    slot.readers.add(reader);
    const current = slot.observer.current();
    if (current) notify(reader.onActivity, current);
    // Answer policy must see a fresh viewport, not dialog text replayed from an earlier read.
    slot.observer.noteOutput('');
    return () => slot.readers.delete(reader);
  }
}
