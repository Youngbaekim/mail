// YB-Mail — 두 Google 계정(학교·개인)을 한 화면에서 쓰는 메일 앱
import './style.css';
import { getTheme, setTheme, isDark } from './theme.js';
import * as auth from './auth.js';
import * as gm from './gmail.js';
import * as cache from './cache.js';
import { setupEditor, extractInline, toolbarHtml, paletteHtml, format, activeEditor, sanitize } from './editor.js';
import { buildRaw, parseAddrList, validEmail, escHtml, textToHtml, htmlToText, b64ToBytes } from './mime.js';
import { ACCOUNT_COLORS } from './config.js';

const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
const PARAMS = new URLSearchParams(location.search);
const DEMO = PARAMS.has('demo');
const CPWIN = PARAMS.get('cpwin'); // 별도 창에서 메일 쓰기
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = escHtml;
const PFX = DEMO ? 'ybm-demo-' : 'ybm-';
const DESK = window.ybDesktop || null; // YB-Mail.exe(데스크톱 프로그램) 안에서 실행 중
const pref = {
  get: (k, d) => { try { const v = localStorage.getItem(PFX + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(PFX + k, JSON.stringify(v)); } catch { /* 무시 */ } },
};

const FOLDERS = {
  INBOX: ['받은편지함', '📥'],
  STARRED: ['별표', '★'],
  DRAFT: ['임시메일함', '📝'],
  SENT: ['보낸편지함', '📤'],
  ALL: ['전체 보관함', '🗂'],
  SPAM: ['스팸', '⚠'],
  TRASH: ['휴지통', '🗑'],
};
const ALL_FOLDERS = ['INBOX', 'STARRED', 'DRAFT', 'SENT', 'ALL', 'SPAM', 'TRASH'];
const ACC_MAIN = ['INBOX', 'DRAFT', 'SENT', 'SPAM'];
const ACC_MORE = ['STARRED', 'ALL', 'TRASH'];
const ALL_MAIN = ['INBOX', 'STARRED', 'DRAFT', 'SENT', 'SPAM'];

const state = {
  folder: pref.get('folder', { scope: 'all', label: 'INBOX' }),
  q: '',
  unreadOnly: false,
  items: [],
  pages: {},          // email → 다음 쪽 토큰(null이면 끝)
  loading: false,
  loadSeq: 0,
  sel: null,          // 읽는 중인 스레드 key
  checked: new Set(), // 선택(복수)한 스레드 key
  anchor: null,       // Shift 범위 선택 기준
  thread: null,
  unread: {},
  labels: {},
  expanded: new Set(pref.get('expanded', [])),
  showImages: pref.get('showImages', true),
  undoSec: pref.get('undoSec', 30),
  zoom: pref.get('zoom', 100),
  prefetchN: pref.get('prefetchN', 200),
};

/* ───────── 공용 ───────── */
const accs = () => auth.accounts();
const acc = (email) => accs().find((a) => a.email === email) || { email, color: '#888', label: '?' };
const connected = () => accs().filter((a) => auth.token(a.email));
const accLabel = (a) => a.label || a.email.split('@')[0];
const folderKey = (f = state.folder) => `${f.scope}|${f.label}`;
const sigHtml = (a) => a.signatureHtml ?? (a.signature ? textToHtml(a.signature) : '');

let toastTimer;
function toast(msg, ms = 3200, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
}
let syncLock = '';
function setSync(s, text) { const el = $('#sync'); el.dataset.s = s; el.textContent = text; }
function fail(e, where = '') {
  console.warn('[YB-Mail]', where, e);
  if (e instanceof auth.AuthError) { renderBanner(); renderSide(); return; }
  toast(e.message || String(e), 5000);
}

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const pad = (n) => String(n).padStart(2, '0');
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
function shortDate(ms) {
  const d = new Date(ms), now = new Date();
  if (sameDay(d, now)) return `${d.getHours() < 12 ? '오전' : '오후'} ${(d.getHours() % 12) || 12}:${pad(d.getMinutes())}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return '어제';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}. ${d.getDate()}.(${DOW[d.getDay()]})`;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}
function longDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.(${DOW[d.getDay()]}) ${d.getHours() < 12 ? '오전' : '오후'} ${(d.getHours() % 12) || 12}:${pad(d.getMinutes())}`;
}
function dayGroup(ms) {
  const d = new Date(ms), now = new Date();
  if (sameDay(d, now)) return '오늘';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return '어제';
  const w = new Date(now); w.setDate(now.getDate() - 6); w.setHours(0, 0, 0, 0);
  if (d >= w) return '이번 주';
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return '이번 달';
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}
const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`);
const fileIcon = (t, n = '') => (/^image\//.test(t) ? '🖼' : /pdf/.test(t) || /\.pdf$/i.test(n) ? '📕' : /sheet|excel|\.xlsx?$/i.test(t + n) ? '📗' : /word|\.docx?$|\.hwpx?$/i.test(t + n) ? '📘' : /presentation|powerpoint|\.pptx?$/i.test(t + n) ? '📙' : /zip|compressed/.test(t) ? '🗜' : '📄');
const initial = (from) => { const a = parseAddrList(from)[0]; const s = (a?.name || a?.email || '?').replace(/["']/g, '').trim(); return s.slice(0, 1).toUpperCase(); };
const isMine = (from) => { const a = parseAddrList(from)[0]; return !!a && accs().some((x) => x.email === a.email.toLowerCase()); };
// 새 창 아이콘 (겹친 창)
const WIN_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="4.5" y="1.5" width="10" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11.5 12v1a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 13V6A1.5 1.5 0 0 1 3 4.5h1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const PALETTE = ['#5b7fbf', '#3f9b7a', '#c0703a', '#8f5fbf', '#bf5b7f', '#4d9bb3', '#9a8a3a', '#6b7a8f'];
function colorOf(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }

/* ───────── 연락처 (받는 사람 자동 완성) ───────── */
const contacts = new Map(Object.entries(pref.get('contacts', {})));
let contactsDirty = false;
function learn(list, weight = 1) {
  for (const { name, email } of parseAddrList(list)) {
    const e = email.toLowerCase();
    if (!validEmail(e) || /no-?reply|mailer-daemon/i.test(e)) continue;
    const c = contacts.get(e) || { n: '', c: 0 };
    if (name && !/^"?\s*$/.test(name)) c.n = name;
    c.c += weight;
    contacts.set(e, c);
    contactsDirty = true;
  }
}
setInterval(() => {
  if (!contactsDirty) return;
  contactsDirty = false;
  const top = [...contacts.entries()].sort((a, b) => b[1].c - a[1].c).slice(0, 600);
  pref.set('contacts', Object.fromEntries(top));
}, 10_000);

/* ───────── 팝업 메뉴 (우클릭 등) ───────── */
function showPop(at, html, onPick) {
  const p = $('#pop');
  p.innerHTML = html;
  p.hidden = false;
  const w = p.offsetWidth, h = p.offsetHeight;
  let x, y;
  if (at instanceof Element) { const r = at.getBoundingClientRect(); x = r.left; y = r.bottom + 6; if (y + h > innerHeight) y = r.top - h - 6; }
  else { x = at.x; y = at.y; if (y + h > innerHeight - 8) y = Math.max(8, at.y - h); }
  p.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  p.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
  p.onclick = (e) => {
    const b = e.target.closest('[data-k]');
    if (!b || b.disabled) return;
    closePop();
    onPick?.(b.dataset.k, b);
  };
}
const closePop = () => ($('#pop').hidden = true);
const mi = (k, label, { icon = '', dis = false, cls = '', hint = '' } = {}) => `<button data-k="${k}" class="${cls}"${dis ? ' disabled' : ''}><span class="pi">${icon}</span>${label}${hint ? `<span class="k">${hint}</span>` : ''}</button>`;

/* ───────── 1열: 편지함 ───────── */
function folderName(f = state.folder) {
  if (ALL_FOLDERS.includes(f.label)) return FOLDERS[f.label][0];
  return state.labels[f.scope]?.find((l) => l.id === f.label)?.name || '라벨';
}
function fItem(scope, label, name, icon, n) {
  const on = state.folder.scope === scope && state.folder.label === label;
  return `<button class="f-item${on ? ' active' : ''}" data-scope="${esc(scope)}" data-label="${esc(label)}"><span class="ic">${icon}</span><span class="nm">${esc(name)}</span>${n ? `<span class="n">${n}</span>` : ''}</button>`;
}
function renderSide() {
  const list = accs();
  const total = list.reduce((s, a) => s + (state.unread[a.email] || 0), 0);
  let h = '';
  if (list.length > 1) {
    h += `<div class="f-sec"><div class="f-sec-h"><span class="em">모든 계정</span></div>`;
    for (const k of ALL_MAIN) h += fItem('all', k, k === 'INBOX' ? '통합 받은편지함' : FOLDERS[k][0], FOLDERS[k][1], k === 'INBOX' ? total : 0);
    h += '</div>';
  }
  for (const a of list) {
    const off = !auth.token(a.email);
    const exp = state.expanded.has(a.email);
    h += `<div class="f-sec" style="--acc:${a.color}"><div class="f-sec-h"><span class="dot" style="background:${a.color}"></span><span class="em" title="${esc(a.email)}">${esc(a.email)}</span>${off ? `<button class="acc-state off" data-reconnect="${esc(a.email)}" title="눌러서 다시 연결">연결</button>` : ''}</div>`;
    for (const k of ACC_MAIN) h += fItem(a.email, k, FOLDERS[k][0], FOLDERS[k][1], k === 'INBOX' ? state.unread[a.email] : 0);
    h += `<button class="f-more" data-expand="${esc(a.email)}">${exp ? '▾ 접기' : '▸ 별표·전체 보관함·휴지통·라벨'}</button>`;
    if (exp) {
      h += '<div class="f-sub">';
      for (const k of ACC_MORE) h += fItem(a.email, k, FOLDERS[k][0], FOLDERS[k][1]);
      for (const l of state.labels[a.email] || []) h += fItem(a.email, l.id, l.name, '🏷');
      h += '</div>';
    }
    h += '</div>';
  }
  $('#folders').innerHTML = h;
  document.title = total ? `(${total}) YB-Mail` : 'YB-Mail';
  try { if (total) navigator.setAppBadge?.(total); else navigator.clearAppBadge?.(); } catch { /* 무시 */ }
  DESK?.setBadge(total).catch(() => {});
}

async function selectFolder(scope, label) {
  if (scope !== 'all' && !accs().some((a) => a.email === scope)) scope = 'all';
  if (scope === 'all' && !ALL_FOLDERS.includes(label)) label = 'INBOX';
  state.folder = { scope, label };
  pref.set('folder', state.folder);
  state.sel = null;
  state.thread = null;
  state.checked.clear();
  document.body.classList.remove('drawer');
  renderSide();
  renderReader();
  // 기기 저장본으로 먼저 보여 주고, 서버에서 새로 확인
  const seq = ++state.loadSeq;
  const cached = !state.q && !state.unreadOnly ? await cache.getList(folderKey()) : null;
  if (seq !== state.loadSeq) return;
  state.items = (cached || []).filter((t) => accs().some((a) => a.email === t.account));
  state.pages = {};
  renderList();
  loadList({ silent: state.items.length > 0 });
}

/* ───────── 2열: 목록 ───────── */
function renderBanner() {
  const off = accs().filter((a) => !auth.token(a.email));
  const b = $('#banner');
  if (!off.length || !accs().length) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = off.map((a) => `<div><span class="dot" style="background:${a.color}"></span><span>${esc(a.email)} 연결이 끊겼습니다</span><button data-reconnect="${esc(a.email)}">다시 연결</button></div>`).join('');
}

function listTitle() {
  const f = state.folder;
  const where = f.scope === 'all' ? (f.label === 'INBOX' ? '' : ' · 모든 계정') : ` · ${accLabel(acc(f.scope))}`;
  return (f.scope === 'all' && f.label === 'INBOX' ? '통합 받은편지함' : folderName()) + where;
}

function renderList() {
  $('#list-title').textContent = listTitle();
  $('#chip-unread').classList.toggle('active', state.unreadOnly);
  const ul = $('#list');
  if (state.loading && !state.items.length) {
    ul.innerHTML = Array.from({ length: 7 }, () => '<li class="skeleton"><i style="width:40%"></i><i style="width:85%"></i><i style="width:65%"></i></li>').join('');
    return;
  }
  if (!state.items.length) {
    ul.innerHTML = `<li class="empty">${!connected().length ? '연결된 계정이 없습니다.' : state.q || state.unreadOnly ? '조건에 맞는 메일이 없습니다.' : '메일이 없습니다.'}</li>`;
    return;
  }
  const multi = state.folder.scope === 'all';
  const draft = state.folder.label === 'DRAFT';
  const sent = state.folder.label === 'SENT' || draft;
  const trash = state.folder.label === 'TRASH';
  let h = `<li class="col-h"><span>${sent ? '받는 사람' : '보낸 사람'}</span><span>제목</span><span></span><span>${sent ? '보낸 시각' : '받은 시각'}</span></li>`, grp = '';
  for (const t of state.items) {
    const g = dayGroup(t.date);
    if (g !== grp) { grp = g; h += `<li class="day-h">${g}</li>`; }
    const a = acc(t.account);
    const who = sent ? `받는 사람: ${gm.shortName(t.to) || '(없음)'}` : (t.senders.length > 1 ? t.senders.slice(-3).join(', ') : gm.shortName(t.from) || t.senders[0] || '(알 수 없음)');
    const cls = [t.unread && 'unread', t.key === state.sel && 'active', state.checked.has(t.key) && 'sel'].filter(Boolean).join(' ');
    h += `<li class="item ${cls}" data-key="${esc(t.key)}" style="--acc:${a.color}">
      <div class="i-main">
        <div class="i-row"><span class="i-from">${esc(who)}</span>${t.count > 1 ? `<span class="i-cnt">${t.count}</span>` : ''}<span class="i-tags">${t.hasAttach ? '📎' : ''}${t.starred ? '<span class="i-star">★</span>' : ''}</span><span class="i-date">${shortDate(t.date)}</span></div>
        <div class="i-row">${draft ? '<span class="draft-tag">임시</span>' : ''}<span class="i-subj">${esc(t.subject)}</span>${multi ? `<span class="acc-tag">${esc(accLabel(a))}</span>` : ''}</div>
        <div class="i-snip">${esc(t.snippet)}</div>
      </div>
      <div class="i-acts">
        ${state.folder.label === 'INBOX' ? '<button data-iact="archive" title="보관">🗄</button>' : ''}
        <button data-iact="${trash ? 'untrash' : 'trash'}" title="${trash ? '복원' : '삭제'}">${trash ? '♻' : '🗑'}</button>
        <button data-iact="${t.unread ? 'read' : 'unread'}" title="${t.unread ? '읽음으로' : '읽지 않음으로'}">✉</button>
      </div>
    </li>`;
  }
  if (Object.values(state.pages).some(Boolean)) h += `<li><button class="btn-ghost more" id="btn-more">${state.loading ? '불러오는 중…' : '더 보기'}</button></li>`;
  ul.innerHTML = h;
}

function query() {
  const q = [state.q.trim(), state.unreadOnly ? 'is:unread' : ''].filter(Boolean).join(' ');
  const label = state.folder.label;
  return { labelIds: label === 'ALL' ? undefined : [label], q };
}

async function loadList({ append = false, silent = false } = {}) {
  const seq = append ? state.loadSeq : ++state.loadSeq;
  const f = state.folder;
  const targets = (f.scope === 'all' ? accs() : accs().filter((a) => a.email === f.scope)).filter((a) => auth.token(a.email));
  if (!append && !silent) { state.items = []; state.pages = {}; }
  state.loading = true;
  if (!silent) renderList();
  if (!syncLock) setSync('pending', '● 확인 중…');
  const { labelIds, q } = query();
  const res = await Promise.allSettled(targets.map(async (a) => {
    if (append && !state.pages[a.email]) return null;
    const r = await gm.listThreads(a.email, { labelIds, q, pageToken: append ? state.pages[a.email] : undefined });
    return { email: a.email, ...r };
  }));
  if (seq !== state.loadSeq) return;
  state.loading = false;
  let err = 0;
  const keep = append ? [...state.items] : [];
  const pages = append ? { ...state.pages } : {};
  for (const [i, r] of res.entries()) {
    if (r.status === 'rejected') { err++; fail(r.reason, 'list'); if (silent && !append) keep.push(...state.items.filter((t) => t.account === targets[i].email)); continue; }
    if (!r.value) continue;
    const { email, threads, nextPageToken } = r.value;
    if (silent && !append) {
      const oldest = threads.length ? Math.min(...threads.map((t) => t.date)) : Infinity;
      const keys = new Set(threads.map((t) => t.key));
      const older = nextPageToken ? state.items.filter((t) => t.account === email && t.date < oldest && !keys.has(t.key)) : [];
      keep.push(...threads, ...older);
      pages[email] = older.length ? state.pages[email] ?? nextPageToken : nextPageToken;
    } else {
      const have = new Set(keep.map((t) => t.key));
      keep.push(...threads.filter((t) => !have.has(t.key)));
      pages[email] = nextPageToken;
    }
    for (const t of threads) learn(t.from, 0.2);
  }
  // 연결이 끊긴 계정의 저장본은 그대로 보여 줌
  if (!append) for (const a of accs()) if (!targets.some((x) => x.email === a.email) && (f.scope === 'all' || f.scope === a.email)) keep.push(...state.items.filter((t) => t.account === a.email));
  // '안읽음'만 보기: 지금 읽고 있는 메일은 읽음 처리돼도 목록에서 빼지 않음
  if (state.unreadOnly && state.sel && !keep.some((t) => t.key === state.sel)) { const cur = state.items.find((t) => t.key === state.sel); if (cur) keep.push(cur); }
  const uniq = new Map(keep.map((t) => [t.key, t]));
  state.items = [...uniq.values()].sort((a, b) => b.date - a.date);
  state.pages = pages;
  for (const k of [...state.checked]) if (!uniq.has(k)) state.checked.delete(k);
  renderList();
  renderBanner();
  if (!q && !append) cache.putList(folderKey(f), state.items);
  queueVisible();
  if (syncLock) return;
  if (!navigator.onLine) setSync('offline', '● 오프라인 (저장본 표시 중)');
  else if (err) setSync('error', `● 일부 계정 오류 (${err})`);
  else setSync('ok', `● ${new Date().toTimeString().slice(0, 5)} 확인`);
}

async function refreshCounts() {
  const list = accs().filter((a) => auth.token(a.email));
  await Promise.allSettled(list.map(async (a) => {
    state.unread[a.email] = await gm.unreadCount(a.email, 'INBOX');
    if (!state.labels[a.email]) state.labels[a.email] = await gm.listLabels(a.email);
  }));
  pref.set('unread', state.unread);
  renderSide();
}

/* ───────── 미리 받기 (기기 저장) ───────── */
const bg = { queue: [], busy: 0, running: false, stop: false };
/** 지금 목록에 보이는 앞쪽 메일 본문을 먼저 받아 둠 */
function queueVisible() {
  const top = state.items.slice(0, 40).filter((t) => auth.token(t.account));
  bg.queue = [...top.map((t) => t.key), ...bg.queue.filter((k) => !top.some((t) => t.key === k))].slice(0, 200);
  pump();
}
function queueNear(key) {
  const i = state.items.findIndex((t) => t.key === key);
  if (i < 0) return;
  const near = [state.items[i + 1], state.items[i + 2], state.items[i - 1], state.items[i + 3]].filter(Boolean).map((t) => t.key);
  bg.queue = [...near, ...bg.queue.filter((k) => !near.includes(k))];
  pump();
}
async function pump() {
  while (bg.busy < 2 && bg.queue.length) {
    const key = bg.queue.shift();
    const [email, id] = key.split('|');
    if (!auth.token(email)) continue;
    bg.busy++;
    (async () => {
      try {
        if (!(await gm.hasFull(email, id))) { const raw = await gm.fetchFull(email, id); await gm.prefetchInline(email, raw); }
      } catch { /* 무시 */ } finally { bg.busy--; pump(); }
    })();
  }
}
async function runPrefetch() {
  if (bg.running || !state.prefetchN || DEMO && bg.ranOnce) return;
  bg.running = true; bg.ranOnce = true;
  try {
    for (const a of connected()) {
      await gm.prefetch(a.email, {
        limit: state.prefetchN,
        shouldStop: () => !auth.token(a.email),
        onProgress: (d, n) => {
          if (d < n) { syncLock = 'prefetch'; setSync('pending', `● 미리 받기 ${accLabel(a)} ${d}/${n}`); }
          else { syncLock = ''; setSync('ok', `● ${new Date().toTimeString().slice(0, 5)} 확인 · 저장 완료`); }
        },
      }).catch((e) => console.warn('prefetch', e));
    }
  } finally { bg.running = false; syncLock = ''; }
}

/* ───────── 3열: 읽기 ───────── */
const current = () => state.items.find((t) => t.key === state.sel) || null;
const checkedItems = () => state.items.filter((t) => state.checked.has(t.key));

function setReadButtons() {
  const t = current();
  const on = !!state.thread;
  $$('.read-head [data-act]').forEach((b) => (b.disabled = !on));
  const star = $('.read-head [data-act="star"]');
  star.classList.toggle('on', !!t?.starred);
  star.textContent = t?.starred ? '★' : '☆';
  const tr = $('.read-head [data-act="trash"]');
  tr.textContent = state.folder.label === 'TRASH' ? '♻' : '🗑';
  tr.title = state.folder.label === 'TRASH' ? '휴지통에서 복원' : '삭제 (Del) — 휴지통으로';
  $('.read-head [data-act="archive"]').hidden = state.folder.label !== 'INBOX';
  $('#btn-print').disabled = !on;
}

function renderMulti() {
  const n = state.checked.size;
  $('#reader').hidden = false;
  $('#empty-read').hidden = true;
  $$('.read-head [data-act]').forEach((b) => (b.disabled = true));
  const trash = state.folder.label === 'TRASH';
  $('#reader').innerHTML = `<div class="multi">
    <div class="multi-n">${n}</div><p>개의 대화를 선택했습니다</p>
    <div class="multi-acts">
      ${state.folder.label === 'INBOX' ? '<button class="btn-ghost" data-bulk="archive">🗄 보관</button>' : ''}
      <button class="btn-ghost" data-bulk="${trash ? 'untrash' : 'trash'}">${trash ? '♻ 복원' : '🗑 삭제'}</button>
      <button class="btn-ghost" data-bulk="read">읽음으로</button>
      <button class="btn-ghost" data-bulk="unread">읽지 않음으로</button>
      <button class="btn-ghost" data-bulk="star">★ 별표</button>
      <button class="btn-ghost" data-bulk="clear">선택 해제</button>
    </div>
    <p class="multi-tip">Ctrl+클릭: 하나씩 더하기·빼기 · Shift+클릭: 범위 선택 · Ctrl+A: 모두 · 오른쪽 클릭: 메뉴</p>
  </div>`;
}

function renderReader() {
  if (state.checked.size > 1) { renderMulti(); return; }
  const th = state.thread;
  setReadButtons();
  $('#reader').hidden = !th;
  $('#empty-read').hidden = !!th;
  if (!th) { $('#reader').innerHTML = ''; return; }
  const a = acc(th.account);
  const inTrash = state.folder.label === 'TRASH';
  // 대화 중 하나만 지운 메일은 휴지통에서만 보임
  const msgs = th.messages.filter((m) => inTrash ? m.labelIds.includes('TRASH') : !m.labelIds.includes('TRASH'));
  const subject = (msgs[0] || th.messages[0])?.subject || '(제목 없음)';
  let h = `<h2 class="r-subject">${esc(subject)}<span class="acc-tag" style="--acc:${a.color}">${esc(a.email)}</span></h2>`;
  const lastReal = msgs.map((m) => !m.labelIds.includes('DRAFT')).lastIndexOf(true);
  msgs.forEach((m, i) => {
    if (m.labelIds.includes('DRAFT')) {
      h += `<article class="msg draft-msg" data-mid="${esc(m.id)}"><div class="draft-bar"><span class="draft-tag">임시 저장</span><span class="draft-snip">${esc(m.snippet || '(내용 없음)')}</span><button class="btn-primary btn-sm" data-draft="edit">이어 쓰기</button><button class="btn-ghost btn-sm" data-draft="del">지우기</button></div></article>`;
      return;
    }
    const last = i === lastReal || lastReal < 0;
    const open = last || m.labelIds.includes('UNREAD') || th.open?.has(m.id);
    const fa = parseAddrList(m.from)[0] || { name: '', email: '' };
    const mine = isMine(m.from);
    const toLine = [m.to && `받는 사람: ${m.to}`, m.cc && `참조: ${m.cc}`].filter(Boolean).join('  ·  ');
    const files = m.attachments.filter((x) => !x.inline || !(m.html || '').includes(`cid:${x.contentId}`));
    h += `<article class="msg${open ? '' : ' collapsed'}" data-mid="${esc(m.id)}">
      <div class="m-head" data-toggle>
        <div class="avatar" style="background:${mine ? a.color : colorOf(fa.email)}">${esc(initial(m.from))}</div>
        <div class="m-who">
          <div class="m-from">${esc(fa.name || fa.email)}${fa.name ? `<small>&lt;${esc(fa.email)}&gt;</small>` : ''}</div>
          <div class="m-to" title="${esc(toLine)}">${esc(toLine)}</div>
          <div class="m-snip">${files.length ? '📎 ' : ''}${esc(m.snippet)}</div>
        </div>
        <div class="m-date">${longDate(m.date)}</div>
        <div class="m-quick"><button class="mq-txt" data-mact="reply" title="이 메일에 답장">답장</button><button data-mact="${inTrash ? 'untrash1' : 'trash1'}" title="${inTrash ? '이 메일만 복원' : '이 메일만 삭제 (대화의 다른 메일은 그대로)'}">${inTrash ? '♻' : '🗑'}</button><button data-mact="more" title="더 보기">⋯</button></div>
      </div>
      <div class="m-body">
        ${files.length ? `<div class="atts atts-top">${files.map((x) => attChip(m, x)).join('')}${files.length > 1 ? `<button class="btn-ghost btn-sm att-all" data-attall title="모든 첨부를 고른 폴더에 저장">⬇ 모두 받기 (${files.length})</button>` : ''}</div>` : ''}
        <div class="m-imgnote"></div>
        <iframe class="m-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" title="메일 본문"></iframe>
      </div>
    </article>`;
  });
  const split = (k, label) => `<span class="split"><button class="btn-ghost" data-act="${k}">${label}</button><button class="btn-ghost sp-pop" data-popact="${k}" title="${label} — 새 창에서 쓰기 (메일을 보면서 작성)">${WIN_ICON}</button></span>`;
  h += `<div class="r-reply">${split('reply', '답장')}${split('replyAll', '전체 답장')}${split('forward', '전달')}</div>`;
  $('#reader').innerHTML = h;
  $$('#reader .msg:not(.draft-msg)').forEach((el) => { if (!el.classList.contains('collapsed')) fillBody(el); });
}

function attChip(m, x) {
  const idx = m.attachments.indexOf(x);
  return `<button class="att" data-att="${idx}" title="${esc(x.filename)} — 누르면 바로 열기·다운로드 선택, 두 번 누르면 바로 열기"><span class="a-ic">${fileIcon(x.mimeType, x.filename)}</span><span class="a-nm">${esc(x.filename)}</span><span class="a-sz">${sizeText(x.size)}</span><span class="a-dd">▾</span></button>`;
}

// 서식 없는 메일은 쓰기 화면과 같은 글꼴(맑은 고딕 14.5px)로 표시
const MAIL_FONT = "'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo',sans-serif";
const FRAME_CSS = `body{margin:0;padding:8px 12px 10px;font-family:${MAIL_FONT};font-size:14.5px;line-height:1.6;color:#16202b;word-break:break-word;overflow-wrap:anywhere;overflow-x:auto}
img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}
blockquote{margin:0 0 0 .8ex;border-left:2px solid #c9d1db;padding-left:1ex;color:#4a5560}
a{color:#1a56c4}.ybm-quote-toggle{display:inline-block;margin:6px 0;padding:0 8px;border:1px solid #ccd3dc;border-radius:8px;background:#eef1f5;color:#5a6774;font-size:13px;cursor:pointer;line-height:18px}`;

/** 메일 본문 HTML 정리: 스크립트·외부 실행 요소 제거, 외부 그림 처리 */
function cleanHtml(m, showImages, { foldQuote = true } = {}) {
  const src = m.html || `<div style="white-space:normal">${textToHtml(m.text || '')}</div>`;
  const d = new DOMParser().parseFromString(src, 'text/html');
  d.querySelectorAll('script,iframe,object,embed,frame,frameset,meta[http-equiv],link:not([rel~="stylesheet"]),base').forEach((n) => n.remove());
  d.querySelectorAll('*').forEach((n) => { for (const at of [...n.attributes]) if (/^on/i.test(at.name) || /^\s*javascript:/i.test(at.value)) n.removeAttribute(at.name); });
  let blocked = 0;
  if (!showImages) {
    d.querySelectorAll('img[src^="http"], img[srcset]').forEach((img) => { img.dataset.src = img.getAttribute('src') || ''; img.removeAttribute('src'); img.removeAttribute('srcset'); blocked++; });
  }
  const q = foldQuote && m.html ? d.querySelector('.gmail_quote, #divRplyFwdMsg, #appendonsend, blockquote[type="cite"]') : null;
  if (q && q.parentNode) {
    const wrap = d.createElement('details');
    const sum = d.createElement('summary');
    sum.className = 'ybm-quote-toggle';
    sum.textContent = '⋯ 이전 내용';
    wrap.append(sum);
    q.parentNode.insertBefore(wrap, q);
    while (wrap.nextSibling) wrap.append(wrap.nextSibling);
    // 예전 방식(원문 뒤 서명)으로 보낸 메일도 서명은 접지 않고 보이게
    const sig = wrap.querySelector('.ybm-signature');
    if (sig) { wrap.after(sig); const br = d.createElement('br'); sig.before(br); }
  }
  const styles = [...d.querySelectorAll('style, link[rel~="stylesheet"]')].map((s) => s.outerHTML).join('');
  const bodyStyle = d.body.getAttribute('style') || '';
  const bg = d.body.getAttribute('bgcolor');
  return { html: `${styles}<div style="${esc(bodyStyle)}${bg ? `;background:${esc(bg)}` : ''}">${d.body.innerHTML}</div>`, blocked };
}

async function inlineCid(m, html) {
  const cids = m.attachments.filter((x) => x.contentId && html.includes(`cid:${x.contentId}`));
  for (const x of cids) {
    try {
      const data = x.data || await gm.getAttachment(m.account, m.id, x.attachmentId, { name: x.filename, size: x.size });
      x.data = data;
      const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
      html = html.split(`cid:${x.contentId}`).join(`data:${x.mimeType};base64,${b64}`);
    } catch (e) { console.warn('cid', e); }
  }
  return html;
}

async function fillBody(el, showImages = state.showImages) {
  const m = state.thread?.messages.find((x) => x.id === el.dataset.mid);
  if (!m) return;
  const frame = $('.m-frame', el);
  let { html, blocked } = cleanHtml(m, showImages);
  const note = $('.m-imgnote', el);
  note.innerHTML = blocked ? `<p class="img-note">🖼 외부 그림 ${blocked}개를 숨겼습니다.<button data-showimg>표시</button></p>` : '';
  html = await inlineCid(m, html);
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><meta name="referrer" content="no-referrer"><style>${FRAME_CSS}</style></head><body>${html}</body></html>`;
  frame.onload = () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    // 본문 실제 높이(배율 반영)에 맞춤 — scrollHeight는 틀 높이 이상으로만 커져 줄어들지 않으므로 사용하지 않음
    const fit = () => { frame.style.height = Math.max(60, Math.ceil(doc.body.getBoundingClientRect().height) + 12) + 'px'; };
    frame._fit = fit;
    doc.documentElement.style.zoom = state.zoom / 100;
    fit();
    doc.addEventListener('wheel', onZoomWheel, { passive: false });
    try { new ResizeObserver(fit).observe(doc.body); } catch { /* 무시 */ }
    doc.querySelectorAll('img').forEach((im) => im.addEventListener('load', fit));
    doc.querySelectorAll('details').forEach((dt) => dt.addEventListener('toggle', fit));
    doc.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[href]');
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (/^mailto:/i.test(href)) {
        e.preventDefault();
        const u = new URL(href);
        openCompose({ mode: 'new', account: m.account, to: decodeURIComponent(u.pathname), subject: u.searchParams.get('subject') || '', body: u.searchParams.get('body') || '' });
      } else if (href.startsWith('#')) { /* 문서 안 이동 */ } else if (!/^https?:/i.test(href)) e.preventDefault();
    });
    doc.addEventListener('keydown', onKey);
  };
}

async function openThread(key, { scroll = false } = {}) {
  const t = state.items.find((x) => x.key === key);
  if (!t) return;
  state.sel = key;
  if (!state.checked.has(key) || state.checked.size > 1) { state.checked = new Set([key]); }
  state.anchor = key;
  $$('#list .item').forEach((li) => { li.classList.toggle('active', li.dataset.key === key); li.classList.toggle('sel', state.checked.has(li.dataset.key)); });
  if (scroll) $('#list .item.active')?.scrollIntoView({ block: 'nearest' });
  if (!cp.open || cp.float) $('#app').dataset.view = 'read';
  else if (!CPWIN) { setSplit(true); $('#cp-side').hidden = false; }
  const cachedFirst = await gm.hasFull(t.account, t.id);
  if (!cachedFirst) {
    state.thread = null;
    setReadButtons();
    $('#reader').hidden = false;
    $('#empty-read').hidden = true;
    $('#reader').innerHTML = '<div class="empty">불러오는 중…</div>';
  }
  try {
    const th = await gm.getThread(t.account, t.id);
    if (state.sel !== key) return;
    state.thread = th;
    th.messages.forEach((m) => { learn(m.from, 1); if (isMine(m.from)) { learn(m.to, 2); learn(m.cc, 1); } });
    renderReader();
    $('#read-wrap').scrollTop = 0;
    if (t.unread) actOn('read', [t], { quiet: true, keep: true }); // '안읽음'만 보기에서도 지금 읽는 메일은 목록에 남김
    queueNear(key);
  } catch (e) {
    fail(e, 'thread');
    if (state.sel === key) $('#reader').innerHTML = `<div class="empty">메일을 불러오지 못했습니다.<br>${esc(e.message || '')}</div>`;
  }
}

/* ───────── 보관·삭제·읽음·별표 (하나·여러 개 공통) ───────── */
const LABEL_OPS = {
  read: [[], ['UNREAD']], unread: [['UNREAD'], []],
  star: [['STARRED'], []], unstar: [[], ['STARRED']],
  archive: [[], ['INBOX']], spam: [['SPAM'], ['INBOX']], notspam: [['INBOX'], ['SPAM']],
};
const REVERSE = { archive: 'unarchive', trash: 'untrash', untrash: 'trash', spam: 'notspam', notspam: 'spam', read: 'unread', unread: 'read', star: 'unstar', unstar: 'star' };
LABEL_OPS.unarchive = [['INBOX'], []];

function leavesFolder(kind, t) {
  const L = state.folder.label;
  if (kind === 'trash') return L !== 'TRASH';
  if (kind === 'untrash') return L === 'TRASH';
  if (kind === 'archive') return L === 'INBOX';
  if (kind === 'spam') return L !== 'SPAM';
  if (kind === 'notspam') return L === 'SPAM';
  if (kind === 'unstar') return L === 'STARRED';
  if (kind === 'unread' || kind === 'read') return state.unreadOnly && kind === 'read';
  if (kind.startsWith('label:')) return false;
  return false;
}

async function actOn(kind, items, { quiet = false, undo = true, keep = false } = {}) {
  items = items.filter(Boolean);
  if (!items.length) return;
  if (kind === 'trash' && state.folder.label === 'DRAFT') { deleteDraftItems(items); return; }
  const snapshot = items.map((t) => ({ t, idx: state.items.indexOf(t), unread: t.unread, starred: t.starred, labels: [...t.labelIds] }));
  // 화면 먼저 바꾸기
  for (const t of items) {
    if (kind === 'read' || kind === 'unread') {
      if (t.unread !== (kind === 'unread') && t.labelIds.includes('INBOX')) state.unread[t.account] = Math.max(0, (state.unread[t.account] || 0) + (kind === 'unread' ? 1 : -1));
      t.unread = kind === 'unread';
    }
    if (kind === 'star' || kind === 'unstar') t.starred = kind === 'star';
    if ((kind === 'archive' || kind === 'trash' || kind === 'spam') && t.unread && t.labelIds.includes('INBOX')) state.unread[t.account] = Math.max(0, (state.unread[t.account] || 1) - 1);
    if (kind === 'archive') t.labelIds = t.labelIds.filter((l) => l !== 'INBOX');
    if (kind.startsWith('label:') && !t.labelIds.includes(kind.slice(6))) t.labelIds.push(kind.slice(6));
  }
  const leaving = keep ? [] : items.filter((t) => leavesFolder(kind, t));
  if (leaving.length) dropItems(leaving);
  else { renderList(); if (state.sel && items.some((t) => t.key === state.sel)) setReadButtons(); }
  renderSide();
  // 서버 반영 (계정별)
  const byAcc = new Map();
  for (const t of items) { if (!byAcc.has(t.account)) byAcc.set(t.account, []); byAcc.get(t.account).push(t.id); }
  try {
    for (const [email, ids] of byAcc) {
      if (kind === 'trash') await gm.trashMany(email, ids);
      else if (kind === 'untrash') await gm.untrashMany(email, ids);
      else if (kind.startsWith('label:')) await gm.modifyMany(email, ids, [kind.slice(6)], []);
      else { const [add, rem] = LABEL_OPS[kind]; await gm.modifyMany(email, ids, add, rem); }
    }
    if (quiet) return;
    const n = items.length > 1 ? `${items.length}개 대화를 ` : '';
    const msg = { archive: `${n}보관했습니다.`, trash: `${n}휴지통으로 옮겼습니다.`, untrash: `${n}복원했습니다.`, spam: `${n}스팸으로 신고했습니다.`, notspam: `${n}받은편지함으로 옮겼습니다.` }[kind]
      || (kind.startsWith('label:') ? `${n}라벨을 붙였습니다.` : null);
    if (msg) toast(msg, 6000, undo && REVERSE[kind] ? { label: '되돌리기', run: () => undoAct(kind, snapshot) } : null);
  } catch (e) {
    fail(e, kind);
    restoreItems(snapshot);
  }
}
async function undoAct(kind, snapshot) {
  restoreItems(snapshot);
  const byAcc = new Map();
  for (const { t } of snapshot) { if (!byAcc.has(t.account)) byAcc.set(t.account, []); byAcc.get(t.account).push(t.id); }
  try {
    for (const [email, ids] of byAcc) {
      const r = REVERSE[kind];
      if (r === 'untrash') await gm.untrashMany(email, ids);
      else if (r === 'trash') await gm.trashMany(email, ids);
      else { const [add, rem] = LABEL_OPS[r]; await gm.modifyMany(email, ids, add, rem); }
    }
    toast('되돌렸습니다.');
    refreshCounts();
  } catch (e) { fail(e, 'undo'); }
}
function restoreItems(snapshot) {
  for (const s of snapshot.sort((a, b) => a.idx - b.idx)) {
    Object.assign(s.t, { unread: s.unread, starred: s.starred, labelIds: s.labels });
    if (!state.items.includes(s.t)) state.items.splice(Math.max(0, Math.min(s.idx, state.items.length)), 0, s.t);
  }
  renderList();
}
function dropItems(list) {
  const keys = new Set(list.map((t) => t.key));
  const firstIdx = state.items.findIndex((t) => keys.has(t.key));
  state.items = state.items.filter((t) => !keys.has(t.key));
  for (const k of keys) state.checked.delete(k);
  if (state.sel && keys.has(state.sel)) {
    const next = state.items[firstIdx] || state.items[firstIdx - 1];
    state.sel = null; state.thread = null;
    if (next && innerWidth > 860 && list.length === 1) { renderList(); openThread(next.key); return; }
    if (innerWidth <= 860) $('#app').dataset.view = 'list';
  }
  renderList();
  renderReader();
}
function closeReader() {
  state.sel = null;
  state.thread = null;
  state.checked.clear();
  $('#app').dataset.view = 'list';
  renderReader();
  renderList();
}
const targets = () => (state.checked.size ? checkedItems() : [current()].filter(Boolean));

/* ───────── 본문 확대·축소 ───────── */
function setZoom(z) {
  state.zoom = Math.max(60, Math.min(200, Math.round(z / 10) * 10));
  pref.set('zoom', state.zoom);
  $('#zoom-range').value = state.zoom;
  $('#zoom-val').textContent = `${state.zoom}%`;
  $$('#reader .m-frame').forEach((f) => { const d = f.contentDocument; if (d) { d.documentElement.style.zoom = state.zoom / 100; f._fit?.(); setTimeout(() => f._fit?.(), 60); } });
}
function onZoomWheel(e) {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(state.zoom + (e.deltaY < 0 ? 10 : -10));
}

/* ───────── 인쇄 (A4 세로) ───────── */
async function printThread() {
  const th = state.thread;
  if (!th) return;
  const inTrash = state.folder.label === 'TRASH';
  const msgs = th.messages.filter((m) => !m.labelIds.includes('DRAFT') && (inTrash ? m.labelIds.includes('TRASH') : !m.labelIds.includes('TRASH')));
  toast('인쇄 준비 중…', 0);
  let body = '';
  for (const m of msgs) {
    const files = m.attachments.filter((x) => !x.inline || !(m.html || '').includes(`cid:${x.contentId}`));
    let html = cleanHtml(m, true, { foldQuote: false }).html;
    html = await inlineCid(m, html);
    body += `<section class="pm"><table class="ph">
      <tr><th>보낸 사람</th><td>${esc(m.from)}</td></tr>
      <tr><th>받는 사람</th><td>${esc(m.to)}</td></tr>
      ${m.cc ? `<tr><th>참조</th><td>${esc(m.cc)}</td></tr>` : ''}
      <tr><th>날짜</th><td>${longDate(m.date)}</td></tr>
      ${files.length ? `<tr><th>첨부</th><td>${files.map((x) => `${esc(x.filename)} (${sizeText(x.size)})`).join(', ')}</td></tr>` : ''}
    </table><div class="pb">${html}</div></section>`;
  }
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(msgs[0]?.subject || '메일')}</title><style>
    @page { size: A4 portrait; margin: 15mm 14mm; }
    body { margin: 0; font-family: ${MAIL_FONT}; font-size: 10.5pt; line-height: 1.6; color: #000; word-break: keep-all; overflow-wrap: anywhere; }
    h1 { font-size: 15pt; margin: 0 0 4mm; padding-bottom: 2mm; border-bottom: 1.2pt solid #243e6b; }
    .pm { margin-bottom: 6mm; }
    .pm + .pm { page-break-before: auto; border-top: 0.6pt dashed #999; padding-top: 4mm; }
    .ph { width: 100%; border-collapse: collapse; margin-bottom: 3mm; font-size: 9.5pt; }
    .ph th { width: 22mm; text-align: left; vertical-align: top; color: #444; font-weight: 700; padding: 0.6mm 2mm 0.6mm 0; white-space: nowrap; }
    .ph td { padding: 0.6mm 0; }
    .pb img { max-width: 100%; height: auto; }
    .pb table { max-width: 100%; }
    .pb blockquote { margin: 0 0 0 2mm; padding-left: 3mm; border-left: 1pt solid #bbb; color: #333; }
    .foot { margin-top: 4mm; font-size: 8pt; color: #777; text-align: right; }
  </style></head><body><h1>${esc(msgs[0]?.subject || '(제목 없음)')}</h1>${body}<p class="foot">${esc(th.account)} · YB-Mail에서 인쇄 ${longDate(Date.now())}</p></body></html>`;
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.append(f);
  f.srcdoc = doc;
  await new Promise((r) => (f.onload = r));
  await Promise.all([...f.contentDocument.images].map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; }))));
  $('#toast').hidden = true;
  f.contentWindow.focus();
  f.contentWindow.print();
  setTimeout(() => f.remove(), 60_000);
}

/* ───────── 밝게/어둡게 ───────── */
function syncThemeIcon() {
  const b = $('#btn-theme');
  const dark = isDark();
  b.textContent = dark ? '☀️' : '🌙';
  b.title = dark ? '밝게 보기로 전환' : '어둡게 보기로 전환';
}

/** 대화 중 메일 하나만 휴지통으로 (나머지는 그대로) */
async function trashOne(m, restore = false) {
  const t = current();
  const th = state.thread;
  if (!th) return;
  const visible = th.messages.filter((x) => (state.folder.label === 'TRASH' ? x.labelIds.includes('TRASH') : !x.labelIds.includes('TRASH')));
  if (visible.length <= 1) { actOn(restore ? 'untrash' : 'trash', [t]); return; } // 마지막 하나면 대화 전체 처리
  try {
    await (restore ? gm.untrashMessage(m.account, m.id) : gm.trashMessage(m.account, m.id));
    m.labelIds = restore ? m.labelIds.filter((l) => l !== 'TRASH') : [...m.labelIds.filter((l) => l !== 'INBOX'), 'TRASH'];
    renderReader();
    toast(restore ? '이 메일을 복원했습니다.' : '이 메일만 휴지통으로 옮겼습니다.', 6000, restore ? null : { label: '되돌리기', run: async () => { await gm.untrashMessage(m.account, m.id); m.labelIds = m.labelIds.filter((l) => l !== 'TRASH'); renderReader(); } });
    // 목록 정보(개수·미리보기) 새로
    const raw = await gm.fetchFull(m.account, th.id, { force: true });
    const fresh = gm.parseThread(m.account, raw);
    if (state.thread?.id === th.id) { state.thread.messages.forEach((x) => { const f = fresh.messages.find((y) => y.id === x.id); if (f) x.labelIds = f.labelIds; }); }
    loadList({ silent: true });
  } catch (e) { fail(e, 'trash1'); }
}

/* ───────── 첨부파일: 바로 열기 · 다운로드(위치 지정) ───────── */
async function attBlob(m, x) {
  const data = x.data || await gm.getAttachment(m.account, m.id, x.attachmentId, { name: x.filename, size: x.size });
  return new Blob([b64ToBytes(data)], { type: x.mimeType || 'application/octet-stream' });
}
const viewable = (x) => /^image\/|pdf|^text\/plain/.test(x.mimeType) || /\.pdf$/i.test(x.filename);
function saveToDownloads(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
const attBytes = async (m, x) => new Uint8Array(await (await attBlob(m, x)).arrayBuffer());
/** 바로 열기: 다운로드 폴더에 저장 + (PDF·그림은) 새 탭에서 열기 — 프로그램에서는 저장 후 연결된 프로그램으로 바로 실행 */
async function attOpen(m, x) {
  if (DESK) {
    try {
      toast(`'${x.filename}' 받는 중…`, 0);
      const r = await DESK.saveOpen(x.filename, await attBytes(m, x));
      toast(r.error ? `다운로드 폴더에 저장했지만 열지 못했습니다: ${r.error}` : `다운로드 폴더에 저장하고 열었습니다.`, 5000, { label: '폴더 보기', run: () => DESK.showFile(r.path) });
    } catch (e) { fail(e, 'att'); }
    return;
  }
  const win = viewable(x) ? window.open('', '_blank') : null;
  try {
    toast(`'${x.filename}' 받는 중…`, 0);
    const blob = await attBlob(m, x);
    saveToDownloads(blob, x.filename);
    if (win) { const u = URL.createObjectURL(blob); win.location.href = u; setTimeout(() => URL.revokeObjectURL(u), 120_000); }
    toast(viewable(x) ? `다운로드 폴더에 저장하고 새 탭에서 열었습니다.` : `다운로드 폴더에 저장했습니다. 브라우저 아래(또는 위)의 다운로드 표시를 눌러 여세요.`, 5000);
  } catch (e) { win?.close(); fail(e, 'att'); }
}
/** 다운로드: 저장할 위치·이름 고르기 */
async function attSaveAs(m, x) {
  if (DESK) {
    try {
      const bytes = await attBytes(m, x);
      const p = await DESK.saveAs(x.filename, bytes);
      if (p) toast(`저장했습니다: ${p}`, 5000, { label: '폴더 보기', run: () => DESK.showFile(p) });
    } catch (e) { fail(e, 'saveAs'); }
    return;
  }
  if (!window.showSaveFilePicker) { toast('이 브라우저는 저장 위치 선택을 지원하지 않아 다운로드 폴더에 저장합니다.'); attBlob(m, x).then((b) => saveToDownloads(b, x.filename)).catch((e) => fail(e, 'att')); return; }
  let handle;
  try { handle = await window.showSaveFilePicker({ suggestedName: x.filename, id: 'ybm-att', startIn: 'downloads' }); }
  catch (e) { if (e.name !== 'AbortError') fail(e, 'saveAs'); return; }
  try {
    toast(`'${x.filename}' 저장 중…`, 0);
    const blob = await attBlob(m, x);
    const w = await handle.createWritable();
    await w.write(blob); await w.close();
    toast(`저장했습니다: ${handle.name}`);
  } catch (e) { fail(e, 'saveAs'); }
}
/** 모두 받기: 폴더 고르기 → 첨부 전부 저장 */
async function attSaveAll(m) {
  const files = m.attachments.filter((x) => !x.inline || !(m.html || '').includes(`cid:${x.contentId}`));
  if (DESK) {
    const dir = await DESK.pickDir(); if (!dir) return;
    try {
      let i = 0, last = '';
      for (const x of files) { toast(`저장 중… ${++i}/${files.length}`, 0); last = await DESK.write(dir, x.filename, await attBytes(m, x)); }
      toast(`${files.length}개 파일을 저장했습니다.`, 5000, { label: '폴더 보기', run: () => DESK.showFile(last) });
    } catch (e) { fail(e, 'saveAll'); }
    return;
  }
  if (!window.showDirectoryPicker) {
    for (const x of files) { const b = await attBlob(m, x); saveToDownloads(b, x.filename); }
    toast(`${files.length}개 파일을 다운로드 폴더에 저장했습니다.`);
    return;
  }
  let dir;
  try { dir = await window.showDirectoryPicker({ id: 'ybm-att', mode: 'readwrite', startIn: 'downloads' }); }
  catch (e) { if (e.name !== 'AbortError') fail(e, 'dir'); return; }
  try {
    let i = 0;
    for (const x of files) {
      toast(`저장 중… ${++i}/${files.length}`, 0);
      const fh = await dir.getFileHandle(x.filename.replace(/[\\/:*?"<>|]/g, '_'), { create: true });
      const w = await fh.createWritable();
      await w.write(await attBlob(m, x)); await w.close();
    }
    toast(`${files.length}개 파일을 '${dir.name}' 폴더에 저장했습니다.`);
  } catch (e) { fail(e, 'saveAll'); }
}
function attMenu(at, m, x) {
  const files = m.attachments.filter((y) => !y.inline || !(m.html || '').includes(`cid:${y.contentId}`));
  showPop(at, `<div class="pop-h">${esc(x.filename)} · ${sizeText(x.size)}</div>
    ${mi('open', '바로 열기', { icon: '▶', hint: '다운로드 폴더' })}
    ${mi('save', '다운로드…', { icon: '⬇', hint: '위치 지정' })}
    ${files.length > 1 ? '<hr>' + mi('all', `첨부 모두 받기 (${files.length}개)…`, { icon: '🗂' }) : ''}`, (k) => {
    if (k === 'open') attOpen(m, x);
    if (k === 'save') attSaveAs(m, x);
    if (k === 'all') attSaveAll(m);
  });
}

/* ───────── 메일 쓰기 (읽기 영역 전체 사용) ───────── */
const cp = { open: false, float: pref.get('cpFloat', false), mode: 'new', account: null, threadId: null, inReplyTo: '', references: '', quoteHtml: '', quoteText: '', files: [], origAtts: [], dirty: false, prevView: 'list' };
let edMain = null, edSig = null;

function fromOptions(sel) {
  return accs().map((a) => `<option value="${esc(a.email)}"${a.email === sel ? ' selected' : ''}>${esc(a.name ? `${a.name} <${a.email}>` : a.email)}${auth.token(a.email) ? '' : ' (연결 필요)'}</option>`).join('');
}
const prefix = (p, s) => (new RegExp(`^\\s*(${p}|${p === 'Re' ? '회신|답장|RE' : '전달|FW|Fw'})\\s*:`, 'i').test(s) ? s : `${p}: ${s}`);
const withoutMe = (list, me) => parseAddrList(list).filter((x) => x.email.toLowerCase() !== me && !accs().some((a) => a.email === x.email.toLowerCase()));
const joinAddr = (arr) => arr.map((x) => (x.name ? `${x.name} <${x.email}>` : x.email)).join(', ');

async function quoteParts(m, fwd) {
  let body = m.html ? cleanHtml(m, true, { foldQuote: false }).html : textToHtml(m.text || '');
  body = await inlineCid(m, body);
  const text = m.text || htmlToText(m.html || '');
  if (fwd) {
    const head = `---------- 전달된 메일 ----------\n보낸 사람: ${m.from}\n날짜: ${longDate(m.date)}\n제목: ${m.subject}\n받는 사람: ${m.to}${m.cc ? `\n참조: ${m.cc}` : ''}\n`;
    return { html: `<div class="gmail_quote"><div>${textToHtml(head)}</div><br>${body}</div>`, text: `${head}\n${text}` };
  }
  const line = `${longDate(m.date)}, ${m.from} 님이 작성:`;
  return {
    html: `<div class="gmail_quote"><div>${esc(line)}</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${body}</blockquote></div>`,
    text: `${line}\n${text.split(/\r?\n/).map((l) => '> ' + l).join('\n')}`,
  };
}

function setCpFloat(f) {
  cp.float = f;
  pref.set('cpFloat', f);
  const c = $('#compose');
  c.classList.toggle('float', f);
  c.classList.remove('min');
  // 떠 있는 창은 화면 전체 기준, 꽉 찬 창은 읽기 영역 안
  if (f || CPWIN) document.body.append(c); else $('.pane-read').append(c);
  $('#cp-float').textContent = f ? '크게' : '작은 창';
  $('#cp-float').title = f ? '읽기 영역 전체로 크게' : '작은 창으로 띄우기';
  if (f) setSplit(false);
  $('#cp-min').hidden = !f;
}

async function openCompose({ mode = 'new', msg = null, account, to = '', subject = '', body = '', snapshot = null } = {}) {
  if (cp.open && cp.dirty) {
    $('#compose').classList.remove('min');
    const r = await askUnsaved();
    if (r === 'cancel') return;
    if (r === 'save' && !(await saveDraft({ quiet: true }))) return;
  }
  const th = state.thread;
  const m = msg || (th && mode !== 'new' ? th.messages[th.messages.length - 1] : null);
  const scopeAcc = state.folder.scope !== 'all' ? state.folder.scope : null;
  const from = snapshot?.from || account || m?.account || th?.account || scopeAcc || connected()[0]?.email || accs()[0]?.email;
  if (!from) { toast('먼저 계정을 추가하세요.'); return; }
  Object.assign(cp, { open: true, mode, account: from, threadId: null, inReplyTo: '', references: '', quoteHtml: '', quoteText: '', quoteOrig: null, quoteMode: 'on', files: [], origAtts: [], dirty: false, draftId: null, draftAccount: null });
  let cc = '';
  if (m && mode !== 'new' && !snapshot) {
    const me = from;
    const mine = isMine(m.from);
    if (mode === 'reply') to = mine ? m.to : (m.replyTo || m.from);
    if (mode === 'replyAll') {
      const first = mine ? parseAddrList(m.to) : parseAddrList(m.replyTo || m.from);
      const rest = mine ? [] : withoutMe(m.to, me);
      const seen = new Set();
      const tos = [...first, ...rest].filter((x) => !seen.has(x.email.toLowerCase()) && seen.add(x.email.toLowerCase()));
      to = joinAddr(tos);
      cc = joinAddr(withoutMe(m.cc, me).filter((x) => !seen.has(x.email.toLowerCase())));
    }
    subject = mode === 'forward' ? prefix('Fwd', m.subject || '') : prefix('Re', m.subject || '');
    if (mode !== 'forward') {
      cp.threadId = m.threadId;
      cp.inReplyTo = m.messageId;
      cp.references = [m.references, m.messageId].filter(Boolean).join(' ');
    } else {
      cp.origAtts = m.attachments.filter((x) => !x.inline).map((x) => ({ ...x, msgId: m.id, account: m.account, keep: true }));
    }
  }
  if (snapshot) Object.assign(cp, { account: snapshot.account || from, mode: snapshot.mode, threadId: snapshot.threadId, inReplyTo: snapshot.inReplyTo, references: snapshot.references, quoteHtml: snapshot.quoteHtml, quoteText: snapshot.quoteText, files: snapshot.files, origAtts: snapshot.origAtts, draftId: snapshot.draftId || null, draftAccount: snapshot.draftAccount || null });
  setCpFloat(cp.float);
  $('#cp-title').textContent = (cp.draftId ? '임시 저장 메일 · ' : '') + ({ new: '새 메일', reply: '답장', replyAll: '전체 답장', forward: '전달' }[cp.mode] || '새 메일');
  $('#cp-side').hidden = !state.thread || CPWIN || cp.float;
  $('#cp-from').innerHTML = fromOptions(from);
  $('#cp-to').value = snapshot?.to ?? to;
  $('#cp-cc').value = snapshot?.cc ?? cc;
  $('#cp-bcc').value = snapshot?.bcc ?? '';
  $$('#compose [data-cc]').forEach((r) => (r.hidden = !$('#cp-cc').value && !$('#cp-bcc').value));
  $('#cp-subject').value = snapshot?.subject ?? subject;
  $('#cp-editor').innerHTML = snapshot?.html ?? `<div>${body ? textToHtml(body) : '<br>'}</div><div><br></div>`;
  $('#cp-sig').innerHTML = snapshot?.sig ?? sigHtml(acc(from));
  syncSigBox();
  $('#cp-quote').hidden = true;
  $('#cp-msg').textContent = ''; $('#cp-msg').className = 'cp-msg';
  renderCpAtts();
  cp.prevView = $('#app').dataset.view;
  if (!cp.float) $('#app').dataset.view = 'read';
  $('#compose').hidden = false;
  $('#compose').classList.remove('min');
  const focusEl = $('#cp-to').value ? $('#cp-editor') : $('#cp-to');
  focusEl.focus();
  if (focusEl === $('#cp-editor')) { const r = document.createRange(); r.setStart($('#cp-editor'), 0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); }
  if (snapshot) cp.dirty = true;
  // 원문 인용 (본문 속 그림 포함) — 늦게 채워짐
  cp.quotePending = null;
  if (cp.quoteHtml) showQuote();
  else if (m && mode !== 'new' && !snapshot) {
    cp.quotePending = (async () => {
      const q = await quoteParts(m, mode === 'forward');
      if (!cp.open) return;
      cp.quoteHtml = q.html; cp.quoteText = q.text;
      showQuote();
    })();
    await cp.quotePending;
  }
}

/* ───────── 서식 도구함 ───────── */
function bindToolbar(box, getEd) {
  box.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // 편집기 선택 유지
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const ed = getEd();
    if (b.dataset.pal) {
      showPop(b, paletteHtml(b.dataset.pal), (k) => {
        const [cmd, val] = k.split('|');
        format(ed, cmd, val);
        b.querySelector('.fmt-bar').style.background = val || 'transparent';
      });
      return;
    }
    if (b.dataset.fmt) format(ed, b.dataset.fmt);
  });
  box.addEventListener('change', (e) => { const sel = e.target.closest('select[data-fmt]'); if (sel) format(getEd(), sel.dataset.fmt, sel.value); });
}
const cpEditor = () => { const a = activeEditor(); return a && (a.el.id === 'cp-editor' || a.el.id === 'cp-sig') ? a : edMain; };

/* ───────── 쓰면서 메일 보기: 왼쪽 메일 · 오른쪽 쓰기 ───────── */
function setSplit(on) {
  on = on && cp.open && !cp.float && !CPWIN && innerWidth > 860;
  $('.pane-read').classList.toggle('split', on);
  $('#cp-side').textContent = on ? '쓰기만 크게' : '메일과 나란히';
  if (on) $('#app').dataset.view = 'read';
}

/* ───────── 별도 창에서 쓰기 (메일을 보면서 작성) ───────── */
const drafts = new Map();
window.__ybmTakeDraft = (id) => { const d = drafts.get(id); drafts.delete(id); return d; };
window.__ybmQueueSend = (job) => queueSend(job);
/** 지금 쓰는 메일을 새 창으로 떼어 냄 — 클릭 즉시 창을 열어야 팝업 차단을 피함 */
async function popOut(prepare) {
  const id = Math.random().toString(36).slice(2, 10);
  const w = window.open('', `ybm-cp-${id}`, 'popup=yes,width=860,height=900');
  if (!w) { toast('팝업이 차단되었습니다. 주소창 오른쪽에서 팝업을 허용해 주세요.', 6000); return; }
  try { w.document.title = '메일 쓰기 – YB-Mail'; w.document.body.innerHTML = '<p style="font-family:sans-serif;color:#888;padding:20px">여는 중…</p>'; } catch { /* 무시 */ }
  if (prepare) await prepare();
  if (cp.quotePending) await cp.quotePending;
  drafts.set(id, snapshotCompose());
  cp.dirty = false;
  closeCompose(true);
  w.location.href = `${location.pathname}?cpwin=${id}${DEMO ? '&demo' : ''}`;
}
/* ───────── 원문: 포함(on) · 직접 편집(edit) · 빼기(off) ───────── */
function showQuote() {
  cp.quoteOrig = cp.quoteOrig || { html: cp.quoteHtml, text: cp.quoteText };
  setQuoteMode('on');
}
function renderQuoteView(open = false) {
  const v = $('#cp-quote-view');
  v.hidden = !open;
  $('#cpq-toggle').textContent = `${open ? '▾' : '▸'} 원문 포함됨 (눌러서 ${open ? '접기' : '보기'})`;
  if (!open) return;
  // 원문 서식(style)이 앱 화면에 번지지 않도록 별도 틀 안에 표시
  const f = document.createElement('iframe');
  f.className = 'm-frame';
  f.setAttribute('sandbox', 'allow-same-origin');
  f.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>${FRAME_CSS}</style></head><body>${cp.quoteHtml}</body></html>`;
  f.onload = () => { const d = f.contentDocument; if (d) f.style.height = Math.max(60, d.documentElement.scrollHeight + 4) + 'px'; };
  v.replaceChildren(f);
}
function setQuoteMode(mode) {
  const box = $('#cp-quote');
  const ed = $('#cp-quote-edit');
  if (cp.quoteMode === 'edit' && mode !== 'edit') { cp.quoteHtml = `<div class="gmail_quote">${ed.innerHTML}</div>`; cp.quoteText = htmlToText(ed.innerHTML); }
  cp.quoteMode = mode;
  box.hidden = !cp.quoteOrig && !cp.quoteHtml;
  box.dataset.mode = mode;
  $('#cpq-toggle').hidden = mode !== 'on';
  $('#cpq-edit').hidden = mode !== 'on';
  $('#cpq-remove').hidden = mode === 'off';
  $('#cpq-restore').hidden = mode !== 'off';
  ed.hidden = mode !== 'edit';
  if (mode === 'on') renderQuoteView(false);
  else $('#cp-quote-view').hidden = true;
  if (mode === 'edit') { ed.innerHTML = sanitize(cp.quoteHtml); if (!edQuote) edQuote = setupEditor(ed); }
  $('#cpq-off-note').hidden = mode !== 'off';
}
/** 지금 보낼 원문 (모드 반영) */
function currentQuote() {
  if (cp.quoteMode === 'off') return { html: '', text: '' };
  if (cp.quoteMode === 'edit') { const ed = $('#cp-quote-edit'); return { html: `<div class="gmail_quote">${ed.innerHTML}</div>`, text: htmlToText(ed.innerHTML) }; }
  return { html: cp.quoteHtml, text: cp.quoteText };
}
let edQuote = null;
function syncSigBox() { $('#cp-sigwrap').classList.toggle('empty', !$('#cp-sig').textContent.trim() && !$('#cp-sig img')); }

function renderCpAtts() {
  const all = [...cp.origAtts.map((x, i) => (x.keep ? { name: x.filename, size: x.size, type: x.mimeType, k: `o${i}` } : null)).filter(Boolean),
    ...cp.files.map((f, i) => ({ name: f.name, size: f.size, type: f.type, k: `f${i}` }))];
  $('#cp-atts').innerHTML = all.map((x) => `<span class="att"><span class="a-ic">${fileIcon(x.type, x.name)}</span><span class="a-nm">${esc(x.name)}</span><span class="a-sz">${sizeText(x.size)}</span><button class="a-x" data-rm="${x.k}" title="빼기" aria-label="빼기">✕</button></span>`).join('');
  $('#cp-atts').hidden = !all.length;
}
function addFiles(list) {
  for (const f of list) cp.files.push(f);
  cp.dirty = true;
  renderCpAtts();
}

async function closeCompose(force = false) {
  if (!force && cp.dirty) {
    const r = await askUnsaved();
    if (r === 'cancel') return false;
    if (r === 'save' && !(await saveDraft())) return false;
  }
  cp.open = false;
  setSplit(false);
  if (CPWIN) { cp.dirty = false; window.close(); return; }
  $('#compose').hidden = true;
  $('#suggest').hidden = true;
  edMain?.hide(); edSig?.hide();
  if (!cp.float && innerWidth <= 860) $('#app').dataset.view = state.thread ? 'read' : cp.prevView || 'list';
  return true;
}

function snapshotCompose() {
  return {
    account: cp.account,
    from: $('#cp-from').value, to: $('#cp-to').value, cc: $('#cp-cc').value, bcc: $('#cp-bcc').value, subject: $('#cp-subject').value,
    html: $('#cp-editor').innerHTML, sig: $('#cp-sig').innerHTML,
    mode: cp.mode, threadId: cp.threadId, inReplyTo: cp.inReplyTo, references: cp.references, quoteHtml: currentQuote().html, quoteText: currentQuote().text,
    files: [...cp.files], origAtts: cp.origAtts.map((x) => ({ ...x })),
    draftId: cp.draftId, draftAccount: cp.draftAccount,
  };
}

const cpSay = (t, err) => { const el = $('#cp-msg'); el.textContent = t || ''; el.className = 'cp-msg' + (err ? ' err' : ''); };

/** 쓰기 창 내용 → 메일 원문 (보내기·임시 저장 공용) */
async function buildMessage({ draft = false } = {}) {
  const from = $('#cp-from').value;
  const fields = { to: $('#cp-to').value, cc: $('#cp-cc').value, bcc: $('#cp-bcc').value };
  const all = Object.values(fields).flatMap(parseAddrList);
  const bad = all.filter((x) => !validEmail(x.email));
  if (!draft && !all.length) { $('#cp-to').focus(); throw new Error('받는 사람을 입력하세요.'); }
  if (!draft && bad.length) throw new Error(`주소 확인: ${bad.map((x) => x.email).join(', ')}`);
  if (!auth.token(from)) throw new Error(`${from} 연결이 필요합니다. 왼쪽 '연결'을 누른 뒤 다시 시도하세요.`);
  const subject = $('#cp-subject').value.trim();
  const snap = snapshotCompose();
  const a = acc(from);
  cpSay('첨부 준비 중…');
  const attachments = [];
  for (const f of cp.files) attachments.push({ name: f.name, type: f.type || 'application/octet-stream', bytes: new Uint8Array(await f.arrayBuffer()) });
  for (const x of cp.origAtts.filter((o) => o.keep)) {
    const data = x.data || await gm.getAttachment(x.account, x.msgId, x.attachmentId, { name: x.filename, size: x.size });
    attachments.push({ name: x.filename, type: x.mimeType, bytes: b64ToBytes(data) });
  }
  const editorHtml = $('#cp-editor').innerHTML;
  const sig = $('#cp-sig').innerHTML.trim();
  const sigOn = $('#cp-sig').textContent.trim() || $('#cp-sig img');
  const STYLE = `font-family:${MAIL_FONT};font-size:14.5px;line-height:1.6;color:#222`;
  // 받는 사람 화면: 내 글 → 서명 → (원문)
  const q = currentQuote();
  const combined = `<div class="ybm-body" style="${STYLE}">${editorHtml}</div>` +
    (sigOn ? `<br><div class="ybm-signature" style="${STYLE}">${sig}</div>` : '') +
    (q.html ? `<br>${q.html}` : '');
  const { html, inline } = extractInline(combined);
  const total = [...attachments, ...inline].reduce((n, f) => n + f.bytes.length, 0);
  if (total > 24 * 1024 * 1024) throw new Error(`첨부·그림 합계 ${sizeText(total)} — Gmail 한도(25MB)를 넘습니다.`);
  const plain = [htmlToText(editorHtml), sigOn ? htmlToText(sig) : '', q.text].filter(Boolean).join('\n\n');
  const sameThread = from === cp.account;
  const raw = buildRaw({
    from: { name: a.name, email: from }, ...fields, subject, text: plain, html,
    inReplyTo: sameThread ? cp.inReplyTo : '', references: sameThread ? cp.references : '', attachments, inline,
  });
  return { from, fields, subject, raw, threadId: sameThread ? cp.threadId : null, snap };
}

async function sendCompose() {
  const btn = $('#cp-send');
  if (!$('#cp-subject').value.trim() && !confirm('제목 없이 보낼까요?')) return;
  btn.disabled = true;
  try {
    const m = await buildMessage();
    learn(m.fields.to, 3); learn(m.fields.cc, 2); learn(m.fields.bcc, 1);
    const draft = cp.draftId ? { id: cp.draftId, account: cp.draftAccount } : null;
    cp.dirty = false;
    await closeCompose(true);
    queueSend({ from: m.from, raw: m.raw, threadId: m.threadId, subject: m.subject || '(제목 없음)', snap: m.snap, draft });
  } catch (e) {
    cpSay(e.message || '보내기 준비 실패', true);
    if (e instanceof auth.AuthError) fail(e, 'send');
  } finally { btn.disabled = false; }
}

/** 임시 저장 (Gmail 임시보관함 = 임시메일함) */
async function saveDraft({ quiet = false } = {}) {
  const btn = $('#cp-draft');
  btn.disabled = true;
  try {
    const m = await buildMessage({ draft: true });
    if (cp.draftId && cp.draftAccount !== m.from) { await gm.deleteDraft(cp.draftAccount, cp.draftId).catch(() => {}); cp.draftId = null; }
    const r = cp.draftId ? await gm.updateDraft(m.from, cp.draftId, m.raw, m.threadId) : await gm.createDraft(m.from, m.raw, m.threadId);
    cp.draftId = r.id; cp.draftAccount = m.from;
    cp.dirty = false;
    cpSay(`임시 저장됨 ${new Date().toTimeString().slice(0, 5)}`);
    if (!quiet) toast('임시메일함에 저장했습니다.');
    if (state.folder.label === 'DRAFT') loadList({ silent: true });
    return true;
  } catch (e) {
    cpSay(e.message || '임시 저장 실패', true);
    if (e instanceof auth.AuthError) fail(e, 'draft');
    return false;
  } finally { btn.disabled = false; }
}

/** 저장하지 않은 메일 닫기: 임시 저장 / 저장 안 함 / 취소 */
function askUnsaved() {
  return new Promise((res) => {
    const w = modal(`<h3>작성 중인 메일이 있습니다</h3>
      <p class="modal-tip">임시메일함에 저장하면 나중에 이어 쓸 수 있습니다.</p>
      <div class="modal-foot"><button class="btn-ghost" data-r="cancel">취소</button><button class="btn-ghost danger-ghost" data-r="discard">저장 안 함</button><button class="btn-primary" data-r="save">임시 저장</button></div>`);
    w.classList.add('modal-sm');
    const done = (r) => { w.remove(); document.removeEventListener('keydown', key, true); res(r); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done('cancel'); } };
    document.addEventListener('keydown', key, true);
    w.addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (b) done(b.dataset.r); else if (e.target === w) done('cancel'); });
    $('[data-r="save"]', w).focus();
  });
}

