// Exit diagnostics do not carry launcher output or an arbitrary signal string.
export function launcherExitLabel({ code, signal }) {
  if (Number.isSafeInteger(code)) return `code ${code}`;
  return typeof signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(signal) ? `signal ${signal}` : 'status unavailable';
}

/** Only a Runner event for this particular birth, not missing identity or time since launch. */
export function startExitFailure(birth) {
  const exit = birth?.exitFact?.();
  return exit?.stopRequested === false ? `launcher exited during start (${launcherExitLabel(exit)})` : '';
}
