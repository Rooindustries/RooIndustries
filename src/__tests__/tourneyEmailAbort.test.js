describe("Tourney Resend cancellation", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetModules();
  });

  test("passes the deadline AbortSignal through Resend to native fetch", async () => {
    let aborted = false;
    global.fetch = jest.fn((_url, options = {}) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("request aborted"), { name: "AbortError" }));
      }, { once: true });
    }));
    const { sendTourneyDiscordInviteEmail } = require("../server/tourney/email.js");
    const controller = new AbortController();
    const idempotencyKey = "command:discord_invite:player_1:v2:recipient:hash";

    const pending = sendTourneyDiscordInviteEmail({
      baseUrl: "https://www.rooindustries.com",
      env: {
        NODE_ENV: "test",
        RESEND_API_KEY: "re_test",
        FROM_EMAIL: "Tourney <tourney@rooindustries.com>",
      },
      idempotencyKey,
      player: {
        id: "player_1",
        displayName: "Player One",
        email: "playerone@example.com",
      },
      signal: controller.signal,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const requestOptions = global.fetch.mock.calls[0][1];
    expect(requestOptions.signal).toBe(controller.signal);
    expect(requestOptions.headers.get("idempotency-key")).toBe(idempotencyKey);

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "tourney_email_send_failed",
    });
    expect(aborted).toBe(true);
  });
});
