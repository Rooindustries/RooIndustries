import {
  sealTourneyEmailToken,
  unsealTourneyEmailToken,
} from "../server/tourney/emailDispatch.js";

// `tourney.email_dispatches.payload` previously retained a plaintext one-hour reset
// token forever: the success update never touched `payload`, and neither did the
// retry/dead-letter/expired path -- including `expired`, the one case where the code
// had positively established the token was dead. Production held 24 such rows (3
// still live) plus 63 more copies captured into `tourney.mirror_outbox.record_data`
// by the mirror trigger. For a player reset the dispatch row is the ONLY place the
// plaintext exists, because `tourney_player_tokens` stores only its SHA-256.

const env = { TOURNEY_SESSION_SECRET: "test_tourney_session_secret_for_sealing" };

describe("tourney email token sealing", () => {
  test("round-trips a token without storing plaintext", () => {
    const token = "signed-reset-token.abc123";
    const sealed = sealTourneyEmailToken(token, env);

    expect(sealed).not.toContain(token);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed.split(".")).toHaveLength(4);
    expect(unsealTourneyEmailToken(sealed, env)).toBe(token);
  });

  test("produces a different ciphertext each time for the same token", () => {
    const token = "signed-reset-token.abc123";
    // Random IV per seal, so a repeated token is not recognisable by its ciphertext.
    expect(sealTourneyEmailToken(token, env)).not.toBe(
      sealTourneyEmailToken(token, env)
    );
  });

  test("refuses to unseal under a different key", () => {
    const sealed = sealTourneyEmailToken("signed-reset-token", env);
    expect(
      unsealTourneyEmailToken(sealed, {
        TOURNEY_SESSION_SECRET: "a_completely_different_secret_value",
      })
    ).toBe("");
  });

  test("returns empty rather than throwing on tampering", () => {
    const sealed = sealTourneyEmailToken("signed-reset-token", env);
    const parts = sealed.split(".");
    const tampered = [parts[0], parts[1], parts[2], "AAAAAAAAAAAAAAAAAAAAAA"].join(".");
    // A corrupt row must fail as a missing token -- retry then dead-letter -- rather
    // than throwing and stalling every other queued email in the batch.
    expect(unsealTourneyEmailToken(tampered, env)).toBe("");
    expect(unsealTourneyEmailToken("not-sealed-at-all", env)).toBe("");
    expect(unsealTourneyEmailToken("", env)).toBe("");
    expect(unsealTourneyEmailToken("v2.a.b.c", env)).toBe("");
  });

  test("rejects sealing an empty token instead of storing a useless row", () => {
    expect(() => sealTourneyEmailToken("", env)).toThrow(
      "A Tourney email token is required to seal."
    );
  });

  test("fails closed when no sealing secret is configured", () => {
    expect(() => sealTourneyEmailToken("token", {})).toThrow(
      "Tourney email token sealing is not configured."
    );
  });
});

describe("dispatch payload sealing and terminal scrub", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").resolve("src/server/tourney/emailDispatch.js"),
    "utf8"
  );

  test("the enqueue writes the sealed payload, never the raw one", () => {
    expect(source).toContain("const storedPayload = sealDispatchPayload(payload, env);");
    expect(source).toContain("${sql.json(storedPayload)}");
    // The old insert bound the caller's payload object directly.
    expect(source).not.toContain("${sql.json(payload || {})}");
  });

  test("sealing swaps token for sealedToken and keeps a hash for audit", () => {
    expect(source).toContain("const { token: _rawToken, ...rest } = payload;");
    expect(source).toContain("sealedToken: sealTourneyEmailToken(rawToken, env)");
    expect(source).toContain("tokenHash: normalize(payload.tokenHash) || sha256(rawToken)");
  });

  test("a successful send strips the sealed token", () => {
    expect(source).toContain("payload = payload - 'sealedToken'");
  });

  test("expired and dead-letter strip it too, but a retry keeps it", () => {
    expect(source).toContain(
      "when ${resetExpired || terminal} then payload - 'sealedToken'"
    );
    expect(source).toContain("else payload");
  });

  test("an unsealable token fails the dispatch instead of sending a broken link", () => {
    expect(source).toContain("TOURNEY_RESET_TOKEN_UNSEAL_FAILED");
  });
});
