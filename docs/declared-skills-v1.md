# Declared skill trees

An approved, top-level package installed by the current connect can put `"aifySkills": { "directory": "skills" }` in its package.json. The value names a contained, package-relative directory. Its immediate children are skill directories, each with a regular `SKILL.md`. A tree may be empty when the package intends to retire its previously placed skills. There is no new registry field.

The assets phase checks the same-connect path, package revision and approval before accepting this declaration. It reads and copies data; it never imports the package or executes an assets bin for the declared tree. A package must choose its legacy assets bin or the declaration, not both. The existing wrapper artifact format still requires a declared package bin even when no MCP entry references it; skill placement does not execute that bin. The usual package acquisition and connect policy is unchanged.

A service can retain its file-set installer for non-skill assets and offer a separate skill package. The file-set installer still acquires and runs its existing assets step first. A failure stops before skill placement. The chain uses only a skill package accepted by that same connect and never runs an additional package assets bin in this mode. A service that offers both must remove its own copies of the declared skills from its guided assets step before adoption.

Only selected, present runtimes receive a copy. Claude honours `CLAUDE_CONFIG_DIR`. Codex must report that it searches the proposed `CODEX_HOME` skills root. Hermes uses its selected runtime's reported skills directory under `autonomous-ai-agents`, with no links or external-directory changes. An unproved or shadowed target must be resolved before placement.

Every ancestor of a skill destination must be a real directory. If a dotfile manager links `~/.claude` or `~/.codex`, the chain refuses rather than following the link. Put the runtime's configuration in a real directory, or point `CLAUDE_CONFIG_DIR` or `CODEX_HOME` directly at its intended real directory and rerun. Do not remove the managed link just to make the install pass.

`~/.aify/installed-skills.json` records service, skill, harness, approved source artifact/revision/path, destination, and the digest of the tree read back there. The index is separate from the service registry. Updates and removals require the recorded digest to match what is still on disk. Unmanaged or changed skills and linked paths stay in place. Each successful skill placement is recorded before moving on; a failed copy restores its preceding contents when they can be restored without overwriting another writer.

The current slice exercises a toy service. Existing service installers are not replaced, and this contract grants no permission to load a plugin.

## Verify a recorded placement

Call `verifyPlacement({ home, service, skill, harness })` from `aify-env/client/installed-skills`. Pass the absolute host home that owns `.aify`, the registered service name, the declared skill directory name, and the selected client (`claude`, `codex`, or `hermes`). Do not substitute a runtime-specific config home for `home`.

The synchronous result is `{ state, reason }`. `placed` means the recorded tree matches the receipt digest. `changed` means the recorded tree differs or could not safely be read. `absent` means the receipt is missing, invalid or non-unique for this selector, or the recorded destination is missing. The check writes nothing and returns no path or file contents. It verifies the recorded destination, not whether the runtime's current profile discovers the skill.
