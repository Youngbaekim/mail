// 기기 저장소(IndexedDB) — 메일 원본은 Gmail 서버, 이 기기에는 빠르게 보기 위한 사본만 보관
// · threads: 스레드 요약 + 본문 원문(Gmail API format=full) + historyId(변경 확인용)
// · lists  : 편지함별 마지막 목록(앱을 켜자마자 보여 주기용)
// · atts   : 열어 본 첨부·본문 속 그림
const DEMO = new URLSearchParams(location.search).has('demo');
const NAME = DEMO ? 'ybm-demo-cache' : 'ybm-cache';
let dbP = null;

function open() {
  if (dbP) return dbP;
  dbP = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('threads')) {
        const s = db.createObjectStore('threads', { keyPath: 'key' });
        s.createIndex('account', 'account');
      }
      if (!db.objectStoreNames.contains('lists')) db.createObjectStore('lists', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('atts')) db.createObjectStore('atts', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbP = null; rej(r.error); };
  });
  return dbP;
}

async function tx(store, mode, fn) {
  try {
    const db = await open();
    return await new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      const r = fn(s);
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  } catch (e) { console.warn('[cache]', e); return undefined; }
}

export const getThread = (key) => tx('threads', 'readonly', (s) => s.get(key));
export const putThread = (rec) => tx('threads', 'readwrite', (s) => s.put({ ...rec, savedAt: Date.now() }));
export const delThread = (key) => tx('threads', 'readwrite', (s) => s.delete(key));
export async function patchThread(key, fn) {
  const rec = await getThread(key);
  if (rec) { fn(rec); await putThread(rec); }
}

export const getList = (key) => tx('lists', 'readonly', (s) => s.get(key)).then((r) => r?.items || null);
export const putList = (key, items) => tx('lists', 'readwrite', (s) => s.put({ key, items: items.slice(0, 150) }));

export const getAtt = (key) => tx('atts', 'readonly', (s) => s.get(key)).then((r) => r?.data || null);
export const putAtt = (key, data) => tx('atts', 'readwrite', (s) => s.put({ key, data, savedAt: Date.now() }));

/** 계정별 오래된 스레드 정리 (최근 keep통만 본문 보관) */
export async function prune(account, keep = 600) {
  const all = await tx('threads', 'readonly', (s) => s.index('account').getAll(account));
  if (!all || all.length <= keep) return;
  all.sort((a, b) => (b.date || 0) - (a.date || 0));
  const old = all.slice(keep).map((r) => r.key);
  await tx('threads', 'readwrite', (s) => { old.forEach((k) => s.delete(k)); return null; });
}

export async function count() {
  const n = await tx('threads', 'readonly', (s) => s.count());
  const full = await tx('threads', 'readonly', (s) => s.getAll()).then((a) => (a || []).filter((r) => r.raw).length);
  return { threads: n || 0, full: full || 0 };
}

export async function clearAll() {
  await tx('threads', 'readwrite', (s) => s.clear());
  await tx('lists', 'readwrite', (s) => s.clear());
  await tx('atts', 'readwrite', (s) => s.clear());
}

export async function persist() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
export async function usage() {
  try { const e = await navigator.storage.estimate(); return e.usage || 0; } catch { return 0; }
}

/** 저장된 스레드 전부 (검색용) */
export const allThreads = () => tx('threads', 'readonly', (s) => s.getAll()).then((a) => a || []);
