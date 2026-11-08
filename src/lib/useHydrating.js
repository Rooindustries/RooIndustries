import { useSyncExternalStore } from "react";

const subscribeNoop = () => () => {};

export const useHydrating = () =>
  useSyncExternalStore(subscribeNoop, () => false, () => true);
