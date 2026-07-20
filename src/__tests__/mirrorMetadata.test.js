import {
  buildMirrorMetadata,
  hasDurableMirrorMarker,
  mergeMirrorSequences,
  readMirrorSequence,
} from "../server/supabase/mirrorMetadata";

describe("mirror metadata", () => {
  test("rejects unsupported sequence domains", () => {
    expect(() => readMirrorSequence({}, "legacy")).toThrow(
      "Unsupported mirror sequence domain."
    );
    expect(() => mergeMirrorSequences({}, "other", 1)).toThrow(
      "Unsupported mirror sequence domain."
    );
  });

  test("updates one sequence domain while preserving the other", () => {
    expect(
      mergeMirrorSequences(
        { _supabaseSequences: { global: "11", commerce: "7" } },
        "commerce",
        "8"
      )
    ).toEqual({ global: "11", commerce: "8" });
  });

  test("keeps the legacy marker as the monotonic high-water value", () => {
    expect(
      buildMirrorMetadata({
        current: {
          _supabaseSequence: "19",
          _supabaseSequences: { global: "11", commerce: "13" },
        },
        document: {
          _rev: "source-revision",
          _supabaseCanonicalHash: "a".repeat(64),
        },
        domain: "global",
        sequence: "17",
        mirroredAt: "2026-07-20T00:00:00.000Z",
      })
    ).toEqual({
      _supabaseRevision: "source-revision",
      _supabaseCanonicalHash: "a".repeat(64),
      _supabaseMirroredAt: "2026-07-20T00:00:00.000Z",
      _supabaseSequence: "19",
      _supabaseSequences: { global: "17", commerce: "13" },
    });
  });

  test.each([
    [{ _supabaseSequence: "3" }, true],
    [{ _supabaseSequences: { global: "2" } }, true],
    [{ _supabaseSequences: { commerce: "4" } }, true],
    [{ _supabaseSequence: "0", _supabaseSequences: {} }, false],
    [{}, false],
  ])("detects durable markers on %#", (document, expected) => {
    expect(hasDurableMirrorMarker(document)).toBe(expected);
  });
});
