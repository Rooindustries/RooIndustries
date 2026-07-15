import {
  listCreatorTerms,
  percentToBasisPoints,
  updateCreatorTerms,
  validateCreatorTermsUpdate,
} from "../server/referrals/creatorTerms";

const validInput = {
  creatorId: "10000000-0000-4000-8000-000000000001",
  operationId: "creator-terms-10000000-0000-4000-8000-000000000001",
  expectedVersion: 4,
  totalPercent: "20",
  commissionPercent: "10",
  discountPercent: "10",
  bypassUnlock: true,
  reason: "Approved creator agreement",
};

describe("referral creator terms", () => {
  test.each([
    ["0", 0],
    ["10", 1000],
    ["10.25", 1025],
    ["100.00", 10000],
  ])("converts %s to exact basis points", (value, expected) => {
    expect(percentToBasisPoints(value, "Percentage")).toBe(expected);
  });

  test.each(["-1", "10.001", "100.01", "abc", ""])(
    "rejects invalid percentage %s",
    (value) => {
      expect(() => percentToBasisPoints(value, "Percentage")).toThrow(
        "at most two decimal places"
      );
    }
  );

  test("requires the split to fit inside the total", () => {
    expect(() => validateCreatorTermsUpdate({
      ...validInput,
      totalPercent: "15",
    })).toThrow("cannot exceed the total percentage");
  });

  test("normalizes a validated update for the database RPC", async () => {
    const client = { rpc: jest.fn().mockResolvedValue({ data: { terms_version: 5 }, error: null }) };
    await expect(updateCreatorTerms({
      client,
      input: validInput,
      cutoverGeneration: 1,
    })).resolves.toEqual({ terms_version: 5 });
    expect(client.rpc).toHaveBeenCalledWith("roo_admin_update_creator_terms", {
      p_command_id: validInput.operationId,
      p_creator_id: validInput.creatorId,
      p_expected_version: 4,
      p_total_basis_points: 2000,
      p_commission_basis_points: 1000,
      p_discount_basis_points: 1000,
      p_bypass_referral_requirement: true,
      p_reason: validInput.reason,
      p_cutover_generation: 1,
    });
  });

  test("uses the private creator lookup RPC with a bounded search", async () => {
    const creators = [{ referral_code: "owsupa" }];
    const client = { rpc: jest.fn().mockResolvedValue({ data: creators, error: null }) };
    await expect(listCreatorTerms({ client, search: "owsupa", limit: 500 }))
      .resolves.toEqual(creators);
    expect(client.rpc).toHaveBeenCalledWith("roo_admin_list_creator_terms", {
      p_search: "owsupa",
      p_limit: 200,
      p_offset: 0,
    });
  });

  test("rejects an invalid creator page offset before calling Supabase", async () => {
    const client = { rpc: jest.fn() };
    await expect(listCreatorTerms({ client, offset: -1 }))
      .rejects.toThrow("offset is invalid");
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
