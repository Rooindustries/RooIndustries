import net from "node:net";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { drainMacGroup, linuxSubreaper, macInspector, processTable, recordMacMembers } from "./macos-process.mjs";
import { endOwnChannel } from "./own-channel.mjs";

const { command, args, extra, ipc, ports, directory, scope } = JSON.parse(process.argv[2]);
const state = { leader: processTable().find(({ pid }) => pid === process.pid), members: new Map(),
  ports, directory, scope };
const lifeline = new net.Socket({ fd: 3, readable: true, writable: true });
const lines = createInterface({ input: lifeline });
let child, stopping, observer, watcher, watcherExit, watcherEnding = false, exitCode = 0;
const stop = (grace = 1000) => {
  if (stopping) return stopping;
  stopping = (async () => {
    if (watcher) {
      watcherEnding = true;
      watcher.stdio[3].end();
      if (await watcherExit !== 0) exitCode = 1;
    }
    await drainMacGroup(state, grace);
    clearInterval(observer);
    if (lifeline.destroyed) fs.rmSync(directory, { recursive: true, force: true });
    process.exit(exitCode);
  })();
  return stopping;
};
if (process.platform === "darwin") {
  watcher = spawn(macInspector(), ["--watch", String(process.pid), `${directory}/ancestry.log`], {
    env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "inherit", "pipe"],
  });
  watcherExit = new Promise((resolve) => watcher.once("exit", (code) => {
    resolve(code);
    if (!watcherEnding) { exitCode = 1; void stop(0); }
  }));
  await Promise.race([
    once(watcher.stdout, "data"),
    watcherExit.then(() => { throw new Error("Fixture ancestry watcher exited before starting."); }),
  ]);
}
observer = setInterval(() => recordMacMembers(state), process.platform === "darwin" ? 1000 : 25);
const forward = (target, message, handle) => {
  if (!target.connected) return;
  target.send(message, handle, (error) => {
    handle?.close();
    if (error) { console.error(error); void stop(); }
  });
};
for (const name of ["SIGTERM", "SIGINT"]) process.on(name, () => { void stop(); });
lifeline.on("error", () => { void stop(); });
lines.on("close", () => { void stop(); });
lines.on("line", (line) => {
  if (line) { void stop(JSON.parse(line).grace); return; }
  if (child || stopping) return;
  const stdio = [0, 1, 2, "ignore", ...extra.map((kind, index) => kind === "ipc" ? "ipc" : index + 4)];
  const program = process.platform === "linux" ? linuxSubreaper() : command;
  child = spawn(program, process.platform === "linux" ? [command, ...args] : args, { stdio });
  recordMacMembers(state);
  if (ipc) {
    process.on("message", (message, handle) => forward(child, message, handle));
    child.on("message", (message, handle) => forward(process, message, handle));
    child.on("disconnect", endOwnChannel);
  }
  child.on("error", (error) => { console.error(error); exitCode = 127; void stop(); });
  child.on("exit", (code) => { exitCode = code ?? 1; void stop(); });
});
lifeline.write("x");
