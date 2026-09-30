// IndexedDB による端末内保存
// books:   { id, title, totalChars, offset, addedAt, openedAt, folderId, order }
//          ※offset = 読んだ位置（字）、folderId = 入っているフォルダ（null なら本棚直下）、order = 並び順
// texts:   { id, raw }  ※本文（一覧表示で読み込まないよう分けて保存）
// folders: { id, name, order, addedAt }  ※フォルダ（本棚直下に置く。入れ子はしない）
const DB_NAME = 'flash-reader';
const DB_VERSION = 2;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        // 既存のデータは残したまま、足りない保存場所だけ作る（v1 → v2 でフォルダを追加）
        const db = req.result;
        for (const name of ['books', 'texts', 'folders']) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        }
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

// 複数の本のメタ情報をまとめて保存する（並べ替え・移動用）
export function updateBooks(metas) {
  return run('books', 'readwrite', (tx) => {
    const st = tx.objectStore('books');
    for (const m of metas) st.put(m);
  });
}

export function listFolders() {
  return run('folders', 'readonly', (tx, set) => {
    const req = tx.objectStore('folders').getAll();
    req.onsuccess = () => set(req.result);
  });
}

export function putFolders(folders) {
  return run('folders', 'readwrite', (tx) => {
    const st = tx.objectStore('folders');
    for (const f of folders) st.put(f);
  });
}

// フォルダを消す。中の本は消さず、呼び出し側で本棚直下へ移してから呼ぶ
export function deleteFolder(id) {
  return run('folders', 'readwrite', (tx) => {
    tx.objectStore('folders').delete(id);
  });
}

export function deleteBook(id) {
  return run(['books', 'texts'], 'readwrite', (tx) => {
    tx.objectStore('books').delete(id);
    tx.objectStore('texts').delete(id);
  });
}
