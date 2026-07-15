import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import dotenv from "dotenv";
import { stableSnapshotJson } from "../../src/server/tourney/snapshotContract.js";

const exportRoot = path.join(os.homedir(), "Documents", "Roo Industries Migration");
const archiveMagic = Buffer.from("ROOENC2\n");
const archiveHeaderBytes = archiveMagic.byteLength + 32 + 12;
const archiveTrailerBytes = 16 + 32 + 8 + 32;

const exportError = (message, code) => Object.assign(new Error(message), { code });
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export const parseExportArguments = (argv = process.argv.slice(2)) => {
  const allowed = new Set(["--env", "--print-target-fingerprint"]);
  const seen = new Set();
  let envPath = "";
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!allowed.has(token) || seen.has(token)) {
      throw exportError("The export command arguments are invalid.", "EXPORT_ARGUMENT_INVALID");
    }
    seen.add(token);
    if (token === "--env") {
      envPath = String(argv[index + 1] || "").trim();
      if (!envPath || envPath.startsWith("--")) {
        throw exportError("A private environment file is required.", "EXPORT_ENV_REQUIRED");
      }
      index += 1;
    }
  }
  if (!envPath || !path.isAbsolute(envPath)) {
    throw exportError("An absolute private environment file is required.", "EXPORT_ENV_REQUIRED");
  }
  return {
    envPath,
    printTargetFingerprint: seen.has("--print-target-fingerprint"),
  };
};

export const loadPrivateExportEnvironment = ({
  envPath,
  prefixes,
  exactKeys = [],
  env = process.env,
} = {}) => {
  let stats;
  try {
    stats = fs.lstatSync(envPath);
  } catch {
    stats = null;
  }
  if (
    !stats?.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid())
  ) {
    throw exportError(
      "The export environment file is missing, unsafe, or not private.",
      "EXPORT_ENV_INVALID"
    );
  }
  for (const key of Object.keys(env)) {
    if (prefixes.some((prefix) => key.startsWith(prefix)) || exactKeys.includes(key)) {
      delete env[key];
    }
  }
  const loaded = dotenv.config({ path: envPath, override: true, quiet: true, processEnv: env });
  if (loaded.error) throw loaded.error;
  return env;
};

const ensureExportRoot = (root) => {
  const resolved = path.resolve(root);
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw exportError("The export output folder is unsafe.", "EXPORT_OUTPUT_INVALID");
  }
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  fs.chmodSync(resolved, 0o700);
  const real = fs.realpathSync(resolved);
  return real;
};

export const reserveExportOutput = ({
  prefix,
  extension,
  root = exportRoot,
  now = new Date(),
} = {}) => {
  const directory = ensureExportRoot(root);
  const stamp = now.toISOString().replace(/[^0-9A-Za-z]/g, "");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nonce = crypto.randomBytes(8).toString("hex");
    const outputPath = path.join(directory, `${prefix} ${stamp}-${nonce}.${extension}`);
    try {
      const descriptor = fs.openSync(outputPath, "wx", 0o600);
      return { descriptor, outputPath };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw exportError("A unique export output could not be reserved.", "EXPORT_OUTPUT_COLLISION");
};

export const uniqueExportOutputPath = ({
  prefix,
  extension,
  root = exportRoot,
  now = new Date(),
} = {}) => {
  const directory = ensureExportRoot(root);
  const stamp = now.toISOString().replace(/[^0-9A-Za-z]/g, "");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nonce = crypto.randomBytes(8).toString("hex");
    const outputPath = path.join(directory, `${prefix} ${stamp}-${nonce}.${extension}`);
    if (!fs.existsSync(outputPath)) return outputPath;
  }
  throw exportError("A unique export output could not be selected.", "EXPORT_OUTPUT_COLLISION");
};

export const encryptJsonExport = ({ payload, passphrase }) => {
  const plaintext = Buffer.from(stableSnapshotJson(payload));
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.from(stableSnapshotJson({
    version: 2,
    algorithm: "aes-256-gcm+scrypt",
    plaintextBytes: plaintext.byteLength,
    plaintextSha256: sha256(plaintext),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }));
};

