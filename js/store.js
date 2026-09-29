// IndexedDB による端末内保存
// books: { id, title, totalChars, offset, addedAt, openedAt }  ※offset = 読んだ位置（字）
// texts: { id, raw }  ※本文（一覧表示で読み込まないよう分けて保存）
const DB_NAME = 'flash-reader';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('books', { keyPath: 'id' });
        db.createObjectStore('texts', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// トランザクションを実行し、完了時に setResult で渡された値を返す
async function run(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    fn(tx, (v) => {
      result = v;
    });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function listBooks() {
  return run('books', 'readonly', (tx, set) => {
    const req = tx.objectStore('books').getAll();
    req.onsuccess = () => set(req.result);
  });
}

export function getText(id) {
  return run('texts', 'readonly', (tx, set) => {
    const req = tx.objectStore('texts').get(id);
    req.onsuccess = () => set(req.result?.raw);
  });
}

export function addBook(meta, raw) {
  return run(['books', 'texts'], 'readwrite', (tx) => {
    tx.objectStore('books').put(meta);
    tx.objectStore('texts').put({ id: meta.id, raw });
  });
}

export function updateBook(meta) {
  return run('books', 'readwrite', (tx) => {
    tx.objectStore('books').put(meta);
  });
}

export function deleteBook(id) {
  return run(['books', 'texts'], 'readwrite', (tx) => {
    tx.objectStore('books').delete(id);
    tx.objectStore('texts').delete(id);
  });
}
