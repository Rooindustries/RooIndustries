import { requestDeadline } from "../lib/clientRequest";

describe("requestDeadline", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test("uses the native timeout signal when available", () => {
    const timeout = jest.spyOn(AbortSignal, "timeout");
    const signal = requestDeadline(50);

    expect(timeout).toHaveBeenCalledWith(50);
    expect(signal.aborted).toBe(false);
    jest.advanceTimersByTime(49);
    expect(signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
    expect(signal.reason.name).toBe("TimeoutError");
  });

  test("aborts at the deadline when the native timeout is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    try {
      delete AbortSignal.timeout;
      const signal = requestDeadline(50);

      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      jest.advanceTimersByTime(49);
      expect(signal.aborted).toBe(false);
      jest.advanceTimersByTime(1);
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBeInstanceOf(DOMException);
      expect(signal.reason.name).toBe("TimeoutError");
    } finally {
      Object.defineProperty(AbortSignal, "timeout", descriptor);
    }
  });
});
