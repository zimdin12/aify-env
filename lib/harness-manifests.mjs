// Existing manifest files, observed once. A failed read/parse is unknown, never an omitted harness.
import { readFileSync } from 'node:fs';
import { HARNESS_FACTS } from './agent-definition-schema.mjs';

export class HarnessManifests {
  #directory; #facts; #read;
  constructor({ directory, facts = HARNESS_FACTS, readFile = readFileSync }) {
    if (!(directory instanceof URL) || typeof readFile !== 'function') throw new TypeError('manifest loader needs an explicit directory URL and reader');
    this.#directory = directory; this.#facts = facts; this.#read = readFile;
  }
  load() {
    return new Map(Object.entries(this.#facts).map(([name, facts]) => [name, this.#one(name, facts)]));
  }
  #one(name, facts) {
    let bytes;
    try { bytes = this.#read(new URL(`${name}.json`, this.#directory)); }
    catch (error) {
      return { state: 'unknown', reason: error?.code === 'ENOENT' ? 'screen manifest missing' : 'screen manifest unreadable', manifest: null };
    }
    try {
      const text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const manifest = JSON.parse(text);
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || typeof manifest.id !== 'string'
        || !Array.isArray(manifest.rules) || (manifest.aliases !== undefined && !Array.isArray(manifest.aliases))
        || ![name, facts.runtime].some(id => manifest.id === id || manifest.aliases?.includes(id))) throw Error('manifest shape');
      return { state: 'loaded', reason: '', manifest };
    } catch {
      return { state: 'unknown', reason: 'screen manifest invalid', manifest: null };
    }
  }
}
