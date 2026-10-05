import { useEffect, useRef } from 'react';

export default function useUpgradeEligibility(input) {
  const current = useRef('');
  const latest = useRef(0);
  const mounted = useRef(true);
  const normalized = { id: input.id.trim(), email: input.email.trim(), slug: input.slug || '' };
  const key = JSON.stringify(normalized);
  current.current = key;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return {
    matches: value => Boolean(value) && JSON.stringify(value) === current.current,
    capture: () => {
      const version = ++latest.current;
      return {
        input: normalized,
        isCurrent: () => mounted.current && latest.current === version && current.current === key,
        isLatest: () => mounted.current && latest.current === version,
      };
    },
  };
}
