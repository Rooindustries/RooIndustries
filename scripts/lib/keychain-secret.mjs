import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const runMacosSecurityCommand = (args) => execFileAsync("security", args, {
  maxBuffer: 4096,
});

const readbackSecret = (stdout) => String(stdout || "").replace(/\r?\n$/, "");

const exactSecretMatch = (expected, actual) => {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.byteLength > 0 &&
    expectedBytes.byteLength === actualBytes.byteLength &&
    crypto.timingSafeEqual(expectedBytes, actualBytes);
};

export const deleteGenericPassword = async ({
  service,
  account,
  runCommand = runMacosSecurityCommand,
}) => {
  try {
    await runCommand([
      "delete-generic-password",
      "-a",
      account,
      "-s",
      service,
    ]);
  } catch {}
};

export const storeVerifiedGenericPassword = async ({
  service,
  account,
  secret,
  runCommand = runMacosSecurityCommand,
}) => {
  try {
    await runCommand([
      "add-generic-password",
      "-U",
      "-a",
      account,
      "-s",
      service,
      "-w",
      secret,
    ]);
    const result = await runCommand([
      "find-generic-password",
      "-w",
      "-a",
      account,
      "-s",
      service,
    ]);
    if (!exactSecretMatch(secret, readbackSecret(result?.stdout))) throw new Error();
  } catch {
    await deleteGenericPassword({ service, account, runCommand });
    const error = new Error("The Keychain secret could not be stored and verified.");
    error.code = "KEYCHAIN_SECRET_STORAGE_FAILED";
    throw error;
  }
};
