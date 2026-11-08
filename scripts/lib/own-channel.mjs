import nodeProcess from "node:process";

export const endOwnChannel = () => {
  if (nodeProcess.connected) nodeProcess.disconnect();
};