export const decryptJsonExport = ({ encrypted, passphrase }) => {
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(encrypted).toString("utf8"));
  } catch {
    envelope = null;
  }
  if (
    envelope?.version !== 2 || envelope?.algorithm !== "aes-256-gcm+scrypt" ||
    !/^[0-9a-f]{64}$/.test(String(envelope?.plaintextSha256 || "")) ||
    !Number.isSafeInteger(envelope?.plaintextBytes) || envelope.plaintextBytes < 0
  ) {
    throw exportError("The encrypted export envelope is invalid.", "EXPORT_ENVELOPE_INVALID");
  }
  try {
    const key = crypto.scryptSync(passphrase, Buffer.from(envelope.salt, "base64"), 32);
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    if (
      plaintext.byteLength !== envelope.plaintextBytes ||
      sha256(plaintext) !== envelope.plaintextSha256
    ) {
      throw new Error();
    }
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw exportError("The encrypted export failed verification.", "EXPORT_DECRYPT_FAILED");
  }
};

const childExit = (child, label) => new Promise((resolve, reject) => {
  const stderr = [];
  child.stderr?.on("data", (chunk) => {
    if (Buffer.concat(stderr).byteLength < 4096) stderr.push(chunk);
  });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code === 0) resolve();
    else reject(exportError(`${label} failed.`, "EXPORT_ARCHIVE_PROCESS_FAILED"));
  });
});

const meter = () => {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.byteLength;
      callback(null, chunk);
    },
  });
  return {
    stream,
    result: () => ({ bytes, sha256: hash.digest() }),
  };
};

