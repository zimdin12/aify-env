// The actual attach/TUI HTTP console consumer, without pretending a pipe is a terminal.
import { OutputFollower } from '../../lib/output-follower.mjs';
const follower = new OutputFollower({ endpoint: process.argv[2], id: 'p', createScreen: async () => null });
await follower.start();
follower.stop();
console.log(JSON.stringify({ status: follower.status, reason: follower.reason }));
if (follower.status !== 'exited') process.exitCode = 1;