/** 임시메일함의 메일을 쓰기 창으로 */
async function openDraftMsg(m, thread) {
  try {
    toast('임시 저장 메일 여는 중…', 0);
    const draftId = await gm.draftIdOf(m.account, m.id);
    let html = m.html || `<div>${textToHtml(m.text || '')}</div>`;
    html = await inlineCid(m, html);
    const d = new DOMParser().parseFromString(html, 'text/html');
    const sigEl = d.querySelector('.ybm-signature');
    const quoteEl = d.querySelector('.gmail_quote');
    sigEl?.remove(); quoteEl?.remove();
    const bodyEl = d.querySelector('.ybm-body');
    let body = (bodyEl ? bodyEl.innerHTML : d.body.innerHTML).replace(/(<br\s*\/?>\s*)+$/i, '');
    const others = (thread?.messages || []).filter((x) => x.id !== m.id && !x.labelIds.includes('DRAFT'));
    $('#toast').hidden = true;
    await openCompose({ snapshot: {
      account: m.account, from: m.account, to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, html: body || '<div><br></div>', sig: sigEl ? sigEl.innerHTML : '',
      mode: others.length ? 'reply' : 'new', threadId: others.length ? m.threadId : null, inReplyTo: m.inReplyTo, references: m.references,
      quoteHtml: quoteEl ? quoteEl.outerHTML : '', quoteText: quoteEl ? htmlToText(quoteEl.outerHTML) : '',
      files: [], origAtts: m.attachments.filter((x) => !x.contentId || !html.includes('data:')).filter((x) => !x.inline).map((x) => ({ ...x, msgId: m.id, account: m.account, keep: true })),
      draftId, draftAccount: m.account,
    } });
    cp.dirty = false;
    cpSay('임시 저장된 메일을 열었습니다.');
  } catch (e) { fail(e, 'draft-open'); }
}
/** 임시메일함에서 지우기 (되돌릴 수 없음) */
async function deleteDraftItems(items) {
  if (!confirm(`임시 저장 메일 ${items.length}개를 지울까요? (되돌릴 수 없습니다)`)) return;
  dropItems(items);
  let n = 0;
  for (const t of items) {
    try {
      const th = await gm.getThread(t.account, t.id, { force: true });
      for (const m of th.messages.filter((x) => x.labelIds.includes('DRAFT'))) {
        const id = await gm.draftIdOf(t.account, m.id);
        if (id) { await gm.deleteDraft(t.account, id); n++; }
      }
    } catch (e) { fail(e, 'draft-del'); }
  }
  toast(`임시 저장 메일 ${n}개를 지웠습니다.`);
}
/** 임시메일함 목록에서 누르면 바로 쓰기 창으로 */
async function openDraftItem(t) {
  state.checked = new Set([t.key]); state.anchor = t.key; state.sel = t.key;
  renderList();
  try {
    const th = await gm.getThread(t.account, t.id, { force: true });
    const drafts = th.messages.filter((m) => m.labelIds.includes('DRAFT'));
    if (!drafts.length) { toast('임시 저장 메일을 찾지 못했습니다.'); return; }
    state.thread = th;
    await openDraftMsg(drafts[drafts.length - 1], th);
  } catch (e) { fail(e, 'draft'); }
}
async function deleteDraftMsg(m) {
  if (!confirm('이 임시 저장 메일을 지울까요?')) return;
  try {
    const id = await gm.draftIdOf(m.account, m.id);
    if (id) await gm.deleteDraft(m.account, id);
    toast('임시 저장 메일을 지웠습니다.');
    const t = current();
    if (t) { const th = await gm.getThread(t.account, t.id, { force: true }).catch(() => null); if (th?.messages.length) { state.thread = th; renderReader(); } else dropItems([t]); }
  } catch (e) { fail(e, 'draft-del'); }
}

