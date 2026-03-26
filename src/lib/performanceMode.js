import { useSyncExternalStore } from "react";

const subscribeNoop = () => () => {};

export const isLowPerformanceModeEnabled = () => true;

export const subscribePerformanceMode = (_listener) => subscribeNoop();

export const useLowPerformanceMode = () =>
  useSyncExternalStore(subscribeNoop, () => true, () => true);
