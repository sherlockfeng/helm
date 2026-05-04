/**
 * Generic data-fetching hook on top of the helm REST client. Three states:
 * loading / error / data. Refetch on demand via `reload()`.
 *
 * Deliberately small — no caching layer, no SWR. The renderer reloads on
 * SSE events anyway, so a global cache adds complexity without much win.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseApiResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: React.DependencyList = [],
): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    setLoading(true);
    setError(null);
    void fetcher()
      .then((v) => { if (aliveRef.current) setData(v); })
      .catch((err) => { if (aliveRef.current) setError(err as Error); })
      .finally(() => { if (aliveRef.current) setLoading(false); });
    return () => { aliveRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, loading, error, reload };
}
