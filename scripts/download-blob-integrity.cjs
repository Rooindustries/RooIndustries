const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_MIN_SIZE = 22;
const MAX_ZIP_COMMENT_SIZE = 0xffff;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_MIN_SIZE = 56;

const integrityError = (message, code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const readExactly = async (handle, length, position) => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw integrityError(
      "ZIP archive ended before its directory metadata was complete.",
      "DOWNLOAD_ZIP_TRUNCATED"
    );
  }
  return buffer;
};

const safeNumber = (value, label) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw integrityError(
      `ZIP ${label} exceeds the supported safe integer range.`,
      "DOWNLOAD_ZIP_UNSUPPORTED"
    );
  }
  return Number(value);
};

const findEocdOffset = (tail) => {
  for (let offset = tail.length - EOCD_MIN_SIZE; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + EOCD_MIN_SIZE + commentLength === tail.length) return offset;
  }
  return -1;
};

const readZip64RecordOffset = (locator) => {
  if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) {
    throw integrityError(
      "ZIP64 archive is missing its end-of-directory locator.",
      "DOWNLOAD_ZIP_INVALID"
    );
  }
  if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
    throw integrityError(
      "Multi-disk ZIP archives are not supported for customer downloads.",
      "DOWNLOAD_ZIP_UNSUPPORTED"
    );
  }
  return safeNumber(
    locator.readBigUInt64LE(8),
    "end-of-directory offset"
  );
};

const parseZip64Directory = ({ record, recordOffset, locatorOffset }) => {
  if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
    throw integrityError(
      "ZIP64 end-of-directory record is invalid.",
      "DOWNLOAD_ZIP_INVALID"
    );
  }
  const recordSize = safeNumber(record.readBigUInt64LE(4), "record size");
  const entriesOnDisk = record.readBigUInt64LE(24);
  const totalEntries = record.readBigUInt64LE(32);
  if (
    recordSize < 44 ||
    recordOffset + 12 + recordSize !== locatorOffset ||
    entriesOnDisk !== totalEntries
  ) {
    throw integrityError(
      "ZIP64 end-of-directory record has inconsistent bounds.",
      "DOWNLOAD_ZIP_INVALID"
    );
  }
  if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) {
    throw integrityError(
      "Multi-disk ZIP archives are not supported for customer downloads.",
      "DOWNLOAD_ZIP_UNSUPPORTED"
    );
  }
  return {
    centralDirectoryOffset: safeNumber(
      record.readBigUInt64LE(48),
      "central-directory offset"
    ),
    centralDirectorySize: safeNumber(
      record.readBigUInt64LE(40),
      "central-directory size"
    ),
    entryCount: safeNumber(totalEntries, "entry count"),
    directoryBoundary: recordOffset,
    zip64: true,
  };
};

const readZip64Directory = async ({ handle, eocdAbsoluteOffset }) => {
  const locatorOffset = eocdAbsoluteOffset - ZIP64_LOCATOR_SIZE;
  if (locatorOffset < 0) {
    throw integrityError(
      "ZIP64 archive is missing its end-of-directory locator.",
      "DOWNLOAD_ZIP_TRUNCATED"
    );
  }
  const locator = await readExactly(handle, ZIP64_LOCATOR_SIZE, locatorOffset);
  const recordOffset = readZip64RecordOffset(locator);
  if (recordOffset + ZIP64_EOCD_MIN_SIZE > locatorOffset) {
    throw integrityError(
      "ZIP64 end-of-directory metadata points outside the archive.",
      "DOWNLOAD_ZIP_INVALID"
    );
  }
  const record = await readExactly(handle, ZIP64_EOCD_MIN_SIZE, recordOffset);
  return parseZip64Directory({ record, recordOffset, locatorOffset });
};

const readClassicDirectory = (eocd, eocdAbsoluteOffset) => {
  const diskNumber = eocd.readUInt16LE(4);
  const directoryDisk = eocd.readUInt16LE(6);
  const entriesOnDisk = eocd.readUInt16LE(8);
  const totalEntries = eocd.readUInt16LE(10);
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw integrityError(
      "Multi-disk ZIP archives are not supported for customer downloads.",
      "DOWNLOAD_ZIP_UNSUPPORTED"
    );
  }

  return {
    centralDirectorySize: eocd.readUInt32LE(12),
    centralDirectoryOffset: eocd.readUInt32LE(16),
    entryCount: totalEntries,
    directoryBoundary: eocdAbsoluteOffset,
    zip64: false,
  };
};