/* ───────── 발송 취소 (보내기 후 최대 30초 대기) ───────── */
const outbox = [];
function queueSend(job) {
  // 별도 창에서 보낸 경우: 본 창이 발송 취소 막대를 맡고 이 창은 닫음
  if (CPWIN && window.opener && !window.opener.closed && window.opener.__ybmQueueSend) {
    try { window.opener.__ybmQueueSend(job); cp.dirty = false; window.close(); return; } catch { /* 본 창이 없으면 여기서 처리 */ }
  }
  job.id = Math.random().toString(36).slice(2);
  job.deadline = Date.now() + state.undoSec * 1000;
  outbox.push(job);
  if (state.undoSec <= 0) { flushSend(job); return; }
  job.timer = setTimeout(() => flushSend(job), state.undoSec * 1000);
  renderSendbar();
}
async function flushSend(job) {
  const i = outbox.indexOf(job);
  if (i < 0) return;
  clearTimeout(job.timer);
  outbox.splice(i, 1);
  renderSendbar();
  try {
    await gm.sendMime(job.from, job.raw, job.threadId);
    if (job.draft) gm.deleteDraft(job.draft.account, job.draft.id).catch(() => {});
    toast(`보냈습니다: ${job.subject}`);
    if (state.thread && job.threadId && state.thread.id === job.threadId) { await gm.fetchFull(job.from, job.threadId, { force: true }); if (state.sel) openThread(state.sel); }
    else if (state.folder.label === 'SENT') loadList({ silent: true });
  } catch (e) {
    fail(e, 'send');
    toast(`보내지 못했습니다: ${job.subject}`, 0, { label: '다시 쓰기', run: () => openCompose({ snapshot: job.snap }) });
  }
}
function cancelSend(id) {
  const job = outbox.find((j) => j.id === id);
  if (!job) return;
  clearTimeout(job.timer);
  outbox.splice(outbox.indexOf(job), 1);
  renderSendbar();
  openCompose({ snapshot: job.snap });
  toast('발송을 취소했습니다. 메일을 다시 열었습니다.');
}
function renderSendbar() {
  const bar = $('#sendbar');
  bar.hidden = !outbox.length;
  bar.innerHTML = outbox.map((j) => {
    const left = Math.max(0, Math.ceil((j.deadline - Date.now()) / 1000));
    const pct = Math.max(0, Math.min(100, ((j.deadline - Date.now()) / (state.undoSec * 1000)) * 100));
    return `<button class="sb-item" data-cancel="${j.id}" title="눌러서 발송 취소"><span class="sb-t"><b>메일 발송 취소:</b> ${esc(j.subject)}</span><span class="sb-s">${left}초</span><i style="width:${pct}%"></i></button>`;
  }).join('');
}
setInterval(() => { if (outbox.length) renderSendbar(); }, 500);
window.addEventListener('beforeunload', (e) => { if (outbox.length || (cp.open && cp.dirty)) { e.preventDefault(); e.returnValue = ''; } });

