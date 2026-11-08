import net from "node:net";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { drainMacGroup, processTable, recordMacMembers } from "./macos-process.mjs";

const { command, args, extra, ipc, ports, directory, allocations } = JSON.parse(process.argv[2]);
const state = { leader: processTable().find(({ pid }) => pid === process.pid), members: new Map(),
  ports, directory, allocations };
const lifeline = new net.Socket({ fd: 3, readable: true, writable: true });
const lines = createInterface({ input: lifeline });
let child, stopping, exitCode = 0;
const observer = setInterval(() => recordMacMembers(state), 25);
const stop = (grace = 1000) => {
  if (stopping) return stopping;
  stopping = (async () => {
    await drainMacGroup(state, grace);
    clearInterval(observer);
    if (lifeline.destroyed) fs.rmSync(directory, { recursive: true, force: true });
    process.exit(exitCode);
  })();
  return stopping;
};
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
  child = spawn(command, args, { stdio });
  recordMacMembers(state);
  if (ipc) {
    process.on("message", (message, handle) => forward(child, message, handle));
    child.on("message", (message, handle) => forward(process, message, handle));
    child.on("disconnect", () => { if (process.connected) process.disconnect(); });
  }
  child.on("error", (error) => { console.error(error); exitCode = 127; void stop(); });
  child.on("exit", (code) => { exitCode = code ?? 1; void stop(); });
});
lifeline.write("x");
