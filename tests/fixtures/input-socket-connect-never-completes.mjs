// Preloaded into `aify-env attach` by the handshake test: every local-socket connect stays pending,
// so the client waits out its whole connect timeout -- the widest the lost-keys window ever was.
//
// WITHOUT THIS THE TEST CANNOT FAIL ON LINUX. A unix-socket connect to a missing path fails at once,
// and the test passed three runs of three against the pre-fix client there. Holding the connect open
// gives the defect its window on every platform; with it, the same client fails three of three.
//
// ONLY A PATH is held: `connectInputSocket` passes the address as a string, while fetch reaches the
// fake daemon through the same `net.connect` with an options object, and must still get through.
import net from "node:net";

const connect = net.connect;
net.connect = (...args) => (typeof args[0] === "string" ? new net.Socket() : connect(...args));
