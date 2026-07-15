import {
  assertGlobalCmsWritesAllowed,
  resolveGlobalCmsWriteControl,
} from "../server/cms/writeControl";

const controls = (api, studio) => ({
  CMS_WRITES_PAUSED: api,
  SANITY_STUDIO_CMS_WRITES_PAUSED: studio,
});

describe("global CMS write control", () => {
  test.each([
    ["0", "false"],
    ["false", "off"],
    ["no", "0"],
  ])("allows writes when API=%s and Studio=%s", (api, studio) => {
    const env = controls(api, studio);
    expect(resolveGlobalCmsWriteControl(env)).toEqual({
      writesPaused: false,
      studioWritesPaused: false,
      apiConfigured: true,
      studioConfigured: true,
      matches: true,
      ready: true,
      blockers: [],
    });
    expect(assertGlobalCmsWritesAllowed(env)).toMatchObject({ ready: true });
  });

  test.each(["1", "true", "yes", "on"])(
    "blocks writes when both controls are %s",
    (value) => {
      const env = controls(value, value);
      expect(resolveGlobalCmsWriteControl(env)).toMatchObject({
        writesPaused: true,
        studioWritesPaused: true,
        matches: true,
        ready: false,
        blockers: ["cms_writes_paused"],
      });
      expect(() => assertGlobalCmsWritesAllowed(env)).toThrow(
        expect.objectContaining({ code: "CMS_WRITES_PAUSED", status: 503 }),
      );
    },
  );

  test("blocks mismatched API and Studio controls", () => {
    const env = controls("0", "1");
    expect(resolveGlobalCmsWriteControl(env)).toMatchObject({
      matches: false,
      ready: false,
      blockers: ["cms_write_pause_mismatch"],
    });
    expect(() => assertGlobalCmsWritesAllowed(env)).toThrow(
      expect.objectContaining({
        code: "CMS_WRITE_CONTROL_MISMATCH",
        status: 503,
      }),
    );
  });

  test.each([
    [undefined, "0", "cms_write_pause_api_invalid"],
    ["0", "invalid", "cms_write_pause_studio_invalid"],
  ])("fails closed for incomplete controls", (api, studio, blocker) => {
    const env = controls(api, studio);
    expect(resolveGlobalCmsWriteControl(env)).toMatchObject({
      ready: false,
      blockers: expect.arrayContaining([blocker]),
    });
    expect(() => assertGlobalCmsWritesAllowed(env)).toThrow(
      expect.objectContaining({ code: "CMS_WRITE_CONTROL_INVALID", status: 503 }),
    );
  });
});
