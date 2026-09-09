import { act, renderHook } from "@testing-library/react";
import { useBracketSnapshotPoll } from "../../app/tourney/useBracketSnapshotPoll";
import { useOverlayPoll } from "../../app/tourney/overlay/useOverlayPoll";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const snapshot = (updatedAt) => ({ ok: true, meta: { updatedAt } });
const respond = (data) => ({ ok: true, json: async () => data });
const tick = async (ms = 1000) => act(async () => { jest.advanceTimersByTime(ms); });
let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
  global.fetch = jest.fn();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  global.fetch = originalFetch;
});

test("bracket polling keeps at most one request pending on a slow connection", async () => {
  const pending = deferred();
  global.fetch.mockReturnValue(pending.promise);
  const { result } = renderHook(() => useBracketSnapshotPoll(snapshot("v1"), 1000));
  await tick(5000);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve(respond(snapshot("v2"))); });
  expect(result.current[0].meta.updatedAt).toBe("v2");
  global.fetch.mockResolvedValue(respond(snapshot("v3")));
  await tick();
  expect(result.current[0].meta.updatedAt).toBe("v3");
});

test("a bracket poll cannot replace a command snapshot committed while it was pending", async () => {
  const pending = deferred();
  global.fetch.mockReturnValue(pending.promise);
  const { result } = renderHook(() => useBracketSnapshotPoll(snapshot("v1"), 1000));
  await tick();
  await act(async () => {
    result.current[1](snapshot("command-v3"));
    pending.resolve(respond(snapshot("poll-v2")));
  });
  expect(result.current[0].meta.updatedAt).toBe("command-v3");
});

test("a failed bracket poll keeps the last good snapshot and retries next interval", async () => {
  const initial = snapshot("v1");
  global.fetch.mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(respond(snapshot("v2")));
  const { result } = renderHook(() => useBracketSnapshotPoll(initial, 1000));
  await tick();
  expect(result.current[0]).toBe(initial);
  await tick();
  expect(result.current[0].meta.updatedAt).toBe("v2");
});

test("overlay polling waits for a slow response body before issuing another request", async () => {
  const pendingBody = deferred();
  const onUpdate = jest.fn();
  global.fetch.mockResolvedValue({ ok: true, json: () => pendingBody.promise });
  renderHook(() => useOverlayPoll({ url: "/feed", intervalMs: 1000, version: "v1", onUpdate }));
  await tick();
  await tick(4000);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  await act(async () => { pendingBody.resolve({ ok: true, version: "v2" }); });
  expect(onUpdate).toHaveBeenCalledWith({ ok: true, version: "v2" });
});

test("changing overlay source ignores the old pending source and polls the new source", async () => {
  const pending = deferred();
  const onUpdate = jest.fn();
  global.fetch.mockReturnValueOnce(pending.promise)
    .mockResolvedValue(respond({ ok: true, version: "new-source" }));
  const { rerender } = renderHook(({ url }) => useOverlayPoll({
    url, intervalMs: 1000, version: "v1", onUpdate,
  }), { initialProps: { url: "/feed/old" } });
  await tick();
  rerender({ url: "/feed/new" });
  await act(async () => { pending.resolve(respond({ ok: true, version: "old-source" })); });
  expect(onUpdate).not.toHaveBeenCalled();
  await tick();
  expect(onUpdate).toHaveBeenCalledTimes(1);
  expect(onUpdate).toHaveBeenCalledWith({ ok: true, version: "new-source" });
});

test("disabled overlays never poll and unmounted overlays ignore pending responses", async () => {
  const pending = deferred();
  const onUpdate = jest.fn();
  global.fetch.mockReturnValue(pending.promise);
  const { rerender, unmount } = renderHook(({ enabled }) => useOverlayPoll({
    url: "/feed", intervalMs: 1000, version: "v1", onUpdate, enabled,
  }), { initialProps: { enabled: false } });
  await tick();
  expect(global.fetch).not.toHaveBeenCalled();
  rerender({ enabled: true });
  await tick();
  unmount();
  await act(async () => { pending.resolve(respond({ ok: true, version: "v2" })); });
  expect(onUpdate).not.toHaveBeenCalled();
});

describe.each([
  ["bracket", () => useBracketSnapshotPoll(snapshot("v1"), 1000)],
  ["overlay", () => useOverlayPoll({ url: "/feed", intervalMs: 1000, version: "v1", onUpdate: jest.fn() })],
])("%s polling cancellation", (_name, usePoll) => {
  test.each(["fetch", "body"])("aborts a stalled %s and resumes polling", async (phase) => {
    let requestSignal;
    global.fetch.mockImplementationOnce((_url, { signal }) => {
      requestSignal = signal;
      const stalled = new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("The request was aborted", "AbortError"));
        }, { once: true });
      });
      return phase === "fetch" ? stalled : Promise.resolve({ ok: true, json: () => stalled });
    }).mockResolvedValue(respond({ ...snapshot("v2"), version: "v2" }));
    renderHook(usePoll);
    await tick();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await tick(10000);
    expect(requestSignal.aborted).toBe(true);
    await tick();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test("unmount aborts the pending request and clears scheduled work", async () => {
    global.fetch.mockReturnValue(new Promise(() => {}));
    const { unmount } = renderHook(usePoll);
    await tick();
    const signal = global.fetch.mock.calls[0][1].signal;
    unmount();
    expect(signal.aborted).toBe(true);
    jest.runAllTicks();
    expect(jest.getTimerCount()).toBe(0);
  });
});
