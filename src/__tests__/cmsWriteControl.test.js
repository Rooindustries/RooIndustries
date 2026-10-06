import {
  assertGlobalCmsWritesAllowed,
  resolveGlobalCmsWriteControl,
} from "../server/cms/writeControl";

const controls = (api, studio) => ({
  CMS_WRITES_PAUSED: api,
  SANITY_STUDIO_CMS_WRITES_PAUSED: studio,
});

describe("D6/D5 single native CMS write control", () => {
  test.each([
    ["0", "false"],
    ["false", "off"],
    ["no", "0"],
  ])("allows writes when API=%s and Studio=%s", (api, studio) => {
    const env = controls(api, studio);
    expect(resolveGlobalCmsWriteControl(env)).toEqual({
      writesPaused: false,
      apiConfigured: true,
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
          ready: false,
        blockers: ["cms_writes_paused"],
      });
      expect(() => assertGlobalCmsWritesAllowed(env)).toThrow(
        expect.objectContaining({ code: "CMS_WRITES_PAUSED", status: 423 }),
      );
    },
  );

  test("D5 ignores leftover Studio controls", () => {
    expect(resolveGlobalCmsWriteControl(controls("0", "1"))).toMatchObject({ready:true,blockers:[]});
    expect(assertGlobalCmsWritesAllowed(controls("0","invalid"))).toMatchObject({ready:true});
  });

  test.each([
    [undefined, "0", "cms_write_pause_api_invalid"],
    ["invalid", "0", "cms_write_pause_api_invalid"],
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
