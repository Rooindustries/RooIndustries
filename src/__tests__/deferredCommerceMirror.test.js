const mockFlushCommerceMirror = jest.fn();
const mockRpc = jest.fn();

jest.mock("../server/data/documentClient", () => ({
  createDocumentWriteClient: () => ({
    flushCommerceMirror: (...args) => mockFlushCommerceMirror(...args),
    shadowClient: { rpc: (...args) => mockRpc(...args) },
  }),
}));

import { flushDeferredCommerceMirror } from "../server/supabase/deferredCommerceMirror";

describe("deferred commerce mirror", () => {
  beforeEach(() => {
    mockFlushCommerceMirror.mockReset();
    mockRpc.mockReset();
  });

  test("retries a leased tail event until the backlog drains", async () => {
    mockFlushCommerceMirror
      .mockResolvedValueOnce({
        supported: true,
        attempted: 0,
        mirrored: 0,
        failed: 0,
      })
      .mockResolvedValueOnce({
        supported: true,
        attempted: 1,
        mirrored: 1,
        failed: 0,
      });
    mockRpc
      .mockResolvedValueOnce({ data: { pending: 1 }, error: null })
      .mockResolvedValueOnce({ data: { pending: 0 }, error: null });

    const result = await flushDeferredCommerceMirror({
      maxAttempts: 2,
      retryDelayMs: 0,
    });

    expect(mockFlushCommerceMirror).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      supported: true,
      attempted: 1,
      mirrored: 1,
      failed: 0,
      pending: 0,
    });
  });

  test("does not retry when the backlog is already empty", async () => {
    mockFlushCommerceMirror.mockResolvedValue({
      supported: true,
      attempted: 1,
      mirrored: 1,
      failed: 0,
    });
    mockRpc.mockResolvedValue({ data: { pending: 0 }, error: null });

    await flushDeferredCommerceMirror({ maxAttempts: 4, retryDelayMs: 0 });

    expect(mockFlushCommerceMirror).toHaveBeenCalledTimes(1);
  });
});
