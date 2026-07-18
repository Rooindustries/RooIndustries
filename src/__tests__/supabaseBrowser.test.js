import {
  getSupabaseBrowserClient,
  getSupabaseBrowserCookieOptions,
} from "../lib/supabaseBrowser";

const mockClient = { auth: {} };
const mockCreateBrowserClient = jest.fn(() => mockClient);

jest.mock("@supabase/ssr", () => ({
  createBrowserClient: (...args) => mockCreateBrowserClient(...args),
}));

describe("Supabase browser client", () => {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  afterAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = previousKey;
  });

  test("leaves OAuth session exchange and refresh to the server callback", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";

    expect(getSupabaseBrowserClient()).toBe(mockClient);
    expect(mockCreateBrowserClient).toHaveBeenCalledWith(
      "https://project.supabase.co",
      "sb_publishable_test",
      {
        cookieOptions: {
          path: "/",
          sameSite: "lax",
          secure: false,
        },
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: true,
        },
      }
    );
  });

  test("marks browser Auth cookies Secure in production", () => {
    expect(getSupabaseBrowserCookieOptions({ NODE_ENV: "production" })).toEqual({
      path: "/",
      sameSite: "lax",
      secure: true,
    });
  });
});
