import fs from "node:fs";
import path from "node:path";
import {
  GLOBAL_OPERATIONAL_DOCUMENT_TYPES,
  GLOBAL_PUBLIC_CONTENT_TYPES,
  resolveCmsWritePauseFlag,
} from "../lib/globalCmsContract";
import {
  cmsPublishValidationState,
  cmsSourceRevision,
  cmsValidationDocumentId,
  filterGlobalNewDocumentOptions,
  globalStructureTypes,
  makeGlobalSchemas,
  resolveGlobalDocumentActions,
  shouldCleanCmsDraft,
} from "../../rooindustries/actions/authorityResolver";

const native = [
  { action: "publish" },
  { action: "unpublish" },
  { action: "delete" },
  { action: "discardChanges" },
  { action: "duplicate" },
  { action: "restore" },
  { action: "inspect" },
];
const replacements = {
  publish: { action: "supabasePublish" },
  unpublish: { action: "supabaseUnpublish" },
  delete: { action: "supabaseDelete" },
  referral: { action: "referralAdmin" },
};

describe("Sanity Studio authority resolver", () => {
  test("fails closed when the Studio pause control is missing or invalid", () => {
    expect(resolveCmsWritePauseFlag(undefined)).toEqual({
      configured: false,
      paused: true,
    });
    expect(resolveCmsWritePauseFlag("invalid")).toEqual({
      configured: false,
      paused: true,
    });
    expect(resolveCmsWritePauseFlag("0")).toEqual({
      configured: true,
      paused: false,
    });
    expect(resolveCmsWritePauseFlag("1")).toEqual({
      configured: true,
      paused: true,
    });

    const actionSource = fs.readFileSync(
      path.resolve(process.cwd(), "rooindustries/actions/supabaseAuthorityActions.jsx"),
      "utf8",
    );
    expect(actionSource).toContain("SANITY_STUDIO_CMS_WRITES_PAUSED");
    expect(actionSource).toContain("writeControlBlocked ||");
    expect(actionSource).toContain(
      "action.writeControlBlocked ? action.execute : () => setConfirming(true)",
    );
  });

  test("retains drafts until the Sanity backup is verified", () => {
    expect(
      shouldCleanCmsDraft({
        operation: "publish",
        hasDraft: true,
        syncPending: true,
      }),
    ).toBe(false);
    expect(
      shouldCleanCmsDraft({
        operation: "publish",
        hasDraft: true,
        syncPending: false,
      }),
    ).toBe(true);
    expect(
      shouldCleanCmsDraft({
        operation: "unpublish",
        hasDraft: true,
        syncPending: false,
      }),
    ).toBe(false);
  });

  test("uses a draft revision for draft-only Supabase delete commands", () => {
    expect(
      cmsSourceRevision({
        operation: "delete",
        draft: { _rev: "draft-revision" },
      }),
    ).toBe("draft-revision");
    expect(
      cmsSourceRevision({
        operation: "delete",
        published: { _rev: "published-revision" },
        draft: { _rev: "draft-revision" },
      }),
    ).toBe("published-revision");
  });

  test("validates the draft selected for Supabase publishing", () => {
    expect(
      cmsValidationDocumentId({
        id: "about",
        draft: { _id: "drafts.about" },
        published: { _id: "about" },
      }),
    ).toBe("drafts.about");
    expect(
      cmsValidationDocumentId({
        id: "about",
        published: { _id: "about" },
      }),
    ).toBe("about");
    expect(
      cmsPublishValidationState({
        operation: "publish",
        document: { _rev: "draft-revision" },
        validation: {
          isValidating: false,
          revision: "draft-revision",
          validation: [],
        },
      }),
    ).toEqual({ errors: [], pending: false });

    const actionSource = fs.readFileSync(
      path.resolve(process.cwd(), "rooindustries/actions/supabaseAuthorityActions.jsx"),
      "utf8",
    );
    expect(actionSource).toContain(
      "useValidationStatus(validationDocumentId, props.type, true)",
    );
  });

  test.each([...GLOBAL_PUBLIC_CONTENT_TYPES, "bookingSettings", "coupon"])(
    "removes every native mutation path for %s",
    (schemaType) => {
      const actions = resolveGlobalDocumentActions(
        native,
        { schemaType },
        replacements,
      );
      expect(actions.map((action) => action.action)).toEqual([
        "inspect",
        "supabasePublish",
        "supabaseUnpublish",
        "supabaseDelete",
      ]);
    },
  );

  test("routes referrals to the dedicated admin without mutation actions", () => {
    expect(
      resolveGlobalDocumentActions(
        native,
        { schemaType: "referral" },
        replacements,
      ),
    ).toEqual([{ action: "referralAdmin" }]);
  });

  test.each(GLOBAL_OPERATIONAL_DOCUMENT_TYPES)(
    "exposes no document action for operational type %s",
    (schemaType) => {
      expect(
        resolveGlobalDocumentActions(native, { schemaType }, replacements),
      ).toEqual([]);
    },
  );

  test("leaves unmanaged and India resolver inputs unchanged", () => {
    expect(
      resolveGlobalDocumentActions(
        native,
        { schemaType: "indiaSettings" },
        replacements,
      ),
    ).toBe(native);
    const config = fs.readFileSync(
      path.resolve(process.cwd(), "rooindustries/sanity.config.js"),
      "utf8",
    );
    const indiaConfig = config.slice(config.indexOf("name: 'india'"));
    expect(indiaConfig).toContain("dataset: 'production-in'");
    expect(indiaConfig).toContain("schema: {types: schemaTypes}");
    expect(indiaConfig).not.toContain("document:");
    expect(indiaConfig).not.toContain("newDocumentOptions");
  });

  test("blocks create, hides operations, and makes their fields read-only", () => {
    const options = [
      { templateId: "booking", schemaType: "booking" },
      { templateId: "referral", schemaType: "referral" },
      { templateId: "about", schemaType: "about" },
    ];
    expect(filterGlobalNewDocumentOptions(options)).toEqual([options[2]]);
    const schemas = [
      { name: "booking", fields: [{ name: "status" }] },
      { name: "referral", fields: [{ name: "email" }] },
      { name: "about", fields: [{ name: "title" }] },
    ];
    expect(globalStructureTypes(schemas).map((schema) => schema.name)).toEqual([
      "referral",
      "about",
    ]);
    const protectedSchemas = makeGlobalSchemas(schemas);
    expect(protectedSchemas[0].fields[0].readOnly).toBe(true);
    expect(protectedSchemas[1].fields[0].readOnly).toBe(true);
    expect(protectedSchemas[2]).toBe(schemas[2]);

    expect(
      filterGlobalNewDocumentOptions(options, { writesPaused: true }),
    ).toEqual([]);
    const pausedSchemas = makeGlobalSchemas(schemas, { writesPaused: true });
    expect(pausedSchemas.every((schema) => schema.fields[0].readOnly)).toBe(
      true,
    );
  });

  test("limits hosted files in the global Studio without changing India schemas", () => {
    const schemas = [
      {
        name: "tool",
        fields: [{ name: "downloadFile", type: "file" }],
      },
    ];
    const [globalTool] = makeGlobalSchemas(schemas);
    expect(globalTool.fields[0].options.accept).toContain("application/zip");
    expect(globalTool.fields[0].options.accept).toContain(".exe");
    expect(schemas[0].fields[0].options).toBeUndefined();
  });
});