export const encryptTarDirectory = async ({ directory, outputPath, passphrase }) => {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const keys = crypto.scryptSync(passphrase, salt, 64);
  const encryptionKey = keys.subarray(0, 32);
  const authenticationKey = keys.subarray(32);
  const header = Buffer.concat([archiveMagic, salt, iv]);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(header);
  const archiveMeter = meter();
  const tar = spawn("tar", ["-cf", "-", "-C", directory, "."], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const gzip = spawn("gzip", ["-c"], { stdio: ["pipe", "pipe", "pipe"] });
  const output = fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  output.write(header);
  try {
    await Promise.all([
      pipeline(tar.stdout, gzip.stdin),
      pipeline(gzip.stdout, archiveMeter.stream, cipher, output),
      childExit(tar, "Archive creation"),
      childExit(gzip, "Archive compression"),
    ]);
    const measured = archiveMeter.result();
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(measured.bytes));
    const tag = cipher.getAuthTag();
    const authenticated = Buffer.concat([header, tag, measured.sha256, size]);
    const hmac = crypto.createHmac("sha256", authenticationKey)
      .update(authenticated)
      .digest();
    await fsPromises.appendFile(outputPath, Buffer.concat([
      tag,
      measured.sha256,
      size,
      hmac,
    ]));
    const handle = await fsPromises.open(outputPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return {
      plaintextBytes: measured.bytes,
      plaintextSha256: measured.sha256.toString("hex"),
    };
  } catch (error) {
    await fsPromises.unlink(outputPath).catch(() => {});
    throw error;
  }
};

export const verifyEncryptedTarArchive = async ({
  inputPath,
  passphrase,
  expectedEntries,
} = {}) => {
  const stats = await fsPromises.stat(inputPath);
  if (!stats.isFile() || stats.size <= archiveHeaderBytes + archiveTrailerBytes) {
    throw exportError("The encrypted archive is invalid.", "EXPORT_ARCHIVE_INVALID");
  }
  const handle = await fsPromises.open(inputPath, "r");
  const header = Buffer.alloc(archiveHeaderBytes);
  const trailer = Buffer.alloc(archiveTrailerBytes);
  try {
    await handle.read(header, 0, header.length, 0);
    await handle.read(trailer, 0, trailer.length, stats.size - trailer.length);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, archiveMagic.length).equals(archiveMagic)) {
    throw exportError("The encrypted archive is invalid.", "EXPORT_ARCHIVE_INVALID");
  }
  const salt = header.subarray(archiveMagic.length, archiveMagic.length + 32);
  const iv = header.subarray(archiveMagic.length + 32);
  const tag = trailer.subarray(0, 16);
  const expectedHash = trailer.subarray(16, 48);
  const expectedSize = trailer.subarray(48, 56);
  const expectedHmac = trailer.subarray(56);
  const keys = crypto.scryptSync(passphrase, salt, 64);
  const authenticationKey = keys.subarray(32);
  const actualHmac = crypto.createHmac("sha256", authenticationKey)
    .update(Buffer.concat([header, tag, expectedHash, expectedSize]))
    .digest();
  if (!crypto.timingSafeEqual(expectedHmac, actualHmac)) {
    throw exportError("The encrypted archive authentication failed.", "EXPORT_ARCHIVE_INVALID");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", keys.subarray(0, 32), iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const archiveMeter = meter();
  const gzip = spawn("gzip", ["-dc"], { stdio: ["pipe", "pipe", "pipe"] });
  const tar = spawn("tar", ["-tf", "-"], { stdio: ["pipe", "pipe", "pipe"] });
  const listing = [];
  let listingBytes = 0;
  tar.stdout.on("data", (chunk) => {
    listingBytes += chunk.byteLength;
    if (listingBytes <= 8 * 1024 * 1024) listing.push(chunk);
  });
  const lastCiphertextByte = stats.size - archiveTrailerBytes - 1;
  try {
    await Promise.all([
      pipeline(
        fs.createReadStream(inputPath, {
          start: archiveHeaderBytes,
          end: lastCiphertextByte,
        }),
        decipher,
        archiveMeter.stream,
        gzip.stdin
      ),
      pipeline(gzip.stdout, tar.stdin),
      childExit(gzip, "Archive decompression"),
      childExit(tar, "Archive verification"),
    ]);
  } catch {
    throw exportError("The encrypted archive failed verification.", "EXPORT_ARCHIVE_INVALID");
  }
  if (listingBytes > 8 * 1024 * 1024) {
    throw exportError("The encrypted archive listing is too large.", "EXPORT_ARCHIVE_INVALID");
  }
  const measured = archiveMeter.result();
  if (
    BigInt(measured.bytes) !== expectedSize.readBigUInt64BE() ||
    !crypto.timingSafeEqual(measured.sha256, expectedHash)
  ) {
    throw exportError("The encrypted archive hash is invalid.", "EXPORT_ARCHIVE_INVALID");
  }
  const entries = Buffer.concat(listing).toString("utf8").trim().split("\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""));
  if (expectedEntries) {
    const actual = new Set(entries);
    const expected = new Set(expectedEntries);
    if (
      actual.size !== expected.size ||
      [...expected].some((entry) => !actual.has(entry))
    ) {
      throw exportError("The encrypted archive contents are incomplete.", "EXPORT_ARCHIVE_INVALID");
    }
  }
  return {
    entries,
    plaintextBytes: measured.bytes,
    plaintextSha256: measured.sha256.toString("hex"),
  };
};

export const storeExportPassphrase = ({ service, passphrase, account }) =>
  new Promise((resolve, reject) => {
    const child = spawn("security", [
      "add-generic-password",
      "-U",
      "-a",
      account,
      "-s",
      service,
      "-w",
    ], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(exportError("The export key could not be stored.", "EXPORT_KEYCHAIN_FAILED"));
    });
    child.stdin.end(Buffer.from(`${passphrase}\n`));
  });

export const deleteExportPassphrase = ({ service, account }) =>
  new Promise((resolve) => {
    const child = spawn("security", [
      "delete-generic-password",
      "-a",
      account,
      "-s",
      service,
    ], { stdio: "ignore" });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });

export const defaultExportRoot = exportRoot;
export const stableExportJson = stableSnapshotJson;
