const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const {
  assertRemoteBlobMetadata,
  inspectDownloadArtifact,
  inspectZipArchive,
} = require("../../scripts/download-blob-integrity.cjs");

const execFileAsync = promisify(execFile);

const emptyZip = ({ comment = "" } = {}) => {
  const commentBytes = Buffer.from(comment, "utf8");
  const eocd = Buffer.alloc(22 + commentBytes.length);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(commentBytes.length, 20);
  commentBytes.copy(eocd, 22);
  return eocd;
};

const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const singleFileZip = () => {
  const name = Buffer.from("proof.txt");
  const data = Buffer.from("verified utilities artifact\n");
  const checksum = crc32(data);
  const local = Buffer.alloc(30 + name.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  data.copy(local, 30 + name.length);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
};

const emptyZip64 = () => {
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(0n, 8);
  locator.writeUInt32LE(1, 16);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([record, locator, eocd]);
};

describe("download Blob artifact integrity", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "roo-download-"));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  test("accepts a complete ZIP and returns deterministic size and SHA-256", async () => {
    const bytes = singleFileZip();
    const filePath = path.join(tempDir, "utilities.zip");
    await fsp.writeFile(filePath, bytes);

    await expect(inspectDownloadArtifact(filePath)).resolves.toEqual({
      sizeBytes: bytes.length,
      entryCount: 1,
      zip64: false,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    });
  });

  test("rejects a structurally complete ZIP whose entry CRC is corrupt", async () => {
    const bytes = singleFileZip();
    bytes[42] ^= 0xff;
    const filePath = path.join(tempDir, "bad-crc.zip");
    await fsp.writeFile(filePath, bytes);

    await expect(inspectDownloadArtifact(filePath)).rejects.toMatchObject({
      code: "DOWNLOAD_ZIP_CONTENT_INVALID",
    });
  });

  test("understands ZIP64 directory metadata used by very large archives", async () => {
    const filePath = path.join(tempDir, "large.zip");
    await fsp.writeFile(filePath, emptyZip64());

    await expect(inspectZipArchive(filePath)).resolves.toMatchObject({
      entryCount: 0,
      zip64: true,
    });
  });

  test("upload command can verify a ZIP without contacting Blob", async () => {
    const filePath = path.join(tempDir, "utilities.zip");
    await fsp.writeFile(filePath, singleFileZip());
    const script = path.resolve("scripts/upload-download-blob.mjs");
    const { stdout } = await execFileAsync(
      process.execPath,
      [script, "utilities", filePath, "--verify-only"],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          DOWNLOAD_CATALOG_JSON: "",
          DOWNLOAD_BLOB_ALLOW_OVERWRITE: "",
        },
      }
    );

    expect(stdout).toContain('"verifiedOnly": true');
    expect(stdout).toContain('"sha256"');
  });

  test("rejects a download that ends before the ZIP directory footer", async () => {
    const filePath = path.join(tempDir, "truncated.zip");
    await fsp.writeFile(filePath, emptyZip().subarray(0, 18));

    await expect(inspectZipArchive(filePath)).rejects.toMatchObject({
      code: "DOWNLOAD_ZIP_TRUNCATED",
    });
  });

  test("rejects trailing bytes that indicate an incomplete or joined artifact", async () => {
    const filePath = path.join(tempDir, "joined.zip");
    await fsp.writeFile(filePath, Buffer.concat([emptyZip(), Buffer.from("partial")]));

    await expect(inspectZipArchive(filePath)).rejects.toMatchObject({
      code: "DOWNLOAD_ZIP_TRUNCATED",
    });
  });

  test("rejects central-directory offsets outside the archive", async () => {
    const bytes = emptyZip();
    bytes.writeUInt16LE(1, 8);
    bytes.writeUInt16LE(1, 10);
    bytes.writeUInt32LE(46, 12);
    bytes.writeUInt32LE(4_000_000_000, 16);
    const filePath = path.join(tempDir, "bad-directory.zip");
    await fsp.writeFile(filePath, bytes);

    await expect(inspectZipArchive(filePath)).rejects.toMatchObject({
      code: "DOWNLOAD_ZIP_INVALID",
    });
  });

  test("accepts only remote metadata matching the upload path, size, and ETag", () => {
    expect(() =>
      assertRemoteBlobMetadata({
        pathname: "downloads/utilities.zip",
        uploadResult: {
          pathname: "downloads/utilities.zip",
          etag: "stable-etag",
        },
        remoteMetadata: {
          pathname: "downloads/utilities.zip",
          size: 3_650_722_816,
          etag: "stable-etag",
        },
        localArtifact: { sizeBytes: 3_650_722_816 },
      })
    ).not.toThrow();

    expect(() =>
      assertRemoteBlobMetadata({
        pathname: "downloads/utilities.zip",
        uploadResult: {
          pathname: "downloads/utilities.zip",
          etag: "upload-etag",
        },
        remoteMetadata: {
          pathname: "downloads/utilities.zip",
          size: 3_000_000_000,
          etag: "upload-etag",
        },
        localArtifact: { sizeBytes: 3_650_722_816 },
      })
    ).toThrow(
      expect.objectContaining({ code: "DOWNLOAD_BLOB_SIZE_MISMATCH" })
    );
  });
});
