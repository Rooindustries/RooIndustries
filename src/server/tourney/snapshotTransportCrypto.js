import crypto from "node:crypto";
import { stableSnapshotJson } from "./snapshotContract.js";

const SHA256 = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[0-9a-f]{32}$/;

const transportError = (code) => Object.assign(
  new Error("Tourney snapshot transport data is invalid."),
  { code }
);

const parsePublicKey = (value) => {
  if (typeof value !== "string" || Buffer.byteLength(value) > 4096) {
    throw transportError("TOURNEY_SNAPSHOT_TRANSPORT_KEY_INVALID");
  }
  let key;
  try {
    key = crypto.createPublicKey(value);
  } catch {
    throw transportError("TOURNEY_SNAPSHOT_TRANSPORT_KEY_INVALID");
  }
  const details = key.asymmetricKeyDetails || {};
  if (key.asymmetricKeyType !== "rsa" || Number(details.modulusLength || 0) < 3072) {
    throw transportError("TOURNEY_SNAPSHOT_TRANSPORT_KEY_INVALID");
  }
  return key;
};

const parsePrivateKey = (value) => {
  try {
    const key = crypto.createPrivateKey(value);
    if (key.asymmetricKeyType !== "rsa") throw new Error();
    return key;
  } catch {
    throw transportError("TOURNEY_SNAPSHOT_TRANSPORT_KEY_INVALID");
  }
};

const assertMetadata = (metadata) => {
  if (
    !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
    !REQUEST_ID.test(String(metadata.requestId || "")) ||
    !SHA256.test(String(metadata.payloadSha256 || "")) ||
    !Number.isSafeInteger(metadata.offset) || metadata.offset < 0 ||
    !Number.isSafeInteger(metadata.totalBytes) || metadata.totalBytes < 0 ||
    !Number.isSafeInteger(metadata.chunkBytes) || metadata.chunkBytes < 0 ||
    metadata.offset + metadata.chunkBytes > metadata.totalBytes
  ) {
    throw transportError("TOURNEY_SNAPSHOT_TRANSPORT_METADATA_INVALID");
  }
  return metadata;
};

export const generateSnapshotTransportKeyPair = () => crypto.generateKeyPairSync(
  "rsa",
  {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }
);

export const sealSnapshotTransportPayload = ({ payload, publicKey, metadata }) => {
  const checkedMetadata = assertMetadata(metadata);
  const plaintext = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(stableSnapshotJson(payload));
  if (plaintext.byteLength !== checkedMetadata.chunkBytes) {
    throw transportError("TOURNEY_SNAPSHOT_TRANSPORT_METADATA_INVALID");
  }
  const encryptionKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from(stableSnapshotJson(checkedMetadata));
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wrappedKey = crypto.publicEncrypt({
    key: parsePublicKey(publicKey),
    oaepHash: "sha256",
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
  }, encryptionKey);
  return {
    version: 1,
    algorithm: "rsa-oaep-sha256+aes-256-gcm",
    metadata: checkedMetadata,
    wrappedKey: wrappedKey.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
};

export const openSnapshotTransportPayload = ({ envelope, privateKey }) => {
  if (
    envelope?.version !== 1 ||
    envelope?.algorithm !== "rsa-oaep-sha256+aes-256-gcm"
  ) {
    throw transportError("TOURNEY_SNAPSHOT_TRANSPORT_ENVELOPE_INVALID");
  }
  const metadata = assertMetadata(envelope.metadata);
  try {
    const encryptionKey = crypto.privateDecrypt({
      key: parsePrivateKey(privateKey),
      oaepHash: "sha256",
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    }, Buffer.from(envelope.wrappedKey, "base64"));
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      Buffer.from(envelope.iv, "base64")
    );
    decipher.setAAD(Buffer.from(stableSnapshotJson(metadata)));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    if (plaintext.byteLength !== metadata.chunkBytes) {
      throw new Error();
    }
    return { metadata, plaintext };
  } catch (cause) {
    if (cause?.code?.startsWith?.("TOURNEY_")) throw cause;
    throw transportError("TOURNEY_SNAPSHOT_TRANSPORT_DECRYPT_FAILED");
  }
};
