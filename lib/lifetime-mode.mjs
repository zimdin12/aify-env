// Managed registration owns a Runner handle. Resident adoption owns a launcher and a pinned birth.
// Both or neither are ambiguous: never choose an adapter from the next-start definition instead.
export function lifetimeMode(witness) {
  const managed = typeof witness?.handle === 'string' && witness.handle.trim() !== '';
  const resident = typeof witness?.launcher === 'string' && witness.launcher.trim() !== ''
    && Number.isSafeInteger(witness.createdAtUs) && witness.createdAtUs > 0;
  return managed === resident ? null : managed ? 'managed' : 'resident';
}
