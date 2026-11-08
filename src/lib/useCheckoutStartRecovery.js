import { useCallback, useEffect, useRef } from "react";

export const useCheckoutStartRecovery = ({ enabled, identity, recover, onSettled, onError }) => {
  const callbacks = useRef(null);
  callbacks.current = { recover, onSettled, onError };
  const refresh = useCallback((force = true) => callbacks.current.recover(force), []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    refresh(false).then(session => {
      if (active) callbacks.current.onSettled(session);
    }, error => {
      if (!active) return;
      callbacks.current.onError(error);
      callbacks.current.onSettled();
    });
    return () => { active = false; };
  }, [enabled, identity, refresh]);
  return refresh;
};
