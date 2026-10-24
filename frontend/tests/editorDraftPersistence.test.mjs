import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  createEditorDraftOperations,
  createEditorDraftPersistence,
} from "../src/editorDraftPersistence.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(operations = createEditorDraftOperations()) {
  let now = 0,
    nextID = 0;
  const timers = new Map();
  const events = [];
  const persistence = createEditorDraftPersistence({
    operations,
    clock: {
      set(callback, delay) {
        const id = ++nextID;
        timers.set(id, { at: now + delay, callback });
        return id;
      },
      clear(id) {
        timers.delete(id);
      },
    },
    onPending: () => events.push("pending"),
    onStored: () => events.push("stored"),
    onError: (error) => events.push(error.message),
  });
  return {
    persistence,
    operations,
    events,
    timers,
    async advance(ms) {
      const until = now + ms;
      while (true) {
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry || entry[1].at > until) break;
        now = entry[1].at;
        timers.delete(entry[0]);
        entry[1].callback();
      }
      now = until;
      await operations.idle();
    },
  };
}

test("draft debounce writes only the latest text, including an empty edit", async () => {
  const f = fixture();
  const writes = [];
  f.persistence.schedule(async () => {
    writes.push("first");
  });
  await f.advance(200);
  f.persistence.schedule(async () => {
    writes.push("");
  });
  await f.advance(299);
  assert.deepEqual(writes, []);
  await f.advance(1);
  assert.deepEqual(writes, [""]);
  assert.deepEqual(f.events, ["pending", "pending", "stored"]);
  assert.equal(f.timers.size, 0);
});

test("uninterrupted typing persists the latest snapshot by the maximum wait", async () => {
  const f = fixture();
  const writes = [];
  for (let n = 0; n < 15; n++) {
    f.persistence.schedule(async () => {
      writes.push(n);
    });
    await f.advance(100);
  }
  assert.deepEqual(writes, [14]);
  assert.equal(f.timers.size, 0);
});

test("unmount/unload flush preserves pending recovery without deleting it", async () => {
  const f = fixture();
  const writes = [];
  f.persistence.schedule(async () => {
    writes.push("latest");
  });
  const flushed = f.persistence.flush();
  f.persistence.cancel(); // suppress stale UI callbacks after unmount
  await flushed;
  await f.advance(2000);
  assert.deepEqual(writes, ["latest"]);
  assert.deepEqual(f.events, ["pending"]);
});

test("clear cancels a delayed write so it cannot resurrect a discarded draft", async () => {
  const f = fixture();
  const calls = [];
  f.persistence.schedule(async () => {
    calls.push("write");
  });
  assert.equal(
    await f.persistence.clear(async () => {
      calls.push("remove");
    }),
    true,
  );
  await f.advance(2000);
  assert.deepEqual(calls, ["remove"]);
  assert.deepEqual(f.events, ["pending"]);
});

test("clear waits for an issued write and suppresses its stale success indicator", async () => {
  const f = fixture();
  const gate = deferred();
  const calls = [];
  f.persistence.schedule(async () => {
    calls.push("write");
    await gate.promise;
  });
  const writing = f.persistence.flush();
  await Promise.resolve();
  const clearing = f.persistence.clear(async () => {
    calls.push("remove");
  });
  assert.deepEqual(calls, ["write"]);
  gate.resolve();
  await writing;
  assert.equal(await clearing, true);
  assert.deepEqual(calls, ["write", "remove"]);
  assert.deepEqual(f.events, ["pending"]);
});

test("an older write cannot report stored while newer input is still pending", async () => {
  const f = fixture();
  const gate = deferred();
  f.persistence.schedule(() => gate.promise);
  const writing = f.persistence.flush();
  await Promise.resolve();
  f.persistence.schedule(async () => {});
  gate.resolve();
  await writing;
  assert.deepEqual(f.events, ["pending", "pending"]);
  await f.advance(300);
  assert.equal(f.events.at(-1), "stored");
});

test("a remounted dialog loads only after the previous dialog's write", async () => {
  const operations = createEditorDraftOperations();
  const old = fixture(operations);
  const gate = deferred();
  let stored = null;
  old.persistence.schedule(async () => {
    await gate.promise;
    stored = "old draft";
  });
  const writing = old.persistence.flush();
  const loaded = operations.run(async () => stored);
  gate.resolve();
  await writing;
  assert.equal(await loaded, "old draft");
});