/* 받는 사람 자동 완성 */
let sugTarget = null, sugIdx = 0;
function suggest(input) {
  const v = input.value;
  const cut = Math.max(v.lastIndexOf(','), v.lastIndexOf(';'));
  const term = v.slice(cut + 1).trim().toLowerCase();
  const box = $('#suggest');
  if (term.length < 1) { box.hidden = true; return; }
  const hits = [...contacts.entries()].filter(([e, c]) => e.includes(term) || (c.n || '').toLowerCase().includes(term))
    .sort((a, b) => b[1].c - a[1].c).slice(0, 8);
  if (!hits.length) { box.hidden = true; return; }
  sugTarget = input; sugIdx = 0;
  box.innerHTML = hits.map(([e, c], i) => `<li data-e="${esc(e)}" data-n="${esc(c.n || '')}" class="${i ? '' : 'on'}">${esc(c.n || e)}${c.n ? `<small>${esc(e)}</small>` : ''}</li>`).join('');
  const r = input.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 300))}px`;
  box.style.top = `${r.bottom + 4}px`;
  box.hidden = false;
}
function pickSuggest(li) {
  const input = sugTarget;
  if (!input || !li) return;
  const v = input.value;
  const cut = Math.max(v.lastIndexOf(','), v.lastIndexOf(';'));
  const addr = li.dataset.n ? `${li.dataset.n} <${li.dataset.e}>` : li.dataset.e;
  input.value = (cut >= 0 ? v.slice(0, cut + 1) + ' ' : '') + addr + ', ';
  $('#suggest').hidden = true;
  input.focus();
}

/* ───────── 처음 설정·계정 연결 화면 ───────── */
function gate(kind) {
  const g = $('#gate');
  const card = $('#gate-card');
  if (!kind) { g.hidden = true; return; }
  g.hidden = false;
  const icon = '<img src="icons/icon.svg" alt="" width="72" height="72" />';
  if (kind === 'client') {
    card.innerHTML = `${icon}<h2>YB-Mail 처음 설정</h2>
      <p>Google Cloud에서 만든 <b>OAuth 클라이언트 ID</b>를 붙여넣으세요.<br>(한 번만 하면 이 기기에 기억됩니다)</p>
      <input id="gate-cid" placeholder="123456789-xxxx.apps.googleusercontent.com" />
      <button class="btn-primary" id="gate-cid-ok">저장</button>
      <p class="gate-msg" id="gate-msg"></p>`;
  } else if (kind === 'add') {
    card.innerHTML = `${icon}<h2>YB-Mail</h2>
      <p>학교 계정과 개인 계정을 차례로 추가하면<br>두 계정 메일을 한 화면에서 봅니다.${DESK ? '<br><small>누르면 기본 브라우저에서 Google 로그인 창이 열립니다.</small>' : ''}</p>
      <button class="btn-primary" id="gate-add">Google 계정 추가</button>
      <p class="gate-msg" id="gate-msg"></p>
      <button class="btn-text" id="gate-cid-reset">클라이언트 ID 다시 입력</button>`;
  } else if (kind === 'connect') {
    card.innerHTML = `${icon}<h2>계정 연결</h2>
      <p>${DESK ? '계정마다 <b>연결</b>을 누르면 기본 브라우저에서 Google 로그인 창이 열립니다.<br>로그인 후 YB-Mail로 돌아오면 됩니다(이후 자동 유지).' : '보안을 위해 연결은 1시간마다 새로 받습니다.<br>계정마다 <b>연결</b>을 눌러 주세요(창이 잠깐 떴다 닫힙니다).'}</p>
      <div class="gate-accs">${accs().map((a) => `<div class="gate-acc" style="--acc:${a.color}"><span>${esc(a.email)}</span>${auth.token(a.email) ? '<b class="ok">✓ 연결됨</b>' : `<button class="btn-primary" data-reconnect="${esc(a.email)}">연결</button>`}</div>`).join('')}</div>
      <p class="gate-msg" id="gate-msg"></p>
      <button class="btn-text" id="gate-skip">저장된 메일만 보기 (연결 없이 열기)</button>`;
  }
}
function gateMsg(t) { const el = $('#gate-msg'); if (el) el.textContent = t || ''; }

async function doReconnect(email) {
  try {
    await auth.reconnect(email);
    toast(`${email} 연결됨`);
    afterConnect();
  } catch (e) { gateMsg(e.message); toast(e.message, 6000); }
}
async function doAdd() {
  try {
    const email = await auth.addAccount();
    toast(`${email} 추가됨`);
    afterConnect();
  } catch (e) { gateMsg(e.message); toast(e.message, 6000); }
}
let started = false, gateSkipped = false;
function afterConnect() {
  renderBanner();
  renderSide();
  if (!accs().length) { gate('add'); return; }
  if (!connected().length && !gateSkipped) { gate('connect'); }
  else if (!$('#gate').hidden && accs().some((a) => !auth.token(a.email)) && !gateSkipped) gate('connect');
  else gate(null);
  if (!started) { started = true; selectFolder(state.folder.scope, state.folder.label); }
  else loadList({ silent: true });
  if (connected().length) { refreshCounts(); setTimeout(runPrefetch, 2500); setTimeout(checkNewMail, 1500); }
  syncNotifAsk();
}

/* ───────── 설정 메뉴 ───────── */
let installEvt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: minimal-ui)').matches || navigator.standalone;
const inAppBrowser = () => /Electron|Claude/i.test(navigator.userAgent); // Claude 앱 안의 브라우저 등 (설치 불가)
let installedApp = false;
installEvt = window.__bip || null;
/** 프로그램 창으로 열려 있지 않으면 [설치하기] 단추 표시 (브라우저가 설치 안내를 안 줘도 방법 안내) */
function syncInstall() { const off = isStandalone() || installedApp || !!CPWIN || !!DESK; for (const id of ['#btn-install', '#btn-install2']) { const b = $(id); if (b) b.hidden = off; } }
window.addEventListener('ybm-bip', () => { installEvt = window.__bip; syncInstall(); });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; syncInstall(); });
window.addEventListener('appinstalled', () => { installEvt = null; installedApp = true; syncInstall(); toast('YB-Mail을 프로그램으로 설치했습니다. 바탕화면·시작 메뉴에서 여세요.', 7000); });
(async () => { try { const r = await navigator.getInstalledRelatedApps?.(); if (r?.length) { installedApp = true; syncInstall(); } } catch { /* 무시 */ } })();
async function doInstall() {
  if (installEvt) {
    installEvt.prompt();
    const r = await installEvt.userChoice.catch(() => ({ outcome: 'dismissed' }));
    if (r.outcome !== 'accepted') toast('설치를 취소했습니다. 언제든 [설치하기]를 다시 누르면 됩니다.');
    installEvt = null; window.__bip = null;
    return;
  }
  const url = location.origin + location.pathname;
  if (inAppBrowser()) {
    try { await navigator.clipboard.writeText(url); } catch { /* 무시 */ }
    await askChoice('설치하기', `<p class="modal-tip">지금 화면(Claude 앱 안의 브라우저)에서는 프로그램 설치가 되지 않습니다.<br><b>Chrome</b>이나 <b>Edge</b>를 열고 주소창에 아래 주소를 붙여넣은 뒤 [설치하기]를 누르세요. (주소는 복사해 두었습니다)</p><p class="inst-url">${esc(url)}</p>`, [['ok', '확인', 'btn-primary']]);
    return;
  }
  await askChoice('설치하기', `<p class="modal-tip">브라우저가 아직 설치 준비를 알려 주지 않았습니다. 아래 방법으로 바로 설치할 수 있습니다.</p>
    <ol class="inst-steps"><li><b>Chrome</b>: 주소창 오른쪽 끝의 <b>설치 아이콘(⊕ 모니터 모양)</b> 누르기<br>또는 메뉴 <b>⋮ → 캐스팅, 저장, 공유 → 페이지를 앱으로 설치</b><br>그 항목이 없으면 <b>⋮ → 캐스팅, 저장, 공유 → 바로가기 만들기… → '창으로 열기' 체크 → 만들기</b> (같은 프로그램 창으로 설치됨)</li>
    <li><b>Edge</b>: 메뉴 <b>… → 앱 → 이 사이트를 앱으로 설치</b></li>
    <li>이미 설치했다면: 바탕화면·시작 메뉴의 <b>YB-Mail</b> 아이콘으로 여세요.</li></ol>`, [['ok', '확인', 'btn-primary']]);
}

/* ───────── 새 메일 알림 (받은편지함만, 앱이 열려 있는 동안) ───────── */
const notif = {
  on: pref.get('notifOn', true),
  seen: new Set(pref.get('notifSeen', [])), // 이미 본(알린) 대화 key
  primed: new Set(),                          // 첫 확인을 마친 계정 (켜자마자 예전 메일로 알림 폭탄 방지)
  busy: false,
};
const notifSupported = () => 'Notification' in window;
function syncNotifAsk() {
  const ask = $('#notif-ask');
  ask.hidden = !(notif.on && notifSupported() && Notification.permission === 'default' && !pref.get('notifLater', false) && connected().length && !CPWIN);
}
async function enableNotif() {
  if (!notifSupported()) { toast('이 브라우저는 알림을 지원하지 않습니다.'); return false; }
  const p = await Notification.requestPermission();
  if (p === 'granted') { notif.on = true; pref.set('notifOn', true); toast('새 메일 알림을 켰습니다.'); }
  else toast('알림이 차단되어 있습니다. 주소창 왼쪽 자물쇠(사이트 설정) → 알림 → 허용으로 바꿔 주세요.', 9000);
  syncNotifAsk();
  return p === 'granted';
}
function saveSeen() { pref.set('notifSeen', [...notif.seen].slice(-800)); }
async function checkNewMail() {
  if (notif.busy || !notif.on || CPWIN) return;
  notif.busy = true;
  try {
    for (const a of connected()) {
      const r = await gm.listThreads(a.email, { labelIds: ['INBOX'], q: 'is:unread', max: 15 }).catch(() => null);
      if (!r) continue;
      const fresh = r.threads.filter((t) => !notif.seen.has(`${t.key}|${t.count}`));
      r.threads.forEach((t) => notif.seen.add(`${t.key}|${t.count}`));
      if (!notif.primed.has(a.email)) { notif.primed.add(a.email); continue; } // 첫 확인은 기록만
      if (!fresh.length) continue;
      state.unread[a.email] = await gm.unreadCount(a.email, 'INBOX').catch(() => state.unread[a.email]);
      renderSide();
      if (state.folder.label === 'INBOX' && (state.folder.scope === 'all' || state.folder.scope === a.email)) loadList({ silent: true });
      if (notifSupported() && Notification.permission === 'granted' && !(document.hasFocus() && document.visibilityState === 'visible')) {
        for (const t of fresh.slice(0, 3).reverse()) showMailNotif(a, t);
        if (fresh.length > 3) new Notification(`YB-Mail · ${accLabel(a)}`, { body: `새 메일 ${fresh.length}통이 왔습니다.`, icon: 'icons/icon-192.png', tag: `ybm-many-${a.email}` });
      }
    }
    saveSeen();
  } finally { notif.busy = false; }
}
function showMailNotif(a, t) {
  const who = gm.shortName(t.from) || t.senders[0] || '보낸 사람';
  const n = new Notification(`${who} · ${accLabel(a)}`, {
    body: `${t.subject}\n${t.snippet}`.slice(0, 180),
    icon: 'icons/icon-192.png',
    badge: 'icons/favicon-64.png',
    tag: t.key,
    silent: false,
  });
  n.onclick = async () => {
    DESK?.show().catch(() => {});
    window.focus();
    n.close();
    if (!state.items.some((x) => x.key === t.key)) { state.items.unshift(t); renderList(); }
    openThread(t.key, { scroll: true });
  };
}

let deskInfo = {};
async function openMenu(anchor) {
  const usage = await cache.usage();
  if (DESK) deskInfo = await DESK.info().catch(() => ({}));
  showPop(anchor, `
    <div class="pop-row">화면 <select id="m-theme" class="sel"><option value="system">기기 설정 따름</option><option value="light">밝게</option><option value="dark">어둡게</option></select></div>
    ${mi('img', `${state.showImages ? '☑' : '☐'} 메일 속 외부 그림 바로 표시`)}
    ${mi('notif', `${notif.on && notifSupported() && Notification.permission === 'granted' ? '☑' : '☐'} 새 메일 알림 (받은편지함)`)}
    <hr>
    ${mi('sig', '서명 만들기·고치기', { icon: '✍' })}
    ${mi('acc', '계정 설정 (이름·색·순서)', { icon: '👤' })}
    ${mi('blocked', '차단한 주소 (스팸 필터)', { icon: '⛔' })}
    ${mi('add', '계정 추가', { icon: '＋' })}
    <div class="pop-row">발송 취소 대기 <select id="m-undo" class="sel"><option value="0">끄기</option><option value="5">5초</option><option value="10">10초</option><option value="20">20초</option><option value="30">30초 (최대)</option></select></div>
    <hr>
    <div class="pop-row">기기 저장 <select id="m-pre" class="sel"><option value="0">미리 받지 않음</option><option value="100">계정별 최근 100통</option><option value="200">계정별 최근 200통</option><option value="500">계정별 최근 500통</option></select></div>
    ${mi('prefetch', '지금 미리 받기', { icon: '⟳', hint: `사용 ${sizeText(usage)}` })}
    ${mi('wipe', '이 기기 저장본 모두 지우기', { icon: '🧹', cls: 'danger' })}
    <hr>
    ${!isStandalone() ? mi('install', installEvt ? '앱으로 설치 (바탕화면·작업표시줄)' : '앱으로 설치하는 방법', { icon: '⬇' }) : ''}
    ${DESK ? mi('autostart', `${deskInfo.autoStart ? '☑' : '☐'} Windows 시작할 때 자동 실행`, { icon: '🖥' }) : mi('cid', '클라이언트 ID 바꾸기', { icon: '🔑' })}
    ${mi('update', `새 버전 확인 (v${VERSION}${DESK && deskInfo.version ? ` · 프로그램 ${deskInfo.version}` : ''})`, { icon: '⟳' })}`, async (k) => {
    if (k === 'notif') {
      if (notif.on && Notification.permission === 'granted') { notif.on = false; pref.set('notifOn', false); toast('새 메일 알림을 껐습니다.'); }
      else { notif.on = true; pref.set('notifOn', true); pref.set('notifLater', false); enableNotif(); }
    }
    if (k === 'img') { state.showImages = !state.showImages; pref.set('showImages', state.showImages); if (state.thread) renderReader(); toast(state.showImages ? '외부 그림을 바로 표시합니다.' : '외부 그림을 숨깁니다(메일마다 표시 가능).'); }
    if (k === 'sig') openSigSettings();
    if (k === 'acc') openAccSettings();
    if (k === 'blocked') openBlocked();
    if (k === 'add') doAdd();
    if (k === 'prefetch') { bg.ranOnce = false; runPrefetch(); }
    if (k === 'wipe' && confirm('이 기기에 저장한 메일 사본을 모두 지울까요?\n(Gmail 서버의 메일은 그대로이며, 다시 미리 받습니다)')) { await cache.clearAll(); toast('기기 저장본을 지웠습니다.'); }
    if (k === 'install') doInstall();
    if (k === 'autostart') { await DESK.setAutoStart(!deskInfo.autoStart); toast(!deskInfo.autoStart ? 'Windows를 시작할 때 YB-Mail이 트레이에서 자동 실행됩니다.' : '자동 실행을 껐습니다.'); }
    if (k === 'cid') { const v = prompt('OAuth 클라이언트 ID', auth.clientId()); if (v != null) { auth.setClientId(v); toast('저장했습니다. 계정을 다시 연결하세요.'); } }
    if (k === 'update') navigator.serviceWorker?.getRegistration().then((r) => r?.update()).then(() => toast('확인했습니다. 새 버전이 있으면 안내가 뜹니다.'));
  });
  const p = $('#pop');
  const s = $('#m-theme', p); s.value = getTheme(); s.onchange = () => { setTheme(s.value); syncThemeIcon(); };
  const u = $('#m-undo', p); u.value = String(state.undoSec); u.onchange = () => { state.undoSec = Number(u.value); pref.set('undoSec', state.undoSec); };
  const pr = $('#m-pre', p); pr.value = String(state.prefetchN); pr.onchange = () => { state.prefetchN = Number(pr.value); pref.set('prefetchN', state.prefetchN); if (state.prefetchN) { bg.ranOnce = false; runPrefetch(); } };
}

function modal(html) {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<div class="modal-card">${html}</div>`;
  document.body.append(wrap);
  return wrap;
}

