// The two ways a definition-store call fails (agent-definitions.mjs), in a module of their own so the store and its
// lock (definition-lock.mjs) both throw them without importing each other.

/** A refusal the caller reports: the store is fine, this request is not. */
export class DefinitionRefused extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "DefinitionRefused";
    Object.assign(this, detail);
  }
}

/** The store cannot work: a held lock, a lost lock, an unreadable ledger, an unresolved conflict. */
export class DefinitionStoreError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "DefinitionStoreError";
    Object.assign(this, detail);
  }
}