test("storage errors are reported and do not poison retry/load operations", async () => {
  const f = fixture();
  f.persistence.schedule(async () => {
    throw new Error("disk full");
  });
  await f.persistence.flush();
  assert.deepEqual(f.events, ["pending", "disk full"]);
  assert.equal(
    await f.operations.run(async () => "load still works"),
    "load still works",
  );
  f.persistence.schedule(async () => {});
  await f.persistence.flush();
  assert.equal(f.events.at(-1), "stored");
});

test("delete failure restores a cancelled pending draft and allows later retry", async () => {
  const f = fixture();
  let stored = "old";
  f.persistence.schedule(async () => {
    stored = "newest";
  });
  await assert.rejects(
    f.persistence.clear(async () => {
      throw new Error("permission denied");
    }),
    /permission denied/,
  );
  assert.equal(stored, "newest");
  assert.notEqual(f.events.at(-1), "stored");
  assert.equal(
    await f.persistence.clear(async () => {
      stored = null;
    }),
    true,
  );
  await f.advance(2000);
  assert.equal(stored, null);
});

test("new input while a save's clear is queued prevents stale deletion", async () => {
  const f = fixture();
  const gate = deferred();
  const calls = [];
  const blocked = f.operations.run(() => gate.promise);
  const clearing = f.persistence.clear(async () => {
    calls.push("remove");
  });
  f.persistence.schedule(async () => {
    calls.push("new edit");
  });
  gate.resolve();
  await blocked;
  assert.equal(await clearing, false);
  await f.advance(300);
  assert.deepEqual(calls, ["new edit"]);
});

test("a save snapshot guard refuses deletion when live text is newer", async () => {
  const f = fixture();
  let removed = false;
  assert.equal(
    await f.persistence.clear(
      async () => {
        removed = true;
      },
      () => false,
    ),
    false,
  );
  assert.equal(removed, false);
});

test("new edits while delete is in flight survive and make clear return false", async () => {
  const f = fixture();
  const gate = deferred();
  const calls = [];
  const clearing = f.persistence.clear(async () => {
    await gate.promise;
    calls.push("remove");
  });
  await Promise.resolve();
  f.persistence.schedule(async () => {
    calls.push("new draft");
  });
  gate.resolve();
  assert.equal(await clearing, false);
  await f.advance(300);
  assert.deepEqual(calls, ["remove", "new draft"]);
});

// The existing harness has no React/DOM renderer. Keep a few structural checks
// around the UI wiring while the ordering/timing tests above execute real code.
const dialog = readFileSync(
  new URL("../src/TextFileDialog.tsx", import.meta.url),
  "utf8",
);

test("recovery retains the original remote revision and requires explicit consent", () => {
  assert.match(dialog, /revision: recovery\.revision/);
  assert.match(dialog, /setRecovery\(draft\)/);
  assert.match(dialog, /恢复草稿/);
  assert.match(dialog, /暂不恢复，保留草稿并关闭/);
  assert.match(dialog, /保留本地草稿并关闭/);
  const close = dialog.slice(
    dialog.indexOf("function requestClose()"),
    dialog.indexOf("async function discardAndContinue"),
  );
  assert.match(
    close,
    /if \(recovery \|\| draftLoadFailed \|\| \(!dirty && draftDeleteFailed\)\)/,
  );
  assert.match(close, /flushDraft\(\);\s*onClose\(\);\s*return;/);
  assert.doesNotMatch(close, /clearDraft\(/);
});

test("UI promptly tracks dirty state and preserves drafts on generic unmount", () => {
  assert.match(
    dialog,
    /trackDirty\(remote && value !== document\.text\);\s*scheduleDraft/,
  );
  assert.match(
    dialog,
    /flushDraft\(\);\s*draftPersistence\.current!\.cancel\(\);\s*trackDirty\(false\)/,
  );
  assert.doesNotMatch(
    dialog,
    /event\.preventDefault\(\)[\s\S]{0,40}event\.returnValue/,
  );
  assert.match(
    dialog,
    /if \(!remote \|\| session\.demo \|\| draftLoadFailed\) return/,
  );
  assert.match(dialog, /readOnly=\{[^}]*draftLoadFailed/);
  assert.match(dialog, /saveRequest !== request\.current\) return false/);
});
