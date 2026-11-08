import net from "node:net";
import { drainFixtureScope } from "./fixture-run.mjs";

const scope = JSON.parse(process.argv[2]);
const lifeline = new net.Socket({ fd: Number(process.argv[3] || 3), readable: true, writable: true });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  lifeline.destroy();
  void drainFixtureScope(scope);
};
lifeline.once("error", stop);
lifeline.once("end", stop);
lifeline.resume();
if (process.argv[4] === "ready") lifeline.write("1");
