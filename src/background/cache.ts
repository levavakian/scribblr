// Translations cached in IndexedDB, keyed by a hash of the language pair, the block's text and the
// chunk. Chunk selection is stable for a day, so reloading a page costs no requests.

const DB_NAME = 'scribblr';
const STORE = 'translations';
const MAX_AGE_MS = 14 * 24 * 3600_000;

interface Entry {
  k: string;
  v: string;
  t: number;
}

let db: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'k' }).createIndex('t', 't');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      db = null;
      reject(request.error);
    };
  });
  return db;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export async function getCached(keys: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!keys.length) return found;
  try {
    const tx = (await open()).transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    for (const key of keys) {
      const request = store.get(key);
      request.onsuccess = () => {
        const entry = request.result as Entry | undefined;
        if (entry) found.set(key, entry.v);
      };
    }
    await done(tx);
  } catch (error) {
    console.warn('scribblr: cache read failed', error);
  }
  return found;
}

export async function putCached(entries: Array<[string, string]>): Promise<void> {
  if (!entries.length) return;
  try {
    const tx = (await open()).transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const t = Date.now();
    for (const [k, v] of entries) store.put({ k, v, t } satisfies Entry);
    await done(tx);
  } catch (error) {
    console.warn('scribblr: cache write failed', error);
  }
}

export async function pruneCache(): Promise<void> {
  try {
    const tx = (await open()).transaction(STORE, 'readwrite');
    const range = IDBKeyRange.upperBound(Date.now() - MAX_AGE_MS);
    const cursor = tx.objectStore(STORE).index('t').openCursor(range);
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      c.delete();
      c.continue();
    };
    await done(tx);
  } catch (error) {
    console.warn('scribblr: cache prune failed', error);
  }
}

export async function clearCache(): Promise<void> {
  const tx = (await open()).transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await done(tx);
}
