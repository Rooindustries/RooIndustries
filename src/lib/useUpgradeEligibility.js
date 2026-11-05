import { useEffect, useRef } from 'react';
import { fetchJsonWithTimeout, reportRequestError } from './clientRequest';

const eligibilityAnswers = new Set([400, 404, 429]);

export const fetchUpgradeInfo = async (input, signal) => {
  const result = await fetchJsonWithTimeout('/api/ref/getUpgradeInfo', {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!result.response.ok && !eligibilityAnswers.has(result.response.status)) {
    reportRequestError(new Error(result.data?.error || 'Upgrade eligibility check failed.'));
  }
  return result;
};

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