function openSigSettings() {
  const list = accs();
  if (!list.length) { toast('먼저 계정을 추가하세요.'); return; }
  const w = modal(`<h3>✍ 서명</h3>
    <p class="modal-tip">계정마다 서명을 만들면 새 메일·답장·전달의 <b>맨 아래</b>에 자동으로 들어갑니다. 로고 등 그림도 붙여넣을 수 있습니다(모서리를 잡아 크기 조절).</p>
    ${list.map((a) => `<div class="acc-edit" style="--acc:${a.color}" data-e="${esc(a.email)}">
      <div class="ae-h"><span class="dot" style="background:${a.color}"></span><span>${esc(a.email)}</span></div>
      <div class="sig-tools">${toolbarHtml()}</div>
      <div class="sig-ed" contenteditable="true" data-sig>${sigHtml(a)}</div>
    </div>`).join('')}
    <div class="modal-foot"><button class="btn-ghost" data-close>취소</button><button class="btn-primary" data-save>저장</button></div>`);
  const eds = $$('[data-sig]', w).map((el) => setupEditor(el));
  $$('[data-e]', w).forEach((box, i) => bindToolbar($('.sig-tools', box), () => eds[i]));
  w.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target === w) { eds.forEach((x) => x.hide()); w.remove(); }
    if (e.target.closest('[data-save]')) {
      $$('[data-e]', w).forEach((box) => {
        const el = $('[data-sig]', box);
        const empty = !el.textContent.trim() && !el.querySelector('img');
        auth.updateAccount(box.dataset.e, { signatureHtml: empty ? '' : el.innerHTML, signature: '' });
      });
      eds.forEach((x) => x.hide());
      w.remove();
      toast('서명을 저장했습니다.');
    }
  });
}

