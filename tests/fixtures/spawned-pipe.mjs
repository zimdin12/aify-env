// A fake piped spawner must publish the same admission event as Node, after listeners can attach.
export function spawnedPipe(child) {
  queueMicrotask(() => child.emit('spawn'));
  return child;
}
