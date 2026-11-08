import policy from "./fixture-tool-policy.cjs";
import { spawnContained as spawn, startChildOnPorts as start } from "./start-on-port.mjs";

export { stopChild } from "./start-on-port.mjs";
export { holdGroupMembers, releaseGroupMembers, signalGroup } from "./process-group.mjs";
export const spawnSync = policy.spawnSync;
export const execFileSync = policy.execFileSync;

export const spawnContained = (command, args, options) => {
  policy.assertFixtureTool(command, args, options);
  for (const daemon of options?.daemons || []) policy.assertFixtureTool(daemon.command, daemon.args);
  return spawn(command, args, options);
};

export const startChildOnPorts = ({ spawnChild, ...options }) => start({
  ...options,
  spawnChild: (ports, launch) => spawnChild(ports, {
    spawn: (command, args, options) => {
      policy.assertFixtureTool(command, args, options);
      for (const daemon of options?.daemons || []) policy.assertFixtureTool(daemon.command, daemon.args);
      return launch.spawn(command, args, options);
    },
  }),
});
