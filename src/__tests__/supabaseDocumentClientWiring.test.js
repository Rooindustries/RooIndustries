const adminClient = { rpc: jest.fn() };
const supabaseDocumentClient = { backend: "supabase", commerceOnly: true };
const reverseMirroringClient = { backend: "supabase", mirrored: true };
const sanityClient = { transaction: jest.fn() };

const mockCreateSupabaseAdminClient = jest.fn(() => adminClient);
const mockCreateSupabaseDocumentClient = jest.fn(() => supabaseDocumentClient);
const mockCreateReverseMirroringSupabaseClient = jest.fn(
  () => reverseMirroringClient
);

jest.mock("@sanity/client", () => ({
  createClient: jest.fn(() => sanityClient),
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

import { createDataClient } from "../server/data/documentClient";

describe("Supabase document client wiring", () => {
  beforeEach(() => jest.clearAllMocks());

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
});