function openAccSettings() {
  const w = modal('');
  const card = $('.modal-card', w);
  const draw = () => {
    const list = accs();
    card.innerHTML = `<h3>계정 설정</h3>
      ${list.map((a, i) => `<div class="acc-edit" style="--acc:${a.color}" data-e="${esc(a.email)}">
        <div class="ae-h"><span class="dot" style="background:${a.color}"></span><span>${esc(a.email)}</span>
          <button class="icon-btn" data-mv="-1" ${i ? '' : 'disabled'} title="위로">↑</button><button class="icon-btn" data-mv="1" ${i < list.length - 1 ? '' : 'disabled'} title="아래로">↓</button></div>
        <div class="ae-row"><label>짧은 표시 (목록 꼬리표)<input data-f="label" value="${esc(a.label || '')}" maxlength="8"></label>
        <label>보내는 사람 이름<input data-f="name" value="${esc(a.name || '')}" placeholder="예: 김영배" maxlength="40"></label></div>
        <div class="ae-row" style="align-items:center"><label>색<select data-f="color" class="sel">${ACCOUNT_COLORS.concat(PALETTE).filter((c, k, arr) => arr.indexOf(c) === k).map((c) => `<option value="${c}" ${c === a.color ? 'selected' : ''} style="color:${c}">■ ${c}</option>`).join('')}</select></label>
        <button class="btn-ghost" data-rm style="color:var(--danger);align-self:flex-end;margin-bottom:8px">계정 빼기</button></div>
      </div>`).join('')}
      <div class="modal-foot"><button class="btn-ghost" data-sig>✍ 서명 설정</button><button class="btn-primary" data-close>닫기</button></div>`;
  };
  draw();
  w.addEventListener('change', (e) => {
    const box = e.target.closest('[data-e]'); const f = e.target.dataset.f;
    if (box && f) { auth.updateAccount(box.dataset.e, { [f]: e.target.value }); renderSide(); renderList(); if (f === 'color') draw(); }
  });
  w.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target === w) { w.remove(); return; }
    if (e.target.closest('[data-sig]')) { w.remove(); openSigSettings(); return; }
    const box = e.target.closest('[data-e]');
    if (!box) return;
    const mv = e.target.closest('[data-mv]');
    if (mv) { auth.moveAccount(box.dataset.e, Number(mv.dataset.mv)); draw(); renderSide(); }
    if (e.target.closest('[data-rm]') && confirm(`${box.dataset.e} 계정을 YB-Mail에서 뺄까요?\n(Gmail의 메일은 지워지지 않습니다)`)) {
      auth.removeAccount(box.dataset.e);
      delete state.unread[box.dataset.e];
      state.items = state.items.filter((t) => t.account !== box.dataset.e);
      if (state.folder.scope === box.dataset.e) selectFolder('all', 'INBOX');
      renderSide(); renderList(); renderBanner();
      if (!accs().length) { w.remove(); gate('add'); return; }
      draw();
    }
  });
}

