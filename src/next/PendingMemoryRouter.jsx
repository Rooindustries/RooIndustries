import React, { createContext, useContext, useLayoutEffect, useRef, useState, useTransition } from "react";
import { createPath, Router, UNSAFE_createMemoryHistory, useLocation } from "react-router";

const RouteSwitchContext = createContext(null);
let mountedHistory = null;

export function currentRouteTarget() {
  return mountedHistory ? createPath(mountedHistory.location) : undefined;
}

export function useRouteSwitch() {
  const location = useLocation();
  const routeSwitch = useContext(RouteSwitchContext);
  return routeSwitch || { pending: false, target: location };
}

export default function PendingMemoryRouter({ basename, children, initialEntries, initialIndex, useTransitions }) {
  const historyRef = useRef();
  if (!historyRef.current) {
    historyRef.current = UNSAFE_createMemoryHistory({ initialEntries, initialIndex, v5Compat: true });
  }
  const history = historyRef.current;
  const [state, setState] = useState(() => ({ action: history.action, location: history.location }));
  const [target, setTarget] = useState(history.location);
  const [pending, startTransition] = useTransition();

  useLayoutEffect(() => {
    mountedHistory = history;
    const unlisten = history.listen((update) => {
      setTarget(update.location);
      if (useTransitions === false) setState(update);
      else startTransition(() => setState(update));
    });
    return () => {
      unlisten();
      if (mountedHistory === history) mountedHistory = null;
    };
  }, [history, startTransition, useTransitions]);

  return (
    <RouteSwitchContext.Provider value={{ pending, target }}>
      <Router
        basename={basename}
        location={state.location}
        navigationType={state.action}
        navigator={history}
        useTransitions={useTransitions}
      >
        {children}
      </Router>
    </RouteSwitchContext.Provider>
  );
}
