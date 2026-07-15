import {
  assertCmsStudioOrigin,
  authorizeGlobalCmsMutation,
  readSanityBearerToken,
} from "../server/cms/sanityAuthorization";

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("CMS Sanity authorization", () => {
  test("requires an exact Studio origin and bearer token", () => {
    expect(
      assertCmsStudioOrigin({
        origin: "https://rooindustries.sanity.studio",
        env: { NODE_ENV: "production" },
      }),
    ).toBe("https://rooindustries.sanity.studio");
    expect(() =>
      assertCmsStudioOrigin({
        origin: "https://rooindustries.sanity.studio.evil.test",
        env: { NODE_ENV: "production" },
      }),
    ).toThrow("not allowed");
    expect(readSanityBearerToken("Bearer studio-user-token")).toBe(
      "studio-user-token",
    );
    expect(() => readSanityBearerToken("studio-user-token")).toThrow(
      "required",
    );
  });

  test("verifies the user and exact dry-run mutation without changing Sanity", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ sanityUserId: "user-1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          result: [
            {
              _id: "drafts.about.main",
              _type: "about",
              _rev: "revision-1",
              title: "About",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ transactionId: "dry-run" }));
    await expect(
      authorizeGlobalCmsMutation({
        authorization: "Bearer studio-user-token",
        operation: "publish",
        documentId: "about.main",
        document: { _id: "about.main", _type: "about", title: "About" },
        sourceRevision: "revision-1",
        fetchImpl,
      }),
    ).resolves.toEqual({ token: "studio-user-token", actor: "sanity:user-1" });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://9g42k3ur.api.sanity.io/v2021-06-07/users/me",
    );
    const sourceUrl = String(fetchImpl.mock.calls[1][0]);
    expect(sourceUrl).toContain("/data/query/production");
    expect(sourceUrl).toContain("%24ids=");
    const mutationUrl = String(fetchImpl.mock.calls[2][0]);
    expect(mutationUrl).toContain("9g42k3ur.api.sanity.io");
    expect(mutationUrl).toContain("/data/mutate/production");
    expect(mutationUrl).toContain("dryRun=true");
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toEqual({
      mutations: [
        {
          createOrReplace: {
            _id: "about.main",
            _type: "about",
            title: "About",
          },
        },
      ],
    });
  });

  test("fails closed when Sanity denies the exact mutation", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          result: [{ _id: "coupon.one", _type: "coupon", _rev: "revision-1" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({}, 403));
    await expect(
      authorizeGlobalCmsMutation({
        authorization: "Bearer denied",
        operation: "delete",
        documentId: "coupon.one",
        document: null,
        sourceRevision: "revision-1",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 403, code: "CMS_PERMISSION_DENIED" });
  });

  test("preserves Sanity authentication failures for Studio reauthentication", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(jsonResponse({}, 401));
    await expect(
      authorizeGlobalCmsMutation({
        authorization: "Bearer expired",
        operation: "delete",
        documentId: "about.main",
        document: null,
        sourceRevision: "revision-1",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 401, code: "CMS_AUTH_REQUIRED" });
  });

  test("rejects a stale revision or stale content before the dry run", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          result: [
            {
              _id: "drafts.about.main",
              _type: "about",
              _rev: "revision-2",
              title: "Newer",
            },
          ],
        }),
      );
    await expect(
      authorizeGlobalCmsMutation({
        authorization: "Bearer user",
        operation: "publish",
        documentId: "about.main",
        document: { _id: "about.main", _type: "about", title: "Older" },
        sourceRevision: "revision-1",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 409, code: "CMS_SOURCE_STALE" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("does not let a draft revision authorize deleting a newer published document", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          result: [
            {
              _id: "drafts.about.main",
              _type: "about",
              _rev: "draft-revision",
            },
            {
              _id: "about.main",
              _type: "about",
              _rev: "published-newer-revision",
            },
          ],
        }),
      );
    await expect(
      authorizeGlobalCmsMutation({
        authorization: "Bearer user",
        operation: "delete",
        documentId: "about.main",
        document: null,
        sourceRevision: "draft-revision",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 409, code: "CMS_SOURCE_STALE" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("accepts a draft revision for delete only when no published backup exists", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          result: [
            {
              _id: "drafts.about.main",
              _type: "about",
              _rev: "draft-revision",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ transactionId: "dry-run" }));
    await expect(
      authorizeGlobalCmsMutation({
        authorization: "Bearer user",
        operation: "delete",
        documentId: "about.main",
        document: null,
        sourceRevision: "draft-revision",
        fetchImpl,
      }),
    ).resolves.toMatchObject({ actor: "sanity:user-1" });
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toEqual({
      mutations: [{ delete: { id: "about.main" } }],
    });
  });
});