/* ───────── 오른쪽 클릭 메뉴 ───────── */
function listMenu(pt) {
  const items = targets();
  if (!items.length) return;
  const one = items.length === 1 ? items[0] : null;
  const L = state.folder.label;
  const anyUnread = items.some((t) => t.unread), anyStar = items.some((t) => t.starred);
  const sameAcc = items.every((t) => t.account === items[0].account);
  const labels = sameAcc ? state.labels[items[0].account] || [] : [];
  const head = one ? '' : `<div class="pop-h">${items.length}개 대화 선택됨</div>`;
  showPop(pt, `${head}
    ${one ? mi('open', '열기', { icon: '📖', hint: 'Enter' }) + mi('reply', '답장', { icon: '↩', hint: 'R' }) + mi('replyAll', '전체 답장', { icon: '⤶', hint: 'A' }) + mi('forward', '전달', { icon: '↪', hint: 'F' }) + '<hr>' : ''}
    ${anyUnread ? mi('read', '읽음으로 표시', { icon: '✉', hint: 'U' }) : mi('unread', '읽지 않음으로 표시', { icon: '✉', hint: 'U' })}
    ${anyStar ? mi('unstar', '별표 해제', { icon: '☆', hint: 'S' }) : mi('star', '별표', { icon: '★', hint: 'S' })}
    ${labels.length ? mi('label', '라벨 붙이기…', { icon: '🏷' }) : ''}
    <hr>
    ${L === 'INBOX' ? mi('archive', '보관 (받은편지함에서 빼기)', { icon: '🗄', hint: 'E' }) : ''}
    ${L === 'TRASH' ? mi('untrash', '휴지통에서 복원', { icon: '♻' }) : mi('trash', '삭제', { icon: '🗑', hint: 'Del', cls: 'danger' })}
    ${L === 'SPAM' ? mi('notspam', '스팸 아님', { icon: '✅' }) : mi('spam', '스팸 신고', { icon: '⚠' })}
    ${L === 'DRAFT' ? '' : mi('block', items.length > 1 ? '보낸 사람들 차단…' : '보낸 사람 차단…', { icon: '⛔', cls: 'danger' })}
    ${one ? '<hr>' + mi('fromAll', '보낸 사람 메일 모두 보기', { icon: '🔎' }) + mi('newTo', '보낸 사람에게 새 메일', { icon: '✎' }) + mi('copyAddr', '보낸 사람 주소 복사', { icon: '📋' }) + mi('eml', '원본(.eml) 저장', { icon: '🧾' }) + mi('web', 'Gmail 웹에서 열기', { icon: '🌐' }) : ''}
    ${items.length > 1 ? '<hr>' + mi('clear', '선택 해제', { icon: '✕', hint: 'Esc' }) : ''}`, async (k) => {
    const sender = one && parseAddrList(one.from)[0];
    if (k === 'open') openThread(one.key);
    else if (['reply', 'replyAll', 'forward'].includes(k)) { if (state.sel !== one.key) await openThread(one.key); openCompose({ mode: k }); }
    else if (k === 'label') labelMenu(pt, items, labels);
    else if (k === 'fromAll' && sender) { $('#search').value = `from:${sender.email}`; state.q = $('#search').value; loadList(); }
    else if (k === 'newTo' && sender) openCompose({ mode: 'new', account: one.account, to: sender.name ? `${sender.name} <${sender.email}>` : sender.email });
    else if (k === 'copyAddr' && sender) { await navigator.clipboard.writeText(sender.email).catch(() => {}); toast(`복사했습니다: ${sender.email}`); }
    else if (k === 'eml') saveEml(one);
    else if (k === 'web') window.open(`https://mail.google.com/mail/u/${encodeURIComponent(one.account)}/#all/${one.id}`, '_blank');
    else if (k === 'clear') { state.checked.clear(); renderList(); renderReader(); }
    else if (k === 'block') blockSenders(items);
    else actOn(k, items);
  });
}
/** 보낸 사람 차단: Gmail 필터로 앞으로 오는 메일을 스팸함으로 */
async function blockSenders(items) {
  const pairs = [];
  for (const t of items) {
    const a = parseAddrList(t.from)[0];
    if (a && !accs().some((x) => x.email === a.email.toLowerCase()) && !pairs.some((p) => p.account === t.account && p.email === a.email.toLowerCase())) pairs.push({ account: t.account, email: a.email.toLowerCase(), name: a.name });
  }
  if (!pairs.length) { toast('차단할 보낸 사람이 없습니다(내 계정은 차단 불가).'); return; }
  const r = await askChoice('보낸 사람 차단',
    `<p class="modal-tip">앞으로 아래 주소에서 오는 메일은 <b>스팸함</b>으로 갑니다(Gmail 필터). 차단 해제는 ⚙ → 차단한 주소에서 할 수 있습니다.</p>
     <ul class="blk-list">${pairs.map((p) => `<li><span class="dot" style="background:${acc(p.account).color}"></span>${esc(p.name ? `${p.name} <${p.email}>` : p.email)}</li>`).join('')}</ul>
     <label class="chk-row"><input type="checkbox" id="blk-old" checked> 이미 받은 메일도 스팸함으로 옮기기</label>`,
    [['cancel', '취소', 'btn-ghost'], ['ok', '차단', 'btn-primary danger-bg']], (w) => ({ old: $('#blk-old', w).checked }));
  if (r.k !== 'ok') return;
  let n = 0, moved = 0, toTrash = false;
  try {
    for (const p of pairs) {
      const f = await gm.blockSender(p.account, p.email);
      if (f.to === 'TRASH') toTrash = true;
      n++;
      if (r.old) moved += await gm.moveFromSender(p.account, p.email, f.to);
    }
    toast(`${n}개 주소를 차단했습니다${moved ? ` · 기존 메일 ${moved}개 이동` : ''}${toTrash ? ' (스팸함 지정이 거부되어 휴지통으로 가도록 설정)' : ''}.`, 7000);
    loadList({ silent: true }); refreshCounts();
  } catch (e) {
    if (e instanceof auth.AuthError) { toast('필터 권한이 필요합니다. 계정을 다시 연결(동의)한 뒤 시도하세요.', 8000); renderBanner(); renderSide(); }
    else fail(e, 'block');
  }
}
async function openBlocked() {
  const w = modal('<h3>⛔ 차단한 주소</h3><div id="blk-body" class="empty">불러오는 중…</div><div class="modal-foot"><button class="btn-primary" data-close>닫기</button></div>');
  w.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]') || e.target === w) { w.remove(); return; }
    const u = e.target.closest('[data-unblock]');
    if (u) {
      const [account, id] = u.dataset.unblock.split('|');
      try { await gm.unblock(account, id); u.closest('li').remove(); toast('차단을 풀었습니다.'); } catch (er) { fail(er, 'unblock'); }
    }
  });
  let h = '';
  for (const a of connected()) {
    try {
      const list = await gm.listBlocked(a.email);
      h += `<div class="blk-acc"><div class="ae-h"><span class="dot" style="background:${a.color}"></span>${esc(a.email)}</div>${list.length ? `<ul class="blk-list">${list.map((f) => `<li><span>${esc(f.from)}</span><small>${f.to === 'SPAM' ? '스팸함' : '휴지통'}</small><button class="btn-ghost btn-sm" data-unblock="${esc(a.email)}|${esc(f.id)}">차단 해제</button></li>`).join('')}</ul>` : '<p class="modal-tip">차단한 주소가 없습니다.</p>'}</div>`;
    } catch (e) {
      h += `<div class="blk-acc"><div class="ae-h"><span class="dot" style="background:${a.color}"></span>${esc(a.email)}</div><p class="modal-tip">${e instanceof auth.AuthError ? '필터 권한이 없습니다. 계정을 다시 연결(동의)해 주세요.' : esc(e.message)}</p></div>`;
      if (e instanceof auth.AuthError) { renderBanner(); renderSide(); }
    }
  }
  const body = $('#blk-body', w);
  if (body) { body.className = ''; body.innerHTML = h || '<p class="modal-tip">연결된 계정이 없습니다.</p>'; }
}
/** 버튼 여러 개 고르는 창 → { k, ...extra } */
function askChoice(title, html, buttons, extra) {
  return new Promise((res) => {
    const w = modal(`<h3>${title}</h3>${html}<div class="modal-foot">${buttons.map(([k, l, c]) => `<button class="${c}" data-r="${k}">${l}</button>`).join('')}</div>`);
    w.classList.add('modal-sm');
    w.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (b) { const x = extra ? extra(w) : {}; w.remove(); res({ k: b.dataset.r, ...x }); }
      else if (e.target === w) { w.remove(); res({ k: 'cancel' }); }
    });
  });
}
function labelMenu(pt, items, labels) {
  showPop(pt, `<div class="pop-h">라벨 붙이기</div>${labels.map((l) => mi(`label:${l.id}`, esc(l.name), { icon: '🏷' })).join('')}`, (k) => actOn(k, items));
}
async function saveEml(t) {
  try {
    const raw = await gm.fetchFull(t.account, t.id);
    const last = raw.messages[raw.messages.length - 1];
    const data = await gm.getRawEml(t.account, last.id);
    saveToDownloads(new Blob([b64ToBytes(data)], { type: 'message/rfc822' }), `${(t.subject || 'mail').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.eml`);
  } catch (e) { fail(e, 'eml'); }
}
function folderMenu(pt, scope, label) {
  const emails = scope === 'all' ? connected().map((a) => a.email) : [scope];
  showPop(pt, `${mi('open', '열기', { icon: '📂' })}${mi('readAll', '모두 읽음으로 표시', { icon: '✉' })}${mi('refresh', '새로 고침', { icon: '⟳' })}`, async (k) => {
    if (k === 'open') selectFolder(scope, label);
    if (k === 'refresh') { if (state.folder.scope !== scope || state.folder.label !== label) selectFolder(scope, label); else { loadList({ silent: true }); refreshCounts(); } }
    if (k === 'readAll') {
      if (!confirm(`${scope === 'all' ? '모든 계정' : scope}의 '${ALL_FOLDERS.includes(label) ? FOLDERS[label][0] : '라벨'}'을 모두 읽음으로 표시할까요?`)) return;
      toast('처리 중…', 0);
      let n = 0;
      try { for (const e of emails) n += await gm.markAllRead(e, label); } catch (err) { fail(err, 'readAll'); }
      toast(`${n}개 대화를 읽음으로 표시했습니다.`);
      if (state.folder.scope === scope && state.folder.label === label) { state.items.forEach((t) => (t.unread = false)); renderList(); }
      refreshCounts();
    }
  });
}

/* ───────── 칸 너비 조절 ───────── */
function applyWidths() {
  const ws = pref.get('wSide', 236), wl = pref.get('wList', 420);
  document.documentElement.style.setProperty('--w-side', `${ws}px`);
  document.documentElement.style.setProperty('--w-list', `${wl}px`);
}
function bindGutter(el, key, min, max, def) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startX = e.clientX, start = pref.get(key, def);
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev) => {
      const v = Math.max(min, Math.min(max, start + ev.clientX - startX));
      document.documentElement.style.setProperty(key === 'wSide' ? '--w-side' : '--w-list', `${v}px`);
      el._v = v;
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); if (el._v) pref.set(key, el._v); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
  el.addEventListener('dblclick', () => { pref.set(key, def); applyWidths(); });
}

/* ───────── 단축키 ───────── */
function onKey(e) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(state.zoom + 10); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(state.zoom - 10); return; }
    if (e.key === '0') { e.preventDefault(); setZoom(100); return; }
    if ((e.key === 'p' || e.key === 'P') && state.thread && !(cp.open && !cp.float)) { e.preventDefault(); printThread(); return; }
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (cp.open && !$('#compose').classList.contains('min') && (typing || $('#compose').contains(e.target))) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendCompose(); }
    if (e.key === 'Escape' && !$('#suggest').hidden) { $('#suggest').hidden = true; }
    return;
  }
  if (typing || e.altKey) return;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && (k === 'a' || k === 'A')) { e.preventDefault(); state.checked = new Set(state.items.map((t) => t.key)); renderList(); renderReader(); return; }
  if (e.ctrlKey || e.metaKey) return;
  const move = (d) => {
    const i = state.items.findIndex((x) => x.key === state.sel);
    const n = state.items[i < 0 ? 0 : Math.max(0, Math.min(state.items.length - 1, i + d))];
    if (n) openThread(n.key, { scroll: true });
  };
  if (k === 'c') { e.preventDefault(); openCompose({ mode: 'new' }); }
  else if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (k === '/') { e.preventDefault(); $('#search').focus(); }
  else if (k === 'Delete' || k === '#') { const t = targets(); if (t.length) actOn(state.folder.label === 'TRASH' ? 'untrash' : 'trash', t); }
  else if (k === 'e') { const t = targets(); if (t.length && state.folder.label === 'INBOX') actOn('archive', t); }
  else if (k === 'u') { const t = targets(); if (t.length) actOn(t.some((x) => x.unread) ? 'read' : 'unread', t); }
  else if (k === 's') { const t = targets(); if (t.length) actOn(t.some((x) => x.starred) ? 'unstar' : 'star', t); }
  else if (k === 'Escape') { if (state.checked.size > 1) { state.checked.clear(); renderList(); renderReader(); } else closeReader(); }
  else if (!state.thread) return;
  else if (k === 'r') { e.preventDefault(); openCompose({ mode: 'reply' }); }
  else if (k === 'a') { e.preventDefault(); openCompose({ mode: 'replyAll' }); }
  else if (k === 'f') { e.preventDefault(); openCompose({ mode: 'forward' }); }
}

