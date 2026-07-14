const adminClient = { rpc: jest.fn() };
const mockSupabaseGetDocument = jest.fn();
const mockSanityGetDocument = jest.fn();
const supabaseDocumentClient = {
  backend: "supabase",
  commerceOnly: true,
  getDocument: (...args) => mockSupabaseGetDocument(...args),
};
const reverseMirroringClient = {
  backend: "supabase",
  mirrored: true,
  getDocument: (...args) => mockSupabaseGetDocument(...args),
};
const sanityClient = {
  getDocument: (...args) => mockSanityGetDocument(...args),
  transaction: jest.fn(),
};

const mockCreateSupabaseAdminClient = jest.fn(() => adminClient);
const mockCreateSupabaseDocumentClient = jest.fn(() => supabaseDocumentClient);
const mockCreateReverseMirroringSupabaseClient = jest.fn(
  () => reverseMirroringClient
);
const mockCreateSanityClient = jest.fn(() => sanityClient);

jest.mock("@sanity/client", () => ({
  createClient: (...args) => mockCreateSanityClient(...args),
}));
jest.mock("../server/supabase/adminClient", () => ({
  createSupabaseAdminClient: (...args) => mockCreateSupabaseAdminClient(...args),
}));
jest.mock("../server/supabase/documentClient", () => ({
  createSupabaseDocumentClient: (...args) =>
    mockCreateSupabaseDocumentClient(...args),
}));
jest.mock("../server/supabase/reverseMirroringClient", () => ({
  createReverseMirroringSupabaseClient: (...args) =>
    mockCreateReverseMirroringSupabaseClient(...args),
}));

import {
  createDataClient,
  createDocumentWriteClient,
} from "../server/data/documentClient";
import { createDownloadDataClient } from "../server/downloads/downloadAccess";

describe("Supabase document client wiring", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSanityGetDocument.mockResolvedValue({ backend: "sanity" });
    mockSupabaseGetDocument.mockResolvedValue({ backend: "supabase" });
  });

  test("injects one real service client into writes and mirror recovery", () => {
    const env = {
      NODE_ENV: "test",
      DATA_PRIMARY_BACKEND: "sanity",
      COMMERCE_PRIMARY_BACKEND: "supabase",
      COMMERCE_CUTOVER_ENABLED: "1",
      SANITY_REVERSE_MIRROR_WRITES: "1",
      COMMERCE_FAILOVER_GENERATION: "3",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SECRET_KEY: "server-secret-placeholder",
    };

    expect(
      createDataClient(
        { projectId: "sanity", dataset: "production", token: "write" },
        { env, domain: "commerce" }
      )
    ).toBe(reverseMirroringClient);
    expect(mockCreateSupabaseAdminClient).toHaveBeenCalledWith({ env });
    expect(mockCreateSupabaseDocumentClient).toHaveBeenCalledWith({
      shadowClient: adminClient,
      commerceOnly: true,
      cutoverGeneration: 3,
    });
    expect(mockCreateReverseMirroringSupabaseClient).toHaveBeenCalledWith({
      supabaseClient: supabaseDocumentClient,
      sanityClient,
      recoveryClient: adminClient,
    });
  });

  test("forces an explicit Sanity write client under full Supabase", () => {
    const env = {
      NODE_ENV: "production",
      DATA_PRIMARY_BACKEND: "supabase",
      COMMERCE_PRIMARY_BACKEND: "supabase",
      SUPABASE_CUTOVER_ENABLED: "1",
      COMMERCE_CUTOVER_ENABLED: "1",
      SANITY_REVERSE_MIRROR_WRITES: "1",
      SANITY_PRIVATE_PROJECT_ID: "private-project",
      SANITY_PRIVATE_DATASET: "private-dataset",
      SANITY_PRIVATE_WRITE_TOKEN: "private-write-token",
    };

    expect(
      createDocumentWriteClient({ env, backendOverride: "sanity" })
    ).toBe(sanityClient);
    expect(mockCreateSanityClient).toHaveBeenCalledWith({
      projectId: "private-project",
      dataset: "private-dataset",
      apiVersion: "2023-10-01",
      token: "private-write-token",
      useCdn: false,
      perspective: "published",
    });
    expect(mockCreateSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mockCreateSupabaseDocumentClient).not.toHaveBeenCalled();
    expect(mockCreateReverseMirroringSupabaseClient).not.toHaveBeenCalled();
  });

  test.each([
    ["sanity", "sanity", "sanity"],
    ["supabase", "sanity", "sanity"],
    ["sanity", "supabase", "supabase"],
    ["supabase", "supabase", "supabase"],
  ])(
    "downloads use %s global with %s commerce through the %s backend",
    async (globalBackend, commerceBackend, expectedBackend) => {
      const env = {
        NODE_ENV: "test",
        DATA_PRIMARY_BACKEND: globalBackend,
        COMMERCE_PRIMARY_BACKEND: commerceBackend,
        SUPABASE_CUTOVER_ENABLED: "1",
        COMMERCE_CUTOVER_ENABLED: "1",
        SANITY_REVERSE_MIRROR_WRITES: "1",
        SANITY_PROJECT_ID: "sanity-project",
        SANITY_DATASET: "production",
        SANITY_WRITE_TOKEN: "sanity-write-token",
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_SECRET_KEY: "server-secret-placeholder",
      };

      const result = await createDownloadDataClient(env).getDocument("booking-1");

      expect(result).toEqual({ backend: expectedBackend });
      if (expectedBackend === "sanity") {
        expect(mockSanityGetDocument).toHaveBeenCalledWith("booking-1");
        expect(mockSupabaseGetDocument).not.toHaveBeenCalled();
      } else {
        expect(mockSupabaseGetDocument).toHaveBeenCalledWith("booking-1");
        expect(mockSanityGetDocument).not.toHaveBeenCalled();
      }
    }
  );

  test("does not touch an unavailable global Supabase backend when commerce is Sanity", async () => {
    mockSupabaseGetDocument.mockRejectedValue(new Error("Supabase unavailable"));
    const env = {
      NODE_ENV: "test",
      DATA_PRIMARY_BACKEND: "supabase",
      COMMERCE_PRIMARY_BACKEND: "sanity",
      SUPABASE_CUTOVER_ENABLED: "1",
      SANITY_PROJECT_ID: "sanity-project",
      SANITY_DATASET: "production",
      SANITY_WRITE_TOKEN: "sanity-write-token",
    };

    await expect(
      createDownloadDataClient(env).getDocument("booking-1")
    ).resolves.toEqual({ backend: "sanity" });
    expect(mockSupabaseGetDocument).not.toHaveBeenCalled();
  });

  test("does not touch an unavailable global Sanity backend when commerce is Supabase", async () => {
    mockSanityGetDocument.mockRejectedValue(new Error("Sanity unavailable"));
    const env = {
      NODE_ENV: "test",
      DATA_PRIMARY_BACKEND: "sanity",
      COMMERCE_PRIMARY_BACKEND: "supabase",
      COMMERCE_CUTOVER_ENABLED: "1",
      SANITY_REVERSE_MIRROR_WRITES: "1",
      SANITY_PROJECT_ID: "sanity-project",
      SANITY_DATASET: "production",
      SANITY_WRITE_TOKEN: "sanity-write-token",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SECRET_KEY: "server-secret-placeholder",
    };

    await expect(
      createDownloadDataClient(env).getDocument("booking-1")
    ).resolves.toEqual({ backend: "supabase" });
    expect(mockSanityGetDocument).not.toHaveBeenCalled();
  });
});
