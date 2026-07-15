import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReferralCreatorEditor from "../components/admin/ReferralCreatorEditor";

const creator = (id, code, overrides = {}) => ({
  creator_id: id,
  referral_code: code,
  name: code,
  creator_email: `${code}@example.com`,
  successful_referrals: 0,
  total_basis_points: 1500,
  commission_basis_points: 1000,
  discount_basis_points: 500,
  bypass_referral_requirement: false,
  terms_version: 1,
  ...overrides,
});

const response = (body) => ({
  ok: true,
  json: async () => ({ ok: true, history: [], ...body }),
});

const deferred = () => {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const unlockEditor = async () => {
  render(<ReferralCreatorEditor />);
  fireEvent.change(screen.getByLabelText("Admin key"), {
    target: { value: "admin-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open editor" }));
  await waitFor(() => expect(screen.getByLabelText("Search creators")).toBeVisible());
};

describe("referral creator editor paging", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete global.fetch;
  });

  test("searches the full creator set through the server", async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes("search=outside-first-page")) {
        return response({
          creators: [creator("creator-101", "outside-first-page")],
          hasMore: false,
          nextOffset: 1,
        });
      }
      return response({
        creators: [creator("creator-1", "first-page")],
        hasMore: false,
        nextOffset: 1,
      });
    });

    await unlockEditor();
    fireEvent.change(screen.getByLabelText("Search creators"), {
      target: { value: "outside-first-page" },
    });
    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText("outside-first-page")).toBeVisible());
    expect(global.fetch).toHaveBeenLastCalledWith(
      "/api/admin/referral-creators?search=outside-first-page&offset=0&limit=50",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-admin-key": "admin-secret" }),
      })
    );
  });

  test("loads subsequent creator pages without dropping the first page", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({
        creators: [creator("creator-1", "first-page")],
        hasMore: true,
        nextOffset: 1,
      }))
      .mockResolvedValueOnce(response({
        creators: [creator("creator-2", "second-page")],
        hasMore: false,
        nextOffset: 2,
      }));

    await unlockEditor();
    fireEvent.click(screen.getByRole("button", { name: "Load more creators" }));

    await waitFor(() => expect(screen.getByText("second-page")).toBeVisible());
    expect(screen.getByText("first-page")).toBeVisible();
    expect(global.fetch).toHaveBeenLastCalledWith(
      "/api/admin/referral-creators?search=&offset=1&limit=50",
      expect.any(Object)
    );
  });

  test("preserves an unsaved draft across refreshes", async () => {
    const first = creator("creator-1", "first-page");
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ creators: [first], hasMore: false }))
      .mockResolvedValueOnce(response({ history: [] }))
      .mockResolvedValueOnce(response({
        creators: [creator("creator-1", "first-page", {
          total_basis_points: 2500,
          terms_version: 2,
        })],
        hasMore: false,
      }));

    await unlockEditor();
    fireEvent.click(screen.getByRole("button", { name: /first-page/i }));
    await waitFor(() => expect(screen.getByLabelText("Total percentage allowed")).toHaveValue(15));
    fireEvent.change(screen.getByLabelText("Total percentage allowed"), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByLabelText("Reason for change"), {
      target: { value: "Approved change" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("Total percentage allowed")).toHaveValue(20);
    expect(screen.getByLabelText("Reason for change")).toHaveValue("Approved change");
    expect(screen.getByText(/15% total/)).toBeVisible();
  });

  test("ignores stale history after selecting another creator", async () => {
    const firstHistory = deferred();
    const creators = [
      creator("creator-1", "first-page"),
      creator("creator-2", "second-page"),
    ];
    global.fetch = jest.fn(async (url) => {
      const value = String(url);
      if (value.includes("creatorId=creator-1")) return firstHistory.promise;
      if (value.includes("creatorId=creator-2")) {
        return response({
          history: [{
            id: "history-2",
            reason: "Second creator change",
            created_at: "2026-01-01T00:00:00.000Z",
            new_terms: {},
          }],
        });
      }
      return response({ creators, hasMore: false });
    });

    await unlockEditor();
    fireEvent.click(screen.getByRole("button", { name: /first-page/i }));
    fireEvent.click(screen.getByRole("button", { name: /second-page/i }));
    await waitFor(() => expect(screen.getByText("Second creator change")).toBeVisible());
    await act(async () => {
      firstHistory.resolve(response({
        history: [{
          id: "history-1",
          reason: "Stale first creator change",
          created_at: "2026-01-01T00:00:00.000Z",
          new_terms: {},
        }],
      }));
      await Promise.resolve();
    });

    expect(screen.getByText("Second creator change")).toBeVisible();
    expect(screen.queryByText("Stale first creator change")).not.toBeInTheDocument();
  });

  test("does not apply a completed save to a newly selected creator", async () => {
    const saveResponse = deferred();
    const creators = [
      creator("creator-1", "first-page"),
      creator("creator-2", "second-page", { total_basis_points: 1200 }),
    ];
    jest.spyOn(globalThis, "confirm").mockReturnValue(true);
    global.fetch = jest.fn(async (url, options = {}) => {
      if (options.method === "PATCH") return saveResponse.promise;
      if (String(url).includes("creatorId=")) return response({ history: [] });
      return response({ creators, hasMore: false });
    });

    await unlockEditor();
    fireEvent.click(screen.getByRole("button", { name: /first-page/i }));
    await waitFor(() => expect(screen.getByLabelText("Total percentage allowed")).toHaveValue(15));
    fireEvent.change(screen.getByLabelText("Total percentage allowed"), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByLabelText("Reason for change"), {
      target: { value: "Approved change" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save creator settings" }));
    await waitFor(() => expect(
      global.fetch.mock.calls.some(([, options]) => options?.method === "PATCH")
    ).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /second-page/i }));
    await act(async () => {
      saveResponse.resolve(response({
        creator: {
          total_basis_points: 2000,
          commission_basis_points: 1000,
          discount_basis_points: 500,
          bypass_referral_requirement: false,
          terms_version: 2,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
        syncPending: false,
      }));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByLabelText("Total percentage allowed")).toHaveValue(12));
    const patchCall = global.fetch.mock.calls.find(([, options]) => options?.method === "PATCH");
    expect(JSON.parse(patchCall[1].body)).toMatchObject({
      creatorId: "creator-1",
      totalPercent: "20",
    });
    expect(screen.queryByText(/Saved in Supabase/)).not.toBeInTheDocument();
  });
});
