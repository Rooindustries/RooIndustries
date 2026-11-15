import React, { createContext, useContext, useLayoutEffect, useRef, useState, useTransition } from "react";
import { Router, UNSAFE_createMemoryHistory, useLocation } from "react-router";

const RouteSwitchContext = createContext(null);
export function useRouteSwitch() {
  const location = useLocation();
  const routeSwitch = useContext(RouteSwitchContext);
  return routeSwitch || { pending: false, target: location };
}

export default function PendingMemoryRouter({ children, initialEntries }) {
  const historyRef = useRef();
  if (!historyRef.current) {
    historyRef.current = UNSAFE_createMemoryHistory({ initialEntries, v5Compat: true });
  }
  const history = historyRef.current;
  const [state, setState] = useState(() => ({ action: history.action, location: history.location }));
  const [target, setTarget] = useState(history.location);
  const [pending, startTransition] = useTransition();

  useLayoutEffect(() => {
    const unlisten = history.listen((update) => {
      setTarget(update.location);
      startTransition(() => setState(update));
    });
    return unlisten;
  }, [history, startTransition]);

  return (
    <RouteSwitchContext.Provider value={{ pending, target }}>
      <Router
        location={state.location}
        navigationType={state.action}
        navigator={history}
      >
        {children}
      </Router>
    </RouteSwitchContext.Provider>
  );
}
