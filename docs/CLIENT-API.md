# Client leaves

These package exports run no I/O on import. They do not start a daemon, load an optional native module, discover a service, or consult a registry. Both ship with ESM declarations. Consumers depend directly on their tested env revision, not on a global install or a transitive dependency.

## Machine identity

`aify-env/client/machine-id` exports `machineIdFor({platform, hostname, env, isWsl})`. The caller supplies WSL evidence; `aify-env/host-wsl` remains the existing procfs probe. The identifier is the lowercased platform tag and host joined by a colon. `AIFY_MACHINE_ID`, `COMPUTERNAME`, `HOSTNAME` and the observed hostname are tried in that order; the selected text is trimmed, and empty text becomes `unknown-host`. A Linux host proved to be WSL gets the `wsl` tag. This says nothing about workspace or install placement.

## Service keys

`aify-env/client/credentials` exports `resolveServiceKey(entry, options)` and `resolveServiceKeySync(entry, options)`. Supply the service registry entry's `endpoint`, optional `credentialRef` and declared `keyEnv` names. Supply the actual request **base** as `options.url`, along with an explicit `mode`, credential environment and home directory. Resolve again for a different destination. Build the request from the very base that was authorized, preserving its path prefix, and do not forward a credential on redirects.

The base check runs before selection and before any credential read. `sameServiceEndpoint` compares absolute HTTP(S) URLs by canonical origin and exact path, ignoring trailing slashes and default port spelling. Userinfo, query and fragment are refused. It does not equate different loopback names; an adapter that rewrites loopback must supply the bases after that rewrite. An address-only override does not authorize a registry key. An explicitly chosen manual URL/key pair can be supplied as an entry bound to that base with no stored reference. A legacy, application-specific failover rule stays outside this API.

Both modes validate the first nonempty own environment value exactly, without trimming or falling through when it is invalid. `explicit-first` can return a valid environment key without a file read after the base check. `reconcile` requires an applicable referenced file to read successfully and refuses different keys. An absent reference is not a read failure. Results identify the state and source; only `ok` carries a key. Do not log the result object.

Both collectors run the same file admission sequence. They check the named file, open it once and verify the opened identity before reading. Refusal of ACL evidence, a changed identity, or unreadable evidence does not grant a key. The POSIX collector uses no-follow where available; the Windows ACL collector observes the named file and rechecks the identity. This is not a promise of atomic Windows name-based ACL inspection against a same-account race. Sync and async differ only in collection; the turn-start hook stays async and its existing deadline stays with the caller.

`credentialRefProblem` and `decodeCredential` are pure helpers for configuration validation and bytes a caller already owns. `readStoredCredentialSync(ref, {home})` performs full custody checks for local configuration. It does not authorize network use. Code that sends a request must bind the destination as above. No shared cache of key bytes is supplied.

## Switching consumers

Before replacing an adapter, prove the private packed install and its supported clean checkout install path, including the compiled dashboard client. No helper may install a dependency from a request or a hook. Loading a leaf without native modules is distinct from npm installing the full package's optional dependencies. Keep the existing cross-repo release parity checks until exact packed consumers have passed the shared contract plus actual outbound checks.
