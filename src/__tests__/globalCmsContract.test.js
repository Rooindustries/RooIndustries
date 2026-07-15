import {
  GLOBAL_COMMERCE_CONTENT_TYPES,
  GLOBAL_OPERATIONAL_DOCUMENT_TYPES,
  GLOBAL_PUBLIC_CONTENT_TYPES,
  collectGlobalCmsAssetLinks,
  globalCmsAuthorityDomain,
  normalizeGlobalCmsDocument,
} from "../lib/globalCmsContract";

describe("global CMS authority contract", () => {
  test("assigns every Studio-controlled type to one explicit domain", () => {
    expect(globalCmsAuthorityDomain("footer")).toBe("content");
    expect(globalCmsAuthorityDomain("siteSettings")).toBe("content");
    for (const type of GLOBAL_COMMERCE_CONTENT_TYPES) {
      expect(globalCmsAuthorityDomain(type)).toBe("commerce");
    }
    expect(globalCmsAuthorityDomain("referral")).toBe("referral");
    for (const type of GLOBAL_OPERATIONAL_DOCUMENT_TYPES) {
      expect(globalCmsAuthorityDomain(type)).toBe("operational");
    }
    expect(globalCmsAuthorityDomain("unknownDocument")).toBeNull();
    expect(new Set(GLOBAL_PUBLIC_CONTENT_TYPES).size).toBe(
      GLOBAL_PUBLIC_CONTENT_TYPES.length,
    );
  });

  test("normalizes business fields and rejects India or system documents", () => {
    expect(
      normalizeGlobalCmsDocument({
        document: {
          _id: "drafts.package.alpha",
          _type: "package",
          _rev: "source",
          _updatedAt: "ignored",
          title: "Alpha",
        },
      }),
    ).toEqual({ _id: "package.alpha", _type: "package", title: "Alpha" });
    expect(() =>
      normalizeGlobalCmsDocument({
        document: { _id: "india.settings", _type: "indiaSettings" },
      }),
    ).toThrow("not supported");
    expect(() =>
      normalizeGlobalCmsDocument({
        document: { _id: "versions.release.settings", _type: "siteSettings" },
      }),
    ).toThrow("ID is invalid");
    expect(() =>
      normalizeGlobalCmsDocument({
        document: { _id: "coupon.alpha", _type: "coupon" },
        type: "about",
      }),
    ).toThrow("does not match");
    expect(() =>
      normalizeGlobalCmsDocument({
        document: { _id: "about.alpha", _type: "about" },
        id: "about.beta",
      }),
    ).toThrow("does not match");
  });

  test("collects stable, distinct asset links including nested arrays", () => {
    const document = {
      _id: "tool.one",
      _type: "tool",
      downloads: [
        { asset: { _ref: "file-abc-bin" } },
        { image: { _ref: "image-def-100x100-png" } },
      ],
    };
    expect(collectGlobalCmsAssetLinks(document)).toEqual([
      {
        document_legacy_id: "tool.one",
        asset_legacy_id: "file-abc-bin",
        field_path: "$.downloads[0].asset",
      },
      {
        document_legacy_id: "tool.one",
        asset_legacy_id: "image-def-100x100-png",
        field_path: "$.downloads[1].image",
      },
    ]);
  });
});
