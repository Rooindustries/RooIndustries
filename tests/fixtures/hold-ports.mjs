import net from "node:net";
import { once } from "node:events";

const ports = process.argv.slice(2).map(Number);
const servers = ports.map(port => net.createServer(socket => socket.destroy()).listen(port, "127.0.0.1"));
await Promise.all(servers.map(server => once(server, "listening")));
console.log(`holding ${ports.join(" ")}`);