/* ───────── 이벤트 연결 ───────── */
function bind() {
  document.addEventListener('keydown', onKey);
  applyWidths();
  bindGutter($('#gut-side'), 'wSide', 180, 420, 236);
  bindGutter($('#gut-list'), 'wList', 300, 900, 420);

  $('#folders').addEventListener('click', (e) => {
    const f = e.target.closest('.f-item');
    if (f) { selectFolder(f.dataset.scope, f.dataset.label); return; }
    const x = e.target.closest('[data-expand]');
    if (x) { const em = x.dataset.expand; state.expanded.has(em) ? state.expanded.delete(em) : state.expanded.add(em); pref.set('expanded', [...state.expanded]); renderSide(); }
  });
  $('#folders').addEventListener('contextmenu', (e) => {
    const f = e.target.closest('.f-item'); if (!f) return;
    e.preventDefault();
    folderMenu({ x: e.clientX, y: e.clientY }, f.dataset.scope, f.dataset.label);
  });
  document.addEventListener('click', (e) => {
    const r = e.target.closest('[data-reconnect]');
    if (r) { e.preventDefault(); doReconnect(r.dataset.reconnect); }
    if (!$('#pop').hidden && !e.target.closest('#pop, #btn-menu, [data-mact="more"], .att, [data-pal]')) closePop();
    if (!$('#suggest').hidden && !e.target.closest('#suggest')) $('#suggest').hidden = true;
    const cancel = e.target.closest('[data-cancel]');
    if (cancel) cancelSend(cancel.dataset.cancel);
  });
  document.addEventListener('contextmenu', (e) => { if (!$('#pop').hidden && !e.target.closest('#pop')) closePop(); }, true);
  $('#btn-side').onclick = () => document.body.classList.add('drawer');
  $('#btn-side-close').onclick = $('#scrim').onclick = () => document.body.classList.remove('drawer');
  $('#btn-compose').onclick = $('#fab').onclick = () => { document.body.classList.remove('drawer'); openCompose({ mode: 'new' }); };
  $('#btn-compose-pop').onclick = () => { document.body.classList.remove('drawer'); popOut(() => openCompose({ mode: 'new' })); };
  $('#cp-pop').onclick = (e) => { e.stopPropagation(); popOut(); };
  $('#btn-add-acc').onclick = () => doAdd();
  $('#zoom-in').onclick = () => setZoom(state.zoom + 10);
  $('#zoom-out').onclick = () => setZoom(state.zoom - 10);
  $('#zoom-range').oninput = (e) => setZoom(Number(e.target.value));
  $('#zoom-val').onclick = () => setZoom(100);
  $('#read-wrap').addEventListener('wheel', onZoomWheel, { passive: false });
  setZoom(state.zoom);
  $('#btn-print').onclick = () => printThread();
  $('#btn-theme').onclick = () => { setTheme(isDark() ? 'light' : 'dark'); syncThemeIcon(); };
  syncThemeIcon();
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeIcon); } catch { /* 무시 */ }
  $('#btn-install').onclick = $('#btn-install2').onclick = () => doInstall();
  $('#notif-yes').onclick = () => enableNotif();
  $('#notif-no').onclick = () => { pref.set('notifLater', true); syncNotifAsk(); };
  $('#btn-menu').onclick = (e) => ($('#pop').hidden ? openMenu(e.currentTarget) : closePop());
  $('#btn-refresh').onclick = () => { loadList({ silent: !!state.items.length }); refreshCounts(); };
  let qTimer;
  $('#search').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = $('#search').value; loadList(); }, 450); });
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(qTimer); state.q = $('#search').value; loadList(); } });
  $('#chip-unread').onclick = () => { state.unreadOnly = !state.unreadOnly; loadList(); };

  // 목록: 클릭·Ctrl+클릭·Shift+클릭·오른쪽 클릭
  $('#list').addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); }); // 글자 선택 방지
  $('#list').addEventListener('click', (e) => {
    if (e.target.closest('#btn-more')) { loadList({ append: true }); return; }
    const li = e.target.closest('.item'); if (!li) return;
    const key = li.dataset.key;
    const t = state.items.find((x) => x.key === key);
    const b = e.target.closest('[data-iact]');
    if (b) { e.stopPropagation(); actOn(b.dataset.iact, state.checked.has(key) && state.checked.size > 1 ? checkedItems() : [t]); return; }
    if (e.ctrlKey || e.metaKey) {
      if (state.checked.size <= 1 && state.sel && !state.checked.size) state.checked.add(state.sel);
      state.checked.has(key) ? state.checked.delete(key) : state.checked.add(key);
      state.anchor = key;
      renderList(); renderReader();
      return;
    }
    if (e.shiftKey && state.anchor) {
      const keys = state.items.map((x) => x.key);
      const a = keys.indexOf(state.anchor), z = keys.indexOf(key);
      if (a >= 0 && z >= 0) {
        state.checked = new Set(keys.slice(Math.min(a, z), Math.max(a, z) + 1));
        renderList(); renderReader();
        return;
      }
    }
    if (state.folder.label === 'DRAFT') { openDraftItem(t); return; }
    openThread(key);
  });
  $('#list').addEventListener('dblclick', (e) => { const li = e.target.closest('.item'); if (li && innerWidth > 860) { /* 이미 열림 */ } });
  $('#list').addEventListener('contextmenu', (e) => {
    const li = e.target.closest('.item'); if (!li) return;
    e.preventDefault();
    const key = li.dataset.key;
    if (!state.checked.has(key)) { state.checked = new Set([key]); state.anchor = key; renderList(); if (state.sel !== key && state.checked.size <= 1) renderReader(); }
    listMenu({ x: e.clientX, y: e.clientY });
  });
  $('#list').addEventListener('scroll', (e) => {
    const el = e.currentTarget;
    if (!state.loading && el.scrollTop + el.clientHeight > el.scrollHeight - 300 && Object.values(state.pages).some(Boolean)) loadList({ append: true });
  });

  // 읽기 영역
  const pr = document.querySelector('.pane-read');
  pr.addEventListener('click', (e) => {
    if (e.target.closest('#compose')) return;
    const go = e.target.closest('[data-go="list"]');
    if (go) { $('#app').dataset.view = 'list'; return; }
    const pa = e.target.closest('[data-popact]');
    if (pa) { const k = pa.dataset.popact; popOut(() => openCompose({ mode: k })); return; }
    const bulk = e.target.closest('[data-bulk]');
    if (bulk) { const k = bulk.dataset.bulk; if (k === 'clear') { state.checked.clear(); renderList(); renderReader(); } else actOn(k, checkedItems()); return; }
    const a = e.target.closest('[data-act]');
    if (a && !a.disabled) {
      const k = a.dataset.act;
      const t = current();
      if (['reply', 'replyAll', 'forward'].includes(k)) openCompose({ mode: k });
      else if (k === 'unread') { actOn('unread', [t]); closeReader(); }
      else if (k === 'star') actOn(t?.starred ? 'unstar' : 'star', [t]);
      else if (k === 'trash') actOn(state.folder.label === 'TRASH' ? 'untrash' : 'trash', [t]);
      else actOn(k, [t]);
      return;
    }
    const msgEl = e.target.closest('.msg');
    if (!msgEl) return;
    const m = state.thread?.messages.find((x) => x.id === msgEl.dataset.mid);
    const ma = e.target.closest('[data-mact]');
    if (ma && m) {
      if (ma.dataset.mact === 'trash1' || ma.dataset.mact === 'untrash1') { trashOne(m, ma.dataset.mact === 'untrash1'); return; }
      if (ma.dataset.mact === 'reply') openCompose({ mode: 'reply', msg: m });
      else showPop(ma, mi('reply', '답장', { icon: '↩' }) + mi('replyAll', '전체 답장', { icon: '⤶' }) + mi('forward', '전달', { icon: '↪' }) + '<hr>' + mi('eml', '원본(.eml) 저장', { icon: '🧾' }) + mi('orig', 'Gmail 웹에서 열기', { icon: '🌐' }), async (x) => {
        if (x === 'orig') window.open(`https://mail.google.com/mail/u/${encodeURIComponent(m.account)}/#all/${m.threadId}`, '_blank');
        else if (x === 'eml') { try { const d = await gm.getRawEml(m.account, m.id); saveToDownloads(new Blob([b64ToBytes(d)], { type: 'message/rfc822' }), `${(m.subject || 'mail').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.eml`); } catch (er) { fail(er, 'eml'); } }
        else openCompose({ mode: x, msg: m });
      });
      return;
    }
    const dr = e.target.closest('[data-draft]');
    if (dr && m) { if (dr.dataset.draft === 'edit') openDraftMsg(m, state.thread); else deleteDraftMsg(m); return; }
    if (e.target.closest('[data-showimg]')) { fillBody(msgEl, true); return; }
    if (e.target.closest('[data-attall]') && m) { attSaveAll(m); return; }
    const att = e.target.closest('[data-att]');
    if (att && m) { if (e.detail >= 2) { closePop(); attOpen(m, m.attachments[Number(att.dataset.att)]); } else attMenu(att, m, m.attachments[Number(att.dataset.att)]); return; }
    if (e.target.closest('[data-toggle]')) {
      const opened = msgEl.classList.toggle('collapsed') === false;
      state.thread.open = state.thread.open || new Set();
      if (opened) { state.thread.open.add(m.id); fillBody(msgEl); }
    }
  });
  pr.addEventListener('contextmenu', (e) => {
    const att = e.target.closest('[data-att]'); if (!att) return;
    const msgEl = e.target.closest('.msg');
    const m = state.thread?.messages.find((x) => x.id === msgEl?.dataset.mid);
    if (!m) return;
    e.preventDefault();
    attMenu({ x: e.clientX, y: e.clientY }, m, m.attachments[Number(att.dataset.att)]);
  });

  // 쓰기
  edMain = setupEditor($('#cp-editor'), { onFiles: addFiles });
  edSig = setupEditor($('#cp-sig'), { onFiles: () => toast('서명에는 그림만 넣을 수 있습니다.') });
  $('#cp-sig').addEventListener('input', syncSigBox);
  $('#cp-tools').innerHTML = toolbarHtml();
  bindToolbar($('#cp-tools'), cpEditor);
  $('#cp-draft').onclick = () => saveDraft();
  $('#cp-side').onclick = (e) => { e.stopPropagation(); setSplit(!$('.pane-read').classList.contains('split')); };
  // 나란히 보기 경계 (쓰기 창 너비)
  (() => {
    const g = $('#gut-cp');
    const set = (v) => document.documentElement.style.setProperty('--w-cp', `${v}px`);
    const saved = pref.get('wCp', 0); if (saved) set(saved);
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault(); g.setPointerCapture(e.pointerId); document.body.classList.add('resizing');
      const right = $('.pane-read').getBoundingClientRect().right, total = $('.pane-read').getBoundingClientRect().width;
      const move = (ev) => { const v = Math.max(360, Math.min(total - 300, right - ev.clientX)); set(v); g._v = v; };
      const up = () => { g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); if (g._v) pref.set('wCp', g._v); };
      g.addEventListener('pointermove', move); g.addEventListener('pointerup', up);
    });
    g.addEventListener('dblclick', () => { document.documentElement.style.removeProperty('--w-cp'); pref.set('wCp', 0); });
  })();
  $('#cpq-toggle').onclick = () => renderQuoteView($('#cp-quote-view').hidden);
  $('#cpq-edit').onclick = () => { setQuoteMode('edit'); cp.dirty = true; $('#cp-quote-edit').focus(); };
  $('#cpq-remove').onclick = () => { setQuoteMode('off'); cp.dirty = true; };
  $('#cpq-restore').onclick = () => { cp.quoteHtml = cp.quoteOrig?.html || cp.quoteHtml; cp.quoteText = cp.quoteOrig?.text || cp.quoteText; setQuoteMode('on'); cp.dirty = true; };
  $('#cp-close').onclick = (e) => { e.stopPropagation(); closeCompose(); };
  $('#cp-min').onclick = (e) => { e.stopPropagation(); $('#compose').classList.toggle('min'); edMain.hide(); };
  $('#cp-float').onclick = (e) => { e.stopPropagation(); setCpFloat(!cp.float); edMain.hide(); if (!cp.float) $('#app').dataset.view = 'read'; $('#cp-side').hidden = !state.thread || cp.float; };
  $('.cp-head').onclick = () => $('#compose').classList.remove('min');
  $('#cp-ccbtn').onclick = () => { $$('#compose [data-cc]').forEach((r) => (r.hidden = false)); $('#cp-cc').focus(); };
  $('#cp-send').onclick = sendCompose;
  $('#cp-attach').onclick = () => $('#file-attach').click();
  $('#file-attach').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
  $('#cp-from').onchange = () => {
    const next = $('#cp-from').value;
    const prevSig = sigHtml(acc(cp.lastFrom || cp.account));
    if ($('#cp-sig').innerHTML === prevSig || !$('#cp-sig').textContent.trim()) $('#cp-sig').innerHTML = sigHtml(acc(next));
    cp.lastFrom = next;
    syncSigBox();
    $('#cp-msg').textContent = next !== cp.account && cp.threadId ? '다른 계정으로 보내면 새 대화로 보내집니다.' : '';
  };
  $('#cp-atts').onclick = (e) => {
    const rm = e.target.closest('[data-rm]')?.dataset.rm; if (!rm) return;
    if (rm[0] === 'f') cp.files.splice(Number(rm.slice(1)), 1); else cp.origAtts[Number(rm.slice(1))].keep = false;
    renderCpAtts();
  };
  $('#compose').addEventListener('input', () => (cp.dirty = true));
  $('#compose').addEventListener('paste', (e) => {
    if (e.target.closest('[contenteditable]')) return; // 편집기가 처리
    const fs = [...(e.clipboardData?.files || [])];
    if (fs.length) { e.preventDefault(); addFiles(fs); }
  });
  for (const id of ['#cp-to', '#cp-cc', '#cp-bcc']) {
    const el = $(id);
    el.addEventListener('input', () => suggest(el));
    el.addEventListener('keydown', (e) => {
      const box = $('#suggest');
      if (box.hidden) return;
      const lis = $$('li', box);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : -1) + lis.length) % lis.length;
        lis.forEach((li, i) => li.classList.toggle('on', i === sugIdx));
      } else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSuggest(lis[sugIdx]); }
    });
    el.addEventListener('blur', () => setTimeout(() => ($('#suggest').hidden = true), 200));
  }
  $('#suggest').addEventListener('mousedown', (e) => { e.preventDefault(); pickSuggest(e.target.closest('li')); });

  // 파일 끌어놓기 → 첨부 (편집기 위에 놓은 그림은 본문에 들어감)
  let dragN = 0;
  const dropOff = () => { dragN = 0; $('#drop').hidden = true; };
  document.addEventListener('ybm-drop-done', dropOff);
  window.addEventListener('dragenter', (e) => { if (cp.open && e.dataTransfer?.types?.includes('Files')) { dragN++; $('#drop').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--dragN <= 0) dropOff(); });
  window.addEventListener('dragover', (e) => { if (cp.open) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (!cp.open) return; e.preventDefault(); dropOff(); addFiles([...e.dataTransfer.files]); });

  // 처음 화면
  $('#gate').addEventListener('click', (e) => {
    if (e.target.id === 'gate-cid-ok') {
      const v = $('#gate-cid').value.trim();
      if (!/\.apps\.googleusercontent\.com$/.test(v)) { gateMsg('형식 확인: …apps.googleusercontent.com 으로 끝나야 합니다.'); return; }
      auth.setClientId(v); gate(accs().length ? 'connect' : 'add');
    }
    if (e.target.id === 'gate-add') doAdd();
    if (e.target.id === 'gate-cid-reset') gate('client');
    if (e.target.id === 'gate-skip') { gateSkipped = true; gate(null); afterConnect(); }
  });

  // 만료 직전이면, 다음 클릭 때 조용히 새 토큰 받기 (팝업은 클릭 안에서만 허용)
  const tried = new Map();
  document.addEventListener('pointerdown', () => {
    if (DEMO || DESK) return;
    for (const a of accs()) {
      const left = auth.tokenLeft(a.email);
      if (left > 0 && left < 8 * 60_000 && !auth.isReconnecting(a.email) && Date.now() - (tried.get(a.email) || 0) > 5 * 60_000) {
        tried.set(a.email, Date.now());
        auth.reconnect(a.email).then(() => renderBanner()).catch(() => {});
        break;
      }
    }
  }, true);

  auth.onChange(() => { renderSide(); renderBanner(); });
  window.addEventListener('online', () => loadList({ silent: true }));
  window.addEventListener('offline', () => setSync('offline', '● 오프라인 (저장본 표시 중)'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && started && connected().length) { loadList({ silent: true }); refreshCounts(); } });
  setInterval(() => {
    if (document.visibilityState !== 'visible' || !started || state.loading) return;
    if (!connected().length) { renderBanner(); renderSide(); return; }
    loadList({ silent: true });
    refreshCounts();
  }, 90_000);
  setInterval(() => { if (!CPWIN && connected().length) { bg.ranOnce = false; runPrefetch(); } }, 15 * 60_000);
  setInterval(() => { if (started && connected().length) checkNewMail(); }, 60_000);
  if (DESK) setInterval(() => auth.refreshAllSilently().then(() => { renderBanner(); renderSide(); }), 4 * 60_000);
  window.__ybmCompose = () => openCompose({ mode: 'new' });
}

/* ───────── 서비스 워커 (설치·새 버전 안내) ───────── */
function registerSW() {
  if (!('serviceWorker' in navigator) || location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).then((reg) => {
    const ask = (w) => toast('새 버전이 있습니다.', 0, { label: '새로고침', run: () => w.postMessage('skipWaiting') });
    if (reg.waiting && navigator.serviceWorker.controller) ask(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) ask(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch((e) => console.warn('[YB-Mail] 서비스 워커', e));
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && !outbox.length) { reloaded = true; location.reload(); } });
}

/* ───────── 시작 ───────── */
async function boot() {
  $('#version').textContent = DEMO ? `v${VERSION} · 점검용` : `v${VERSION}`;
  state.unread = pref.get('unread', {});
  bind();
  syncInstall();
  document.body.classList.remove('booting');
  if (CPWIN) {
    // 별도 쓰기 창: 본 창에서 넘겨준 내용으로 쓰기 화면만 띄움
    document.body.classList.add('cp-window');
    cp.float = false;
    document.title = '메일 쓰기 – YB-Mail';
    if (DEMO) { const demo = await import('./demo.js'); demo.initDemo(); gm.useBackend(demo.demoBackend); }
    let snap = null;
    try { snap = window.opener?.__ybmTakeDraft?.(CPWIN) || null; } catch { /* 무시 */ }
    await openCompose(snap ? { snapshot: snap } : { mode: 'new' });
    cp.dirty = !!snap && snap.mode !== 'new';
    auth.loadGis().catch(() => {});
    return;
  }
  cache.persist();
  if (DEMO) {
    await cache.clearAll();
    const demo = await import('./demo.js');
    demo.initDemo();
    gm.useBackend(demo.demoBackend);
    auth.demoSetup(demo.DEMO_ACCOUNTS);
    window.__ybCheck = checkNewMail;
    afterConnect();
    return;
  }
  if (DESK) {
    document.body.classList.add('desktop');
    await auth.desktopRestore();
    await auth.refreshAllSilently(); // 저장된 연결로 바로 (1시간 재연결 없음)
  }
  renderSide();
  renderBanner();
  if (!auth.clientId()) gate('client');
  else if (!accs().length) gate('add');
  else {
    // 연결 전이라도 저장본으로 바로 보여 줌
    started = true;
    selectFolder(state.folder.scope, state.folder.label);
    if (!connected().length) gate('connect'); else afterConnect();
  }
  auth.loadGis().catch((e) => { gateMsg(e.message); toast(e.message, 0); });
  registerSW();
  syncInstall();
  if (new URLSearchParams(location.search).has('compose')) setTimeout(() => openCompose({ mode: 'new' }), 600);
}
boot();
