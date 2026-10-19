export interface TerminalHistoryRecord {
  id: string;
  title: string;
  subtitle: string;
  terminalNumber: number;
  createdAt: number;
  updatedAt: number;
  output: string;
  pinned: boolean;
  truncated: boolean;
}

const databaseName = "orbit-ssh-terminal-history";
const storeName = "records";
const maxOutputCharacters = 512 * 1024;
let database: Promise<IDBDatabase> | undefined;
let writeQueue: Promise<unknown> = Promise.resolve();

function openDatabase() {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("此环境不支持本地终端历史存储"));
      return;
    }
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName, { keyPath: "id" });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("无法打开历史记录"));
    request.onblocked = () => reject(new Error("历史记录正被其他窗口占用"));
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}

function enqueueWrite<T>(operation: () => Promise<T>) {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function ordered(records: TerminalHistoryRecord[]) {
  return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

function limitRecords(records: TerminalHistoryRecord[], limit: number) {
  const keptRecent = ordered(records.filter((record) => !record.pinned)).slice(
    0,
    limit,
  );
  const kept = new Set([
    ...records.filter((record) => record.pinned).map((record) => record.id),
    ...keptRecent.map((record) => record.id),
  ]);
  return ordered(records.filter((record) => kept.has(record.id)));
}

export function trimTerminalHistoryOutput(output: string) {
  if (output.length <= maxOutputCharacters)
    return { output, truncated: false };
  const start = output.length - maxOutputCharacters;
  const lineBreak = output.indexOf("\n", start);
  return {
    output: output.slice(lineBreak < 0 ? start : lineBreak + 1),
    truncated: true,
  };
}

export function loadTerminalHistory() {
  return openDatabase().then(
    (db) =>
      new Promise<TerminalHistoryRecord[]>((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(ordered(request.result));
        request.onerror = () =>
          reject(request.error ?? new Error("无法读取历史记录"));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("读取历史记录失败"));
      }),
  );
}

export function saveTerminalHistory(
  record: TerminalHistoryRecord,
  limit: number,
) {
  return enqueueWrite(
    () =>
      openDatabase().then(
        (db) =>
          new Promise<TerminalHistoryRecord[]>((resolve, reject) => {
            const transaction = db.transaction(storeName, "readwrite");
            const store = transaction.objectStore(storeName);
            const request = store.getAll();
            let kept: TerminalHistoryRecord[] = [];
            request.onsuccess = () => {
              const all = request.result as TerminalHistoryRecord[];
              const records = all.filter((item) => item.id !== record.id);
              records.push(record);
              kept = limitRecords(records, limit);
              const keptIds = new Set(kept.map((item) => item.id));
              for (const item of all)
                if (!keptIds.has(item.id)) store.delete(item.id);
              if (keptIds.has(record.id)) store.put(record);
            };
            request.onerror = () => transaction.abort();
            transaction.oncomplete = () => resolve(kept);
            transaction.onerror = () =>
              reject(transaction.error ?? new Error("无法保存终端历史"));
            transaction.onabort = () =>
              reject(transaction.error ?? new Error("无法保存终端历史"));
          }),
      ),
  );
}

export function trimTerminalHistory(limit: number) {
  return enqueueWrite(
    () =>
      openDatabase().then(
        (db) =>
          new Promise<TerminalHistoryRecord[]>((resolve, reject) => {
            const transaction = db.transaction(storeName, "readwrite");
            const store = transaction.objectStore(storeName);
            const request = store.getAll();
            let kept: TerminalHistoryRecord[] = [];
            request.onsuccess = () => {
              const all = request.result as TerminalHistoryRecord[];
              kept = limitRecords(all, limit);
              const keptIds = new Set(kept.map((record) => record.id));
              for (const record of all)
                if (!keptIds.has(record.id)) store.delete(record.id);
            };
            request.onerror = () => transaction.abort();
            transaction.oncomplete = () => resolve(kept);
            transaction.onerror = () =>
              reject(transaction.error ?? new Error("无法整理历史记录"));
            transaction.onabort = () =>
              reject(transaction.error ?? new Error("无法整理历史记录"));
          }),
      ),
  );
}

export function deleteTerminalHistory(id: string) {
  return enqueueWrite(
    () =>
      openDatabase().then(
        (db) =>
          new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(storeName, "readwrite");
            transaction.objectStore(storeName).delete(id);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () =>
              reject(transaction.error ?? new Error("无法删除历史记录"));
            transaction.onabort = () =>
              reject(transaction.error ?? new Error("无法删除历史记录"));
          }),
      ),
  );
}

export function displayTerminalOutput(output: string) {
  return output
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-2A-Za-z]/g, "")
    .replace(/\x1b./gs, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

export function fuzzyMatch(query: string, text: string) {
  const needle = [...query.trim().toLocaleLowerCase()];
  if (!needle.length) return true;
  const haystack = text.toLocaleLowerCase();
  if (haystack.includes(needle.join(""))) return true;
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index] && ++index === needle.length) return true;
  }
  return false;
}
