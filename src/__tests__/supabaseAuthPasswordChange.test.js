import { syncSupabaseTourneyPlayerAccount } from "../server/supabase/accounts.js";

// Supabase Auth accepts `password_hash` when creating a user but silently ignores
// it when updating one: the call returns 200 and the stored credential is left
// alone. Every tourney password reset therefore reported success while sign-in
// kept failing. These tests pin the shape of the admin calls so that cannot
// regress, and assert the submitted password is never persisted anywhere.

const authUserId = "fcb759f9-fcdb-4403-b217-552595c993fd";
const bcryptHash = "$2b$12$l.tnAOrcYqG8QeK9OEJkYe0loikD0aohUP3vkp7PLCdZAWLsxmfjm";

const player = {
  id: "593ffc39-6e63-4fb4-9747-60f1b25e7c32",
  username: "r.e.p.l.e.x.e.d-8fb7579d",
  email: "player@example.com",
  display_name: "Bootchop",
  status: "approved",
  version: "5",
  registration_pool: "main",
  password_hash: bcryptHash,
};

const buildAdminClient = ({ existingUser }) => {
  const calls = { update: [], create: [], rpc: [] };
  return {
    calls,
    auth: {
      admin: {
        getUserById: jest.fn().mockResolvedValue(
          existingUser
            ? { data: { user: existingUser }, error: null }
            : { data: { user: null }, error: { status: 404 } }
        ),
        updateUserById: jest.fn(async (id, attributes) => {
          calls.update.push({ id, attributes });
          return { data: { user: { id } }, error: null };
        }),
        createUser: jest.fn(async (attributes) => {
          calls.create.push(attributes);
          return { data: { user: { id: attributes.id } }, error: null };
        }),
      },
    },
    rpc: jest.fn(async (name, args) => {
      calls.rpc.push({ name, args });
      if (name === "roo_resolve_tourney_account_alias") {
        return { data: existingUser ? { user_id: authUserId } : null, error: null };
      }
      if (name === "roo_account_by_user_id") {
        return {
          data: {
            user_id: authUserId,
            principal_id: authUserId,
            verified_real_email: player.email,
          },
          error: null,
        };
      }
      return { data: {}, error: null };
    }),
  };
};

const existingAuthUser = {
  id: authUserId,
  email: "tourney-player+2fe92cd3d22e56a15ebfc5b0@auth.rooindustries.invalid",
  app_metadata: {
    imported_from: "legacy-tourney-database",
    legacy_player_id: player.id,
    roles: ["tourney_player"],
  },
  user_metadata: {},
};

describe("tourney player Auth password changes", () => {
  test("sends the submitted password and never password_hash on update", async () => {
    const adminClient = buildAdminClient({ existingUser: existingAuthUser });

    await syncSupabaseTourneyPlayerAccount({
      player,
      password: "the-players-new-password",
      passwordHash: bcryptHash,
      authUserId,
      installPassword: true,
      adminClient,
      env: { NODE_ENV: "test" },
    });

    const [{ attributes }] = adminClient.calls.update;
    expect(attributes.password).toBe("the-players-new-password");
    expect(attributes).not.toHaveProperty("password_hash");
  });

  test("refuses to report a change it cannot make stick", async () => {
    const adminClient = buildAdminClient({ existingUser: existingAuthUser });

    // installPassword true with no submitted password is the exact shape that used
    // to write a hash Auth discarded, leaving the old credential in place.
    await expect(
      syncSupabaseTourneyPlayerAccount({
        player,
        password: "",
        passwordHash: bcryptHash,
        authUserId,
        installPassword: true,
        adminClient,
        env: { NODE_ENV: "test" },
      })
    ).rejects.toMatchObject({
      code: "SUPABASE_AUTH_PASSWORD_PLAINTEXT_REQUIRED",
    });

    const [{ attributes }] = adminClient.calls.update;
    expect(attributes).not.toHaveProperty("password");
    expect(attributes).not.toHaveProperty("password_hash");
  });

  test("leaves the credential alone when no password change was requested", async () => {
    const adminClient = buildAdminClient({ existingUser: existingAuthUser });

    await syncSupabaseTourneyPlayerAccount({
      player,
      passwordHash: bcryptHash,
      authUserId,
      installPassword: false,
      adminClient,
      env: { NODE_ENV: "test" },
    });

    const [{ attributes }] = adminClient.calls.update;
    expect(attributes).not.toHaveProperty("password");
    expect(attributes).not.toHaveProperty("password_hash");
    expect(attributes.app_metadata.roles).toContain("tourney_player");
  });

  test("never puts the submitted password into any RPC argument", async () => {
    const adminClient = buildAdminClient({ existingUser: existingAuthUser });
    const secret = "must-not-be-persisted-8813";

    await syncSupabaseTourneyPlayerAccount({
      player,
      password: secret,
      passwordHash: bcryptHash,
      authUserId,
      installPassword: true,
      adminClient,
      env: { NODE_ENV: "test" },
    });

    const serialized = JSON.stringify(adminClient.calls.rpc);
    expect(serialized).not.toContain(secret);
    // The digest is what gets stored, and it must still be a bcrypt digest.
    expect(bcryptHash).toMatch(/^\$2[aby]\$/);
  });
});