const verifyDirectoryBounds = async ({ handle, fileSize, directory }) => {
  const { centralDirectoryOffset, centralDirectorySize, directoryBoundary } =
    directory;
  if (
    centralDirectoryOffset > fileSize ||
    centralDirectorySize > fileSize ||
    centralDirectoryOffset + centralDirectorySize > directoryBoundary
  ) {
    throw integrityError(
      "ZIP central directory points outside the archive.",
      "DOWNLOAD_ZIP_INVALID"
    );
  }

  if (directory.entryCount > 0) {
    const signature = await readExactly(handle, 4, centralDirectoryOffset);
    if (signature.readUInt32LE(0) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw integrityError(
        "ZIP central directory signature is invalid.",
        "DOWNLOAD_ZIP_INVALID"
      );
    }
  } else if (centralDirectorySize !== 0) {
    throw integrityError(
      "Empty ZIP archive has unexpected directory data.",
      "DOWNLOAD_ZIP_INVALID"
    );
  }
};

const inspectZipArchive = async (filePath) => {
  const handle = await fsp.open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size < EOCD_MIN_SIZE) {
      throw integrityError(
        "Download artifact is not a complete ZIP archive.",
        "DOWNLOAD_ZIP_TRUNCATED"
      );
    }

    const tailSize = Math.min(
      stats.size,
      EOCD_MIN_SIZE + MAX_ZIP_COMMENT_SIZE + ZIP64_LOCATOR_SIZE
    );
    const tailStart = stats.size - tailSize;
    const tail = await readExactly(handle, tailSize, tailStart);
    const eocdOffset = findEocdOffset(tail);
    if (eocdOffset < 0) {
      throw integrityError(
        "Download artifact has no complete ZIP end-of-directory record.",
        "DOWNLOAD_ZIP_TRUNCATED"
      );
    }

    const eocdAbsoluteOffset = tailStart + eocdOffset;
    const eocd = tail.subarray(eocdOffset, eocdOffset + EOCD_MIN_SIZE);
    const usesZip64 =
      eocd.readUInt16LE(8) === 0xffff ||
      eocd.readUInt16LE(10) === 0xffff ||
      eocd.readUInt32LE(12) === 0xffffffff ||
      eocd.readUInt32LE(16) === 0xffffffff;
    const directory = usesZip64
      ? await readZip64Directory({ handle, eocdAbsoluteOffset })
      : readClassicDirectory(eocd, eocdAbsoluteOffset);
    await verifyDirectoryBounds({ handle, fileSize: stats.size, directory });

    return {
      sizeBytes: stats.size,
      entryCount: directory.entryCount,
      zip64: directory.zip64,
    };
  } finally {
    await handle.close();
  }
};

const sha256File = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });

const verifyZipEntryCrc = (filePath, { command = "unzip" } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, ["-tqq", filePath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(
        integrityError(
          error?.code === "ENOENT"
            ? "The unzip verifier is required before publishing download artifacts."
            : "The ZIP entry verifier could not start.",
          "DOWNLOAD_ZIP_TEST_UNAVAILABLE"
        )
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }
      const detail = stderr.trim().split("\n").slice(-1)[0] || "CRC test failed";
      reject(
        integrityError(
          `ZIP entry verification failed: ${detail}`,
          "DOWNLOAD_ZIP_CONTENT_INVALID"
        )
      );
    });
  });

const inspectDownloadArtifact = async (filePath) => {
  const zip = await inspectZipArchive(filePath);
  await verifyZipEntryCrc(filePath);
  const sha256 = await sha256File(filePath);
  return { ...zip, sha256 };
};

const assertRemoteBlobMetadata = ({
  pathname,
  uploadResult = {},
  remoteMetadata = {},
  localArtifact = {},
  contentType = "",
}) => {
  if (remoteMetadata.pathname !== pathname || uploadResult.pathname !== pathname) {
    throw integrityError(
      "Uploaded Blob pathname does not match the requested download artifact.",
      "DOWNLOAD_BLOB_PATH_MISMATCH"
    );
  }
  if (remoteMetadata.size !== localArtifact.sizeBytes) {
    throw integrityError(
      "Uploaded Blob size does not match the verified local ZIP.",
      "DOWNLOAD_BLOB_SIZE_MISMATCH"
    );
  }
  if (
    uploadResult.etag &&
    remoteMetadata.etag &&
    uploadResult.etag !== remoteMetadata.etag
  ) {
    throw integrityError(
      "Uploaded Blob ETag changed before verification completed.",
      "DOWNLOAD_BLOB_ETAG_MISMATCH"
    );
  }
  const expectedContentType = String(contentType).trim().toLowerCase();
  const remoteContentType = String(remoteMetadata.contentType || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (expectedContentType && remoteContentType !== expectedContentType) {
    throw integrityError(
      "Uploaded Blob content type does not match the catalog.",
      "DOWNLOAD_BLOB_CONTENT_TYPE_MISMATCH"
    );
  }
  return true;
};

module.exports = {
  assertRemoteBlobMetadata,
  inspectDownloadArtifact,
  inspectZipArchive,
  sha256File,
  verifyZipEntryCrc,
};
