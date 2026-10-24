// Keep this module independent of React/the native bridge so persistence ordering
// can be tested with a deterministic clock and deliberately delayed bridge calls.
export function createEditorDraftOperations() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const result = tail.then(operation);
      // A failed operation must not poison subsequent recovery loads or retries.
      tail = result.catch(() => {});
      return result;
    },
    idle(): Promise<unknown> {
      return tail;
    },
  };
}

// Shared across dialog remounts: an old write must finish before a new dialog
// loads or deletes the recovery copy. This queue never contains remote uploads.
export const editorDraftOperations = createEditorDraftOperations();

type Timer = ReturnType<typeof setTimeout>;
type DraftClock = {
  set: (callback: () => void, delay: number) => Timer;
  clear: (timer: Timer) => void;
};

export function createEditorDraftPersistence({
  operations = editorDraftOperations,
  clock = { set: setTimeout, clear: clearTimeout },
  onPending,
  onStored,
  onError,
}: {
  operations?: ReturnType<typeof createEditorDraftOperations>;
  clock?: DraftClock;
  onPending: () => void;
  onStored: () => void;
  onError: (error: unknown) => void;
}) {
  let debounce: Timer | null = null;
  let maxWait: Timer | null = null;
  let pending: (() => Promise<void>) | null = null;
  let sequence = 0;

  function cancelTimers() {
    if (debounce !== null) clock.clear(debounce);
    if (maxWait !== null) clock.clear(maxWait);
    debounce = maxWait = null;
  }

  function flush(): Promise<void> {
    cancelTimers();
    const operation = pending;
    pending = null;
    return operation ? operations.run(operation) : Promise.resolve();
  }

  function cancel() {
    cancelTimers();
    pending = null;
    ++sequence;
  }

  return {
    schedule(write: () => Promise<void>) {
      const token = ++sequence;
      onPending();
      pending = async () => {
        try {
          await write();
          if (token === sequence) onStored();
        } catch (error) {
          if (token === sequence) onError(error);
        }
      };
      if (debounce !== null) clock.clear(debounce);
      debounce = clock.set(() => {
        void flush();
      }, 300);
      // A pure trailing debounce never persists during uninterrupted typing.
      if (maxWait === null)
        maxWait = clock.set(() => {
          void flush();
        }, 1500);
    },
    flush,
    // Cancel pending timers, not already-issued writes. Useful after flushing on
    // unmount to suppress stale UI callbacks without deleting recovery data.
    cancel,
    async clear(
      remove: () => Promise<void>,
      guard: () => boolean = () => true,
    ) {
      const cancelledWrite = pending;
      cancel();
      const token = sequence;
      try {
        const removed = await operations.run(async () => {
          if (token !== sequence || !guard()) return false;
          await remove();
          return true;
        });
        // Changes arriving while deletion was in flight still need persistence.
        return removed && token === sequence && guard();
      } catch (error) {
        // Failed discard is not permission to lose the latest pending edits.
        // Restore their recovery copy, but keep reporting the deletion failure.
        if (cancelledWrite && token === sequence)
          await operations.run(cancelledWrite);
        throw error;
      }
    },
  };
}
