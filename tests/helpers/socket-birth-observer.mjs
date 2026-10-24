// Observation only: stat the actual UNIX socket before listen returns to its caller.
import fs from "node:fs";
import net from "node:net";

process.umask(0o022);
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const result = Reflect.apply(listen, this, args);
  if (typeof args[0] === "string" && args[0].endsWith(".sock")) {
    let observed;
    try {
      const stat = fs.lstatSync(args[0]);
      observed = { address: args[0], socket: stat.isSocket(), mode: stat.mode & 0o777 };
    } catch (error) { observed = { address: args[0], error: error.code }; }
    fs.appendFileSync(process.env.SOCKET_BIRTH_RECORD, JSON.stringify(observed) + "\n");
  }
  return result;
};
