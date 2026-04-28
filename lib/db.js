// IndexedDB ラッパー。SW の 30 秒アイドル停止前提で、module-scope の
// dbPromise は同一実行コンテキスト内の request coalescing として扱う。

const DB_NAME = 'llm-history-hub';
// v1 → v2: by_favorite index 追加 (お気に入り絞り込みは現状全件 filter で十分だが、
// 将来 cursor で開く可能性に備えて index を作成する)。データ変換は不要。
const DB_VERSION = 2;
const STORE = 'records';

let dbPromise = null;

export async function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = (event && typeof event.oldVersion === 'number') ? event.oldVersion : 0;
      // v0 → v1: 初期スキーマ。
      if (oldVersion < 1 && !db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('by_updatedAt', 'updatedAt');
        store.createIndex('by_service', 'service');
        store.createIndex('by_accountEmail', 'accountEmail');
      }
      // v1 → v2: by_favorite index 追加。upgrade transaction 経由で既存 store にアクセス。
      if (oldVersion < 2 && db.objectStoreNames.contains(STORE)) {
        const tx = req.transaction;
        if (tx) {
          const store = tx.objectStore(STORE);
          if (!store.indexNames.contains('by_favorite')) {
            store.createIndex('by_favorite', 'favorite');
          }
        }
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      console.warn('[LLM History Hub] IndexedDB open blocked');
    };
  });

  return dbPromise;
}

export async function upsert(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('upsert: records must be an array');
  }
  if (records.length === 0) return;

  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('upsert: transaction aborted'));
    const store = tx.objectStore(STORE);
    for (const rec of records) {
      store.put(rec);
    }
  });
}

export async function readAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function clear() {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const req = tx.objectStore(STORE).clear();
    req.onerror = () => reject(req.error);
  });
}

// 指定 service の全レコードを 1 トランザクションで削除する。
// `by_service` index + cursor で O(削除件数)。readAll → filter → put は不要。
// 複数 service を渡した場合は同一トランザクション内で並列に cursor を回す
// （IndexedDB 仕様上、同一 readwrite トランザクション内の複数 cursor は安全）。
// 戻り値: { deleted: 合計件数, perService: { [svc]: 件数 } }。
// perService を返すのは popup ステータスバーで「ChatGPT (5件), Grok (3件)」のように
// サービスごと内訳を表示するため。
export async function deleteByServices(services) {
  if (!Array.isArray(services) || services.length === 0) {
    return { deleted: 0, perService: {} };
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    let totalDeleted = 0;
    const perService = {};
    tx.oncomplete = () => resolve({ deleted: totalDeleted, perService });
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('deleteByServices: aborted'));
    const store = tx.objectStore(STORE);
    const index = store.index('by_service');
    for (const svc of services) {
      if (typeof svc !== 'string' || svc.length === 0) continue;
      perService[svc] = 0;
      const req = index.openCursor(IDBKeyRange.only(svc));
      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          totalDeleted += 1;
          perService[svc] += 1;
          cursor.continue();
        }
      };
      // cursor.onerror は tx.onerror に伝播するので個別ハンドラは置かない。
    }
  });
}
