export const MIRROR_DOMAINS = Object.freeze(["global", "commerce"]);

export const MIRROR_METADATA_KEYS = Object.freeze([
  "_supabaseRevision",
  "_supabaseCanonicalHash",
  "_supabaseMirroredAt",
  "_supabaseSequence",
  "_supabaseSequences",
]);

const mirrorDomainSet = new Set(MIRROR_DOMAINS);

/** @param {unknown} value */
export const normalizeMirrorSequence = (value) => {
  const normalized = String(value ?? "0").trim();
  return /^\d+$/.test(normalized) ? BigInt(normalized) : 0n;
};

/** @param {unknown} domain */
const requireMirrorDomain = (domain) => {
  const normalized = String(domain || "");
  if (!mirrorDomainSet.has(normalized)) {
    throw new Error("Unsupported mirror sequence domain.");
  }
  return normalized;
};

/**
 * @param {Record<string, unknown> | null | undefined} document
 * @param {"global" | "commerce"} domain
 */
export const readMirrorSequence = (document, domain) => {
  const normalizedDomain = requireMirrorDomain(domain);
  return normalizeMirrorSequence(
    document?._supabaseSequences?.[normalizedDomain]
  );
};

/** @param {Record<string, unknown> | null | undefined} document */
export const readLegacyMirrorSequence = (document) =>
  normalizeMirrorSequence(document?._supabaseSequence);

/**
 * @param {Record<string, unknown> | null | undefined} current
 * @param {"global" | "commerce"} domain
 * @param {unknown} sequence
 */
export const mergeMirrorSequences = (current, domain, sequence) => ({
  ...(current?._supabaseSequences &&
  typeof current._supabaseSequences === "object" &&
  !Array.isArray(current._supabaseSequences)
    ? current._supabaseSequences
    : {}),
  [requireMirrorDomain(domain)]: normalizeMirrorSequence(sequence).toString(),
});

/**
 * @param {{
 *   current?: Record<string, unknown> | null,
 *   document?: Record<string, unknown> | null,
 *   domain: "global" | "commerce",
 *   sequence: unknown,
 *   revision?: unknown,
 *   canonicalHash?: unknown,
 *   mirroredAt?: string,
 * }} input
 */
export const buildMirrorMetadata = ({
  current,
  document,
  domain,
  sequence,
  revision,
  canonicalHash,
  mirroredAt = new Date().toISOString(),
}) => {
  const sequences = mergeMirrorSequences(current, domain, sequence);
  const legacySequence = [
    readLegacyMirrorSequence(current),
    normalizeMirrorSequence(sequences.global),
    normalizeMirrorSequence(sequences.commerce),
  ].reduce((highest, value) => (value > highest ? value : highest), 0n);

  return {
    _supabaseRevision: String(
      revision ?? document?._supabaseRevision ?? document?._rev ?? ""
    ),
    _supabaseCanonicalHash: String(
      canonicalHash ?? document?._supabaseCanonicalHash ?? ""
    ),
    _supabaseMirroredAt: mirroredAt,
    _supabaseSequence: legacySequence.toString(),
    _supabaseSequences: sequences,
  };
};

/** @param {Record<string, unknown> | null | undefined} document */
export const hasDurableMirrorMarker = (document) =>
  readLegacyMirrorSequence(document) > 0n ||
  MIRROR_DOMAINS.some((domain) => readMirrorSequence(document, domain) > 0n);
