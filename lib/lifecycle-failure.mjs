// Only a known definition-lock acquisition failure before every effect boundary may release custody.
// Missing boundary evidence fails closed, as does every other error.
export function lifecycleFailure(error, effectsEntered) {
  return error?.code === 'DEFINITION_LOCK_TIMEOUT' && effectsEntered === false
    ? 'definition-lock-timeout' : null;
}
