export const endOwnChannel = () => {
  if (process.connected) process.disconnect();
};
