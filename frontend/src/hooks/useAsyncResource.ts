import { useCallback, useEffect, useState } from "react";
import { errorText } from "../bridge";

/** Ignore results from a previous refresh or an unmounted page. */
export function useAsyncResource<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    void Promise.resolve()
      .then(load)
      .then((value) => {
        if (current) setData(value);
      })
      .catch((reason) => {
        if (current) setError(errorText(reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [load, revision]);

  return { data, error, loading, refresh };
}
