let helpers;

beforeAll(async () => {
  helpers = await import("../../scripts/lib/supabase-shadow-migration.mjs");
});

const bcryptHash = (suffix) =>
  `$2b$12$${String(suffix).padEnd(53, "a").slice(0, 53)}`;

describe("Supabase shadow migration helpers", () => {
  test("creates stable UUID-v4-shaped identifiers from account emails", () => {
    const first = helpers.deterministicAuthUserId("User@Example.com");
    const second = helpers.deterministicAuthUserId(" user@example.com ");

    expect(first).toBe(second);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  test("keeps email-less Tourney and referral passwords separate", () => {
    const accounts = helpers.buildMigrationAccounts([
      {
        _id: "referral.one",
        _rev: "ref-rev",
        _type: "referral",
        creatorEmail: "owner@example.com",
        creatorPassword: bcryptHash("referral"),
        name: "Owner",
        slug: { current: "owner-code" },
      },
      {
        _id: "tourneyAuthStore",
        _rev: "tourney-rev",
        _type: "tourneyAuthStore",
        accountsJson: JSON.stringify([
          {
            username: "owner",
            role: "owner",
            passwordHash: bcryptHash("tourney"),
          },
        ]),
      },
    ]);

    expect(accounts).toHaveLength(2);
    expect(new Set(accounts.map((account) => account.passwordHash)).size).toBe(2);
    expect(
      accounts.find((account) => account.tourneyAccount).primaryEmail
    ).toMatch(/@auth\.rooindustries\.invalid$/);
  });

  test("rejects a true shared-email identity with conflicting hashes", () => {
    expect(() =>
      helpers.buildMigrationAccounts([
        {
          _id: "referral.one",
          _rev: "ref-rev",
          _type: "referral",
          creatorEmail: "shared@example.com",
          creatorPassword: bcryptHash("referral"),
          name: "Shared",
          slug: { current: "shared-code" },
        },
        {
          _id: "tourneyAuthStore",
          _rev: "tourney-rev",
          _type: "tourneyAuthStore",
          accountsJson: JSON.stringify([
            {
              username: "shared",
              email: "shared@example.com",
              role: "caster",
              passwordHash: bcryptHash("tourney"),
            },
          ]),
        },
      ])
    ).toThrow("different passwords");
  });

  test("routes public images and private builds to separate buckets", () => {
    const image = helpers.assetStorageDescriptor({
      _id: "image-abc-100x100-png",
      _type: "sanity.imageAsset",
      assetId: "abc",
      extension: "png",
      mimeType: "image/png",
      size: 10,
      url: "https://cdn.sanity.io/image.png",
    });
    const build = helpers.assetStorageDescriptor({
      _id: "file-def-zip",
      _type: "sanity.fileAsset",
      assetId: "def",
      extension: "zip",
      mimeType: "application/x-zip-compressed",
      size: 20,
      url: "https://cdn.sanity.io/build.zip",
    });

    expect(image.storageBucket).toBe("site-content-public");
    expect(image.storagePath).toBe("images/abc.png");
    expect(build.storageBucket).toBe("optimization-builds-private");
    expect(build.storagePath).toBe("builds/def.zip");
  });

  test("collects nested CMS asset references without duplicates", () => {
    const links = helpers.collectAssetLinks([
      {
        _id: "hero",
        _type: "hero",
        image: { asset: { _ref: "image-abc-100x100-png" } },
        repeated: { _ref: "image-abc-100x100-png" },
      },
      {
        _id: "booking.one",
        _type: "booking",
        image: { asset: { _ref: "image-private" } },
      },
    ]);

    expect(links).toEqual([
      {
        document_legacy_id: "hero",
        asset_legacy_id: "image-abc-100x100-png",
        field_path: "$.image.asset",
      },
      {
        document_legacy_id: "hero",
        asset_legacy_id: "image-abc-100x100-png",
        field_path: "$.repeated",
      },
    ]);
  });

  test("reports missing and mismatched documents", () => {
    const comparison = helpers.compareDocumentManifests(
      [
        { id: "one", type: "hero", hash: "a" },
        { id: "two", type: "review", hash: "b" },
      ],
      [
        { id: "one", type: "hero", hash: "changed" },
        { id: "three", type: "review", hash: "c" },
      ]
    );

    expect(comparison).toEqual({
      ok: false,
      missingTarget: ["two"],
      missingSource: ["three"],
      mismatched: ["one"],
    });
  });

  test("counts legacy Tourney players separately from Sanity identities", () => {
    const accounts = [
      { userId: "creator", tourneyAccount: null },
      { userId: "owner", tourneyAccount: { role: "tourney_owner" } },
    ];

    expect(
      helpers.expectedAccountShadowCounts({
        accounts,
        tourneyPlayerAccounts: 1,
      })
    ).toEqual({
      authUsers: 3,
      profiles: 3,
      tourneyAccounts: 2,
    });
  });
});
