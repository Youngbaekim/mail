// YB-Mail — 두 Google 계정(학교·개인)을 한 화면에서 쓰는 메일 앱
import './style.css';
import { getTheme, setTheme } from './theme.js';
import * as auth from './auth.js';
import * as gm from './gmail.js';
import { buildRaw, parseAddrList, validEmail, escHtml, textToHtml, htmlToText, b64ToBytes } from './mime.js';
import { ACCOUNT_COLORS } from './config.js';

const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
const DEMO = new URLSearchParams(location.search).has('demo');
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = escHtml;
const PFX = DEMO ? 'ybm-demo-' : 'ybm-';
const pref = {
  get: (k, d) => { try { const v = localStorage.getItem(PFX + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(PFX + k, JSON.stringify(v)); } catch { /* 무시 */ } },
};

const FOLDERS = {
  INBOX: ['받은편지함', '📥'],
  STARRED: ['별표', '★'],
  SENT: ['보낸편지함', '📤'],
  ALL: ['전체 보관함', '🗂'],
  SPAM: ['스팸', '⚠'],
  TRASH: ['휴지통', '🗑'],
};
const ALL_FOLDERS = ['INBOX', 'STARRED', 'SENT', 'ALL', 'SPAM', 'TRASH'];
const ACC_MAIN = ['INBOX', 'SENT'];
const ACC_MORE = ['STARRED', 'ALL', 'SPAM', 'TRASH'];

const state = {
  folder: pref.get('folder', { scope: 'all', label: 'INBOX' }),
  q: '',
  unreadOnly: false,
  items: [],
  pages: {},          // email → 다음 쪽 토큰(null이면 끝)
  loading: false,
  loadSeq: 0,
  sel: null,          // 선택한 스레드 key
  thread: null,       // 읽는 중인 스레드
  unread: {},         // email → 받은편지함 안읽음 수
  labels: {},         // email → 사용자 라벨
  expanded: new Set(pref.get('expanded', [])),
  showImages: pref.get('showImages', true),
  authErr: new Set(), // 다시 연결 필요한 계정
};

/* ───────── 공용 ───────── */
const accs = () => auth.accounts();
const acc = (email) => accs().find((a) => a.email === email) || { email, color: '#888', label: '?' };
const connected = () => accs().filter((a) => auth.token(a.email));
const accLabel = (a) => a.label || a.email.split('@')[0];

let toastTimer;
function toast(msg, ms = 3200, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function setSync(s, text) { const el = $('#sync'); el.dataset.s = s; el.textContent = text; }
function fail(e, where = '') {
  console.warn('[YB-Mail]', where, e);
  if (e instanceof auth.AuthError) { state.authErr.add(e.email); renderBanner(); renderSide(); return; }
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
    for (const k of ['INBOX', 'STARRED', 'SENT']) h += fItem('all', k, k === 'INBOX' ? '통합 받은편지함' : FOLDERS[k][0], FOLDERS[k][1], k === 'INBOX' ? total : 0);
    h += '</div>';
  }
  for (const a of list) {
    const off = !auth.token(a.email);
    const exp = state.expanded.has(a.email);
    h += `<div class="f-sec" style="--acc:${a.color}"><div class="f-sec-h"><span class="dot" style="background:${a.color}"></span><span class="em" title="${esc(a.email)}">${esc(a.email)}</span>${off ? `<button class="acc-state off" data-reconnect="${esc(a.email)}" title="눌러서 다시 연결">연결</button>` : ''}</div>`;
    for (const k of ACC_MAIN) h += fItem(a.email, k, FOLDERS[k][0], FOLDERS[k][1], k === 'INBOX' ? state.unread[a.email] : 0);
    h += `<button class="f-more" data-expand="${esc(a.email)}">${exp ? '▾ 접기' : '▸ 별표·보관함·휴지통·라벨'}</button>`;
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
}

function selectFolder(scope, label) {
  if (scope !== 'all' && !accs().some((a) => a.email === scope)) scope = 'all';
  if (scope === 'all' && !ALL_FOLDERS.includes(label)) label = 'INBOX';
  state.folder = { scope, label };
  pref.set('folder', state.folder);
  state.sel = null;
  state.thread = null;
  document.body.classList.remove('drawer');
  renderSide();
  renderReader();
  loadList();
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
  const sent = state.folder.label === 'SENT';
  let h = '', grp = '';
  for (const t of state.items) {
    const g = dayGroup(t.date);
    if (g !== grp) { grp = g; h += `<li class="day-h">${g}</li>`; }
    const a = acc(t.account);
    const who = sent ? `받는 사람: ${gm.shortName(t.to) || '(없음)'}` : (t.senders.length > 1 ? t.senders.slice(-3).join(', ') : gm.shortName(t.from) || t.senders[0] || '(알 수 없음)');
    h += `<li class="item${t.unread ? ' unread' : ''}${t.key === state.sel ? ' active' : ''}" data-key="${esc(t.key)}" style="--acc:${a.color}">
      <div class="i-main">
        <div class="i-row"><span class="i-from">${esc(who)}</span>${t.count > 1 ? `<span class="i-cnt">${t.count}</span>` : ''}<span class="i-tags">${t.hasAttach ? '📎' : ''}${t.starred ? '<span class="i-star">★</span>' : ''}</span><span class="i-date">${shortDate(t.date)}</span></div>
        <div class="i-row"><span class="i-subj">${esc(t.subject)}</span>${multi ? `<span class="acc-tag">${esc(accLabel(a))}</span>` : ''}</div>
        <div class="i-snip">${esc(t.snippet)}</div>
      </div>
      <div class="i-acts">
        ${state.folder.label === 'INBOX' ? '<button data-iact="archive" title="보관">🗄</button>' : ''}
        <button data-iact="trash" title="${state.folder.label === 'TRASH' ? '복원' : '삭제'}">${state.folder.label === 'TRASH' ? '♻' : '🗑'}</button>
        <button data-iact="unread" title="${t.unread ? '읽음으로' : '읽지 않음으로'}">${t.unread ? '✉' : '✉'}</button>
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
  const seq = ++state.loadSeq;
  const f = state.folder;
  const targets = (f.scope === 'all' ? accs() : accs().filter((a) => a.email === f.scope)).filter((a) => auth.token(a.email));
  if (!append) { if (!silent) { state.items = []; state.pages = {}; } }
  state.loading = true;
  if (!silent) renderList();
  setSync('pending', '● 불러오는 중…');
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
    if (r.status === 'rejected') { err++; fail(r.reason, 'list'); if (silent) keep.push(...state.items.filter((t) => t.account === targets[i].email)); continue; }
    if (!r.value) continue;
    const { email, threads, nextPageToken } = r.value;
    if (silent && !append) {
      // 새로 받은 첫 쪽 + 그보다 오래된 기존 항목
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
  state.items = keep.sort((a, b) => b.date - a.date);
  state.pages = pages;
  for (const a of targets) if (!auth.token(a.email)) state.authErr.add(a.email);
  renderList();
  renderBanner();
  if (!navigator.onLine) setSync('offline', '● 오프라인');
  else if (err) setSync('error', `● 일부 계정 오류 (${err})`);
  else setSync('ok', `● ${new Date().toTimeString().slice(0, 5)} 확인`);
}

async function refreshCounts() {
  const list = accs().filter((a) => auth.token(a.email));
  await Promise.allSettled(list.map(async (a) => {
    state.unread[a.email] = await gm.unreadCount(a.email, 'INBOX');
    if (!state.labels[a.email]) state.labels[a.email] = await gm.listLabels(a.email);
  }));
  renderSide();
}

/* ───────── 3열: 읽기 ───────── */
const current = () => state.items.find((t) => t.key === state.sel) || null;

function setReadButtons() {
  const t = current() || (state.thread && { starred: state.thread.messages.some((m) => m.labelIds.includes('STARRED')) });
  const on = !!state.thread;
  $$('.read-head [data-act]').forEach((b) => (b.disabled = !on));
  const star = $('.read-head [data-act="star"]');
  star.classList.toggle('on', !!t?.starred);
  star.textContent = t?.starred ? '★' : '☆';
  const tr = $('.read-head [data-act="trash"]');
  tr.textContent = state.folder.label === 'TRASH' ? '♻' : '🗑';
  tr.title = state.folder.label === 'TRASH' ? '휴지통에서 복원' : '삭제 (Del) — 휴지통으로';
  $('.read-head [data-act="archive"]').hidden = state.folder.label !== 'INBOX';
}

function renderReader() {
  const th = state.thread;
  setReadButtons();
  $('#reader').hidden = !th;
  $('#empty-read').hidden = !!th;
  if (!th) { $('#reader').innerHTML = ''; return; }
  const a = acc(th.account);
  const msgs = th.messages;
  const subject = msgs[0]?.subject || '(제목 없음)';
  let h = `<h2 class="r-subject">${esc(subject)}<span class="acc-tag" style="--acc:${a.color}">${esc(a.email)}</span></h2>`;
  msgs.forEach((m, i) => {
    const last = i === msgs.length - 1;
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
          <div class="m-snip">${esc(m.snippet)}</div>
        </div>
        <div class="m-date">${longDate(m.date)}</div>
        <div class="m-quick"><button data-mact="reply" title="이 메일에 답장">↩</button><button data-mact="more" title="더 보기">⋯</button></div>
      </div>
      <div class="m-body">
        <div class="m-imgnote"></div>
        <iframe class="m-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" title="메일 본문"></iframe>
        ${files.length ? `<div class="atts">${files.map((x) => attChip(m, x)).join('')}</div>` : ''}
      </div>
    </article>`;
  });
  h += `<div class="r-reply"><button class="btn-ghost" data-act="reply">↩ 답장</button><button class="btn-ghost" data-act="replyAll">⤶ 전체 답장</button><button class="btn-ghost" data-act="forward">↪ 전달</button></div>`;
  $('#reader').innerHTML = h;
  $$('#reader .msg').forEach((el) => { if (!el.classList.contains('collapsed')) fillBody(el); });
}

function attChip(m, x) {
  const idx = m.attachments.indexOf(x);
  return `<button class="att" data-att="${idx}" title="${esc(x.filename)} — 눌러서 열기·받기"><span class="a-ic">${fileIcon(x.mimeType, x.filename)}</span><span class="a-nm">${esc(x.filename)}</span><span class="a-sz">${sizeText(x.size)}</span></button>`;
}

const PALETTE = ['#5b7fbf', '#3f9b7a', '#c0703a', '#8f5fbf', '#bf5b7f', '#4d9bb3', '#9a8a3a', '#6b7a8f'];
function colorOf(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }

const FRAME_CSS = `body{margin:0;padding:8px 12px 10px;font-family:'Pretendard Variable',Pretendard,'Malgun Gothic','Apple SD Gothic Neo',sans-serif;font-size:14.5px;line-height:1.6;color:#16202b;word-break:break-word;overflow-wrap:anywhere;overflow-x:auto}
img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}
blockquote{margin:0 0 0 .8ex;border-left:2px solid #c9d1db;padding-left:1ex;color:#4a5560}
a{color:#1a56c4}.ybm-quote-toggle{display:inline-block;margin:6px 0;padding:0 8px;border:1px solid #ccd3dc;border-radius:8px;background:#eef1f5;color:#5a6774;font-size:13px;cursor:pointer;line-height:18px}`;

/** 메일 본문 HTML 정리: 스크립트·외부 실행 요소 제거, 외부 그림 처리 */
function cleanHtml(m, showImages) {
  const src = m.html || `<div style="white-space:normal">${textToHtml(m.text || '')}</div>`;
  const d = new DOMParser().parseFromString(src, 'text/html');
  d.querySelectorAll('script,iframe,object,embed,frame,frameset,meta[http-equiv],link:not([rel~="stylesheet"]),base').forEach((n) => n.remove());
  d.querySelectorAll('*').forEach((n) => { for (const at of [...n.attributes]) if (/^on/i.test(at.name) || /^\s*javascript:/i.test(at.value)) n.removeAttribute(at.name); });
  let blocked = 0;
  if (!showImages) {
    d.querySelectorAll('img[src^="http"], img[srcset]').forEach((img) => { img.dataset.src = img.getAttribute('src') || ''; img.removeAttribute('src'); img.removeAttribute('srcset'); blocked++; });
  }
  // 이전 메일 인용(Gmail·Outlook 형식) 접기
  const q = d.querySelector('.gmail_quote, #divRplyFwdMsg, #appendonsend, blockquote[type="cite"]');
  if (q && q.parentNode && (m.html ? true : false)) {
    const wrap = d.createElement('details');
    const sum = d.createElement('summary');
    sum.className = 'ybm-quote-toggle';
    sum.textContent = '⋯ 이전 내용';
    wrap.append(sum);
    let n = q.id === 'appendonsend' || q.id === 'divRplyFwdMsg' ? q : q;
    n.parentNode.insertBefore(wrap, n);
    while (wrap.nextSibling) wrap.append(wrap.nextSibling);
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
      const data = x.data || await gm.getAttachment(m.account, m.id, x.attachmentId);
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
    const fit = () => { frame.style.height = Math.max(60, doc.documentElement.scrollHeight + 4) + 'px'; };
    fit();
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

async function openThread(key, { fromList = true } = {}) {
  const t = state.items.find((x) => x.key === key);
  if (!t) return;
  state.sel = key;
  $$('#list .item').forEach((li) => li.classList.toggle('active', li.dataset.key === key));
  $('#app').dataset.view = 'read';
  state.thread = null;
  setReadButtons();
  $('#reader').hidden = false;
  $('#empty-read').hidden = true;
  $('#reader').innerHTML = '<div class="empty">불러오는 중…</div>';
  try {
    const th = await gm.getThread(t.account, t.id);
    if (state.sel !== key) return;
    state.thread = th;
    th.messages.forEach((m) => { learn(m.from, 1); if (isMine(m.from)) { learn(m.to, 2); learn(m.cc, 1); } });
    renderReader();
    $('#read-wrap').scrollTop = 0;
    if (t.unread) {
      t.unread = false;
      state.unread[t.account] = Math.max(0, (state.unread[t.account] || 1) - 1);
      renderList(); renderSide();
      gm.modifyThread(t.account, t.id, [], ['UNREAD']).catch((e) => fail(e, 'read'));
    }
  } catch (e) {
    fail(e, 'thread');
    if (state.sel === key) $('#reader').innerHTML = `<div class="empty">메일을 불러오지 못했습니다.<br>${esc(e.message || '')}</div>`;
  }
  if (!fromList) $$('#list .item.active')[0]?.scrollIntoView({ block: 'nearest' });
}

/* ───────── 보관·삭제·읽음·별표 ───────── */
async function act(kind, t = current()) {
  if (!t) return;
  const label = state.folder.label;
  const removeFromList = (kind === 'archive' && label === 'INBOX') || kind === 'trash' || (kind === 'star' && label === 'STARRED' && t.starred);
  const idx = state.items.indexOf(t);
  const restore = () => { if (!state.items.includes(t)) { state.items.splice(Math.min(idx, state.items.length), 0, t); renderList(); } };
  try {
    if (kind === 'archive') {
      if (removeFromList) dropItem(t);
      if (t.unread) { state.unread[t.account] = Math.max(0, (state.unread[t.account] || 1) - 1); renderSide(); }
      await gm.modifyThread(t.account, t.id, [], ['INBOX']);
      toast('보관했습니다.', 5000, { label: '되돌리기', run: async () => { await gm.modifyThread(t.account, t.id, ['INBOX'], []); restore(); refreshCounts(); } });
    } else if (kind === 'trash') {
      dropItem(t);
      if (label === 'TRASH') {
        await gm.untrashThread(t.account, t.id);
        toast('휴지통에서 복원했습니다.');
      } else {
        if (t.unread && label === 'INBOX') { state.unread[t.account] = Math.max(0, (state.unread[t.account] || 1) - 1); renderSide(); }
        await gm.trashThread(t.account, t.id);
        toast('휴지통으로 옮겼습니다.', 5000, { label: '되돌리기', run: async () => { await gm.untrashThread(t.account, t.id); restore(); refreshCounts(); } });
      }
    } else if (kind === 'unread') {
      t.unread = !t.unread;
      if (label === 'INBOX' || t.labelIds.includes('INBOX')) { state.unread[t.account] = Math.max(0, (state.unread[t.account] || 0) + (t.unread ? 1 : -1)); renderSide(); }
      renderList();
      await gm.modifyThread(t.account, t.id, t.unread ? ['UNREAD'] : [], t.unread ? [] : ['UNREAD']);
      if (t.unread && state.sel === t.key) { closeReader(); }
    } else if (kind === 'star') {
      t.starred = !t.starred;
      if (removeFromList) dropItem(t); else renderList();
      setReadButtons();
      await gm.modifyThread(t.account, t.id, t.starred ? ['STARRED'] : [], t.starred ? [] : ['STARRED']);
    }
  } catch (e) { fail(e, kind); restore(); }
}
function dropItem(t) {
  const i = state.items.indexOf(t);
  if (i < 0) return;
  state.items.splice(i, 1);
  if (state.sel === t.key) {
    const next = state.items[i] || state.items[i - 1];
    if (next && window.innerWidth > 860) { renderList(); openThread(next.key); return; }
    closeReader();
  }
  renderList();
}
function closeReader() {
  state.sel = null;
  state.thread = null;
  $('#app').dataset.view = 'list';
  renderReader();
  renderList();
}

/* ───────── 첨부파일 열기·받기 ───────── */
async function openAttachment(m, x) {
  const viewable = /^image\/|pdf|^text\/plain/.test(x.mimeType);
  const win = viewable ? window.open('', '_blank') : null;
  try {
    toast(`'${x.filename}' 받는 중…`, 0);
    const data = x.data || await gm.getAttachment(m.account, m.id, x.attachmentId);
    const blob = new Blob([b64ToBytes(data)], { type: x.mimeType });
    const url = URL.createObjectURL(blob);
    if (win) win.location.href = url;
    else {
      const a = document.createElement('a');
      a.href = url; a.download = x.filename;
      document.body.append(a); a.click(); a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    $('#toast').hidden = true;
  } catch (e) { win?.close(); fail(e, 'att'); }
}

/* ───────── 메일 쓰기 ───────── */
const cp = { open: false, mode: 'new', account: null, threadId: null, inReplyTo: '', references: '', quoteHtml: '', quoteText: '', files: [], origAtts: [], dirty: false };

function fromOptions(sel) {
  return accs().map((a) => `<option value="${esc(a.email)}"${a.email === sel ? ' selected' : ''}>${esc(a.name ? `${a.name} <${a.email}>` : a.email)}${auth.token(a.email) ? '' : ' (연결 필요)'}</option>`).join('');
}
const prefix = (p, s) => (new RegExp(`^\\s*(${p}|${p === 'Re' ? '회신|답장|RE' : '전달|FW|Fw'})\\s*:`, 'i').test(s) ? s : `${p}: ${s}`);
const withoutMe = (list, me) => parseAddrList(list).filter((x) => x.email.toLowerCase() !== me && !accs().some((a) => a.email === x.email.toLowerCase()));
const joinAddr = (arr) => arr.map((x) => (x.name ? `${x.name} <${x.email}>` : x.email)).join(', ');

function quoteParts(m, fwd) {
  const body = m.html ? cleanHtml(m, true).html : textToHtml(m.text || '');
  const text = m.text || htmlToText(m.html || '');
  if (fwd) {
    const head = `---------- 전달된 메일 ----------\n보낸 사람: ${m.from}\n날짜: ${longDate(m.date)}\n제목: ${m.subject}\n받는 사람: ${m.to}${m.cc ? `\n참조: ${m.cc}` : ''}\n`;
    return {
      html: `<div class="gmail_quote"><div>${textToHtml(head)}</div><br>${body}</div>`,
      text: `${head}\n${text}`,
    };
  }
  const line = `${longDate(m.date)}, ${m.from} 님이 작성:`;
  return {
    html: `<div class="gmail_quote"><div>${esc(line)}</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${body}</blockquote></div>`,
    text: `${line}\n${text.split(/\r?\n/).map((l) => '> ' + l).join('\n')}`,
  };
}

function openCompose({ mode = 'new', msg = null, account, to = '', subject = '', body = '' } = {}) {
  if (cp.open && cp.dirty && !confirm('작성 중인 메일이 있습니다. 버리고 새로 쓸까요?')) { $('#compose').classList.remove('min'); return; }
  const th = state.thread;
  const m = msg || (th && mode !== 'new' ? th.messages[th.messages.length - 1] : null);
  const scopeAcc = state.folder.scope !== 'all' ? state.folder.scope : null;
  const from = account || m?.account || th?.account || scopeAcc || connected()[0]?.email || accs()[0]?.email;
  if (!from) { toast('먼저 계정을 추가하세요.'); return; }
  Object.assign(cp, { open: true, mode, account: from, threadId: null, inReplyTo: '', references: '', quoteHtml: '', quoteText: '', files: [], origAtts: [], dirty: false });
  let cc = '';
  if (m && mode !== 'new') {
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
    const q = quoteParts(m, mode === 'forward');
    cp.quoteHtml = q.html; cp.quoteText = q.text;
    if (mode !== 'forward') {
      cp.threadId = m.threadId;
      cp.inReplyTo = m.messageId;
      cp.references = [m.references, m.messageId].filter(Boolean).join(' ');
    } else {
      cp.origAtts = m.attachments.filter((x) => !x.inline).map((x) => ({ ...x, msgId: m.id, account: m.account, keep: true }));
    }
  }
  const sig = acc(from).signature;
  $('#cp-title').textContent = { new: '새 메일', reply: '답장', replyAll: '전체 답장', forward: '전달' }[mode];
  $('#cp-from').innerHTML = fromOptions(from);
  $('#cp-to').value = to;
  $('#cp-cc').value = cc;
  $('#cp-bcc').value = '';
  $$('#compose [data-cc]').forEach((r) => (r.hidden = !cc));
  $('#cp-subject').value = subject;
  $('#cp-text').value = (body ? body + '\n' : '') + '\n' + (sig ? `\n${sig}\n` : '');
  $('#cp-quote').hidden = !cp.quoteHtml;
  $('#cp-quote').open = false;
  $('#cp-quote-view').innerHTML = cp.quoteHtml ? esc(cp.quoteText).replace(/\n/g, '<br>') : '';
  $('#cp-msg').textContent = ''; $('#cp-msg').className = 'cp-msg';
  renderCpAtts();
  $('#compose').hidden = false;
  $('#compose').classList.remove('min');
  const focusEl = to ? $('#cp-text') : $('#cp-to');
  focusEl.focus();
  if (focusEl === $('#cp-text')) $('#cp-text').setSelectionRange(0, 0);
}

function renderCpAtts() {
  const all = [...cp.origAtts.filter((x) => x.keep).map((x, i) => ({ name: x.filename, size: x.size, type: x.mimeType, k: `o${cp.origAtts.indexOf(x)}` })),
    ...cp.files.map((f, i) => ({ name: f.name, size: f.size, type: f.type, k: `f${i}` }))];
  $('#cp-atts').innerHTML = all.map((x) => `<span class="att"><span class="a-ic">${fileIcon(x.type, x.name)}</span><span class="a-nm">${esc(x.name)}</span><span class="a-sz">${sizeText(x.size)}</span><button class="a-x" data-rm="${x.k}" title="빼기" aria-label="빼기">✕</button></span>`).join('');
}
function addFiles(list) {
  for (const f of list) cp.files.push(f);
  cp.dirty = true;
  renderCpAtts();
}

function closeCompose(force = false) {
  if (!force && cp.dirty && !confirm('작성 중인 메일을 버릴까요?')) return;
  cp.open = false;
  $('#compose').hidden = true;
  $('#suggest').hidden = true;
}

async function sendCompose() {
  const from = $('#cp-from').value;
  const fields = { to: $('#cp-to').value, cc: $('#cp-cc').value, bcc: $('#cp-bcc').value };
  const all = Object.values(fields).flatMap(parseAddrList);
  const bad = all.filter((x) => !validEmail(x.email));
  const msgEl = $('#cp-msg');
  const say = (t, err) => { msgEl.textContent = t; msgEl.className = 'cp-msg' + (err ? ' err' : ''); };
  if (!all.length) { say('받는 사람을 입력하세요.', true); $('#cp-to').focus(); return; }
  if (bad.length) { say(`주소 확인: ${bad.map((x) => x.email).join(', ')}`, true); return; }
  if (!auth.token(from)) { say(`${from} 연결이 필요합니다. 왼쪽 '연결'을 누른 뒤 다시 보내세요.`, true); return; }
  const subject = $('#cp-subject').value.trim();
  if (!subject && !confirm('제목 없이 보낼까요?')) return;
  const text = $('#cp-text').value.replace(/\s+$/, '');
  const a = acc(from);
  const btn = $('#cp-send');
  btn.disabled = true;
  try {
    say('첨부 준비 중…');
    const attachments = [];
    for (const f of cp.files) attachments.push({ name: f.name, type: f.type || 'application/octet-stream', bytes: new Uint8Array(await f.arrayBuffer()) });
    for (const x of cp.origAtts.filter((o) => o.keep)) {
      const data = x.data || await gm.getAttachment(x.account, x.msgId, x.attachmentId);
      attachments.push({ name: x.filename, type: x.mimeType, bytes: b64ToBytes(data) });
    }
    const total = attachments.reduce((s, f) => s + f.bytes.length, 0);
    if (total > 24 * 1024 * 1024) { say(`첨부 합계 ${sizeText(total)} — Gmail 한도(25MB)를 넘습니다.`, true); btn.disabled = false; return; }
    say('보내는 중…');
    const html = `<div style="font-family:'Malgun Gothic',sans-serif;font-size:14px;line-height:1.6">${textToHtml(text)}</div>${cp.quoteHtml ? '<br>' + cp.quoteHtml : ''}`;
    const plain = text + (cp.quoteText ? '\n\n' + cp.quoteText : '');
    const raw = buildRaw({
      from: { name: a.name, email: from }, ...fields, subject, text: plain, html,
      inReplyTo: from === cp.account ? cp.inReplyTo : '', references: from === cp.account ? cp.references : '', attachments,
    });
    await gm.sendMime(from, raw, from === cp.account ? cp.threadId : null);
    learn(fields.to, 3); learn(fields.cc, 2); learn(fields.bcc, 1);
    closeCompose(true);
    toast(`${from} 계정으로 보냈습니다.`);
    if (state.thread && cp.threadId && state.thread.id === cp.threadId) openThread(state.sel);
    else if (state.folder.label === 'SENT') loadList({ silent: true });
  } catch (e) {
    if (e instanceof auth.AuthError) say(`${from} 연결이 끊겼습니다. 다시 연결한 뒤 보내기를 누르세요.`, true);
    else say(e.message || '보내기 실패', true);
    fail(e, 'send');
  } finally { btn.disabled = false; }
}

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
      <p>학교 계정과 개인 계정을 차례로 추가하면<br>두 계정 메일을 한 화면에서 봅니다.</p>
      <button class="btn-primary" id="gate-add">Google 계정 추가</button>
      <p class="gate-msg" id="gate-msg"></p>
      <button class="btn-text" id="gate-cid-reset">클라이언트 ID 다시 입력</button>`;
  } else if (kind === 'connect') {
    card.innerHTML = `${icon}<h2>계정 연결</h2>
      <p>보안을 위해 연결은 1시간마다 새로 받습니다.<br>계정마다 <b>연결</b>을 눌러 주세요(창이 잠깐 떴다 닫힙니다).</p>
      <div class="gate-accs">${accs().map((a) => `<div class="gate-acc" style="--acc:${a.color}"><span>${esc(a.email)}</span>${auth.token(a.email) ? '<b class="ok">✓ 연결됨</b>' : `<button class="btn-primary" data-reconnect="${esc(a.email)}">연결</button>`}</div>`).join('')}</div>
      <p class="gate-msg" id="gate-msg"></p>
      <button class="btn-text" id="gate-skip">연결된 계정만으로 열기</button>`;
  }
}
function gateMsg(t) { const el = $('#gate-msg'); if (el) el.textContent = t || ''; }

async function doReconnect(email) {
  try {
    await auth.reconnect(email);
    state.authErr.delete(email);
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
let started = false;
function afterConnect() {
  renderBanner();
  renderSide();
  if (!accs().length) { gate('add'); return; }
  if (!connected().length) { gate('connect'); return; }
  if (!$('#gate').hidden && accs().some((a) => !auth.token(a.email)) && !gateSkipped) { gate('connect'); }
  else gate(null);
  if (!started) { started = true; selectFolder(state.folder.scope, state.folder.label); }
  else { loadList({ silent: true }); }
  refreshCounts();
}
let gateSkipped = false;

/* ───────── 메뉴·계정 설정 ───────── */
function showPop(anchor, html, bind) {
  const p = $('#pop');
  p.innerHTML = html;
  p.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = p.offsetWidth, hgt = p.offsetHeight;
  p.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  p.style.top = r.bottom + hgt + 8 > innerHeight ? `${Math.max(8, r.top - hgt - 6)}px` : `${r.bottom + 6}px`;
  bind?.(p);
}
const closePop = () => ($('#pop').hidden = true);

function openMenu(anchor) {
  showPop(anchor, `
    <div class="pop-row">화면 <select id="m-theme" class="sel"><option value="system">기기 설정 따름</option><option value="light">밝게</option><option value="dark">어둡게</option></select></div>
    <button data-m="img">${state.showImages ? '☑' : '☐'} 메일 속 외부 그림 바로 표시</button>
    <hr>
    <button data-m="acc">👤 계정 설정 (이름·서명·색·순서)</button>
    <button data-m="add">＋ 계정 추가</button>
    <hr>
    <button data-m="cid">🔑 클라이언트 ID 바꾸기</button>
    <button data-m="update">⟳ 새 버전 확인 (v${VERSION})</button>`, (p) => {
    const s = $('#m-theme', p); s.value = getTheme(); s.onchange = () => setTheme(s.value);
    p.onclick = (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      closePop();
      const k = b.dataset.m;
      if (k === 'img') { state.showImages = !state.showImages; pref.set('showImages', state.showImages); if (state.thread) renderReader(); toast(state.showImages ? '외부 그림을 바로 표시합니다.' : '외부 그림을 숨깁니다(메일마다 표시 가능).'); }
      if (k === 'acc') openAccSettings();
      if (k === 'add') doAdd();
      if (k === 'cid') { const v = prompt('OAuth 클라이언트 ID', auth.clientId()); if (v != null) { auth.setClientId(v); toast('저장했습니다. 계정을 다시 연결하세요.'); } }
      if (k === 'update') navigator.serviceWorker?.getRegistration().then((r) => r?.update()).then(() => toast('확인했습니다. 새 버전이 있으면 안내가 뜹니다.'));
    };
  });
}

function openAccSettings() {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  const draw = () => {
    const list = accs();
    wrap.innerHTML = `<div class="modal-card"><h3>계정 설정</h3>
      ${list.map((a, i) => `<div class="acc-edit" style="--acc:${a.color}" data-e="${esc(a.email)}">
        <div class="ae-h"><span class="dot" style="background:${a.color}"></span><span>${esc(a.email)}</span>
          <button class="icon-btn" data-mv="-1" ${i ? '' : 'disabled'} title="위로">↑</button><button class="icon-btn" data-mv="1" ${i < list.length - 1 ? '' : 'disabled'} title="아래로">↓</button></div>
        <div class="ae-row"><label>짧은 표시 (목록 꼬리표)<input data-f="label" value="${esc(a.label || '')}" maxlength="8"></label>
        <label>보내는 사람 이름<input data-f="name" value="${esc(a.name || '')}" placeholder="예: 김영배" maxlength="40"></label></div>
        <label>서명 (새 메일·답장 끝에 자동 삽입)<textarea data-f="signature" rows="3">${esc(a.signature || '')}</textarea></label>
        <div class="ae-row" style="align-items:center"><label>색<select data-f="color" class="sel">${ACCOUNT_COLORS.concat(PALETTE).filter((c, k, arr) => arr.indexOf(c) === k).map((c) => `<option value="${c}" ${c === a.color ? 'selected' : ''} style="color:${c}">■ ${c}</option>`).join('')}</select></label>
        <button class="btn-ghost danger" data-rm style="color:var(--danger);align-self:flex-end;margin-bottom:8px">계정 빼기</button></div>
      </div>`).join('')}
      <div class="modal-foot"><button class="btn-primary" data-close>닫기</button></div></div>`;
  };
  draw();
  wrap.addEventListener('change', (e) => {
    const box = e.target.closest('[data-e]'); const f = e.target.dataset.f;
    if (box && f) { auth.updateAccount(box.dataset.e, { [f]: e.target.value }); renderSide(); renderList(); if (f === 'color') draw(); }
  });
  wrap.addEventListener('click', (e) => {
    const box = e.target.closest('[data-e]');
    if (e.target.closest('[data-close]') || e.target === wrap) { wrap.remove(); return; }
    if (!box) return;
    const mv = e.target.closest('[data-mv]');
    if (mv) { auth.moveAccount(box.dataset.e, Number(mv.dataset.mv)); draw(); renderSide(); }
    if (e.target.closest('[data-rm]') && confirm(`${box.dataset.e} 계정을 YB-Mail에서 뺄까요?\n(Gmail의 메일은 지워지지 않습니다)`)) {
      auth.removeAccount(box.dataset.e);
      delete state.unread[box.dataset.e];
      state.items = state.items.filter((t) => t.account !== box.dataset.e);
      if (state.folder.scope === box.dataset.e) selectFolder('all', 'INBOX');
      renderSide(); renderList(); renderBanner();
      if (!accs().length) { wrap.remove(); gate('add'); return; }
      draw();
    }
  });
  document.body.append(wrap);
}

/* ───────── 단축키 ───────── */
function onKey(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (cp.open && !$('#compose').classList.contains('min')) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendCompose(); }
    if (e.key === 'Escape' && !$('#suggest').hidden) { $('#suggest').hidden = true; }
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  const t = current();
  const move = (d) => {
    const i = state.items.findIndex((x) => x.key === state.sel);
    const n = state.items[i < 0 ? 0 : Math.max(0, Math.min(state.items.length - 1, i + d))];
    if (n) openThread(n.key, { fromList: false });
  };
  if (k === 'c') { e.preventDefault(); openCompose({ mode: 'new' }); }
  else if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (k === '/') { e.preventDefault(); $('#search').focus(); }
  else if (!t || !state.thread) return;
  else if (k === 'r') { e.preventDefault(); openCompose({ mode: 'reply' }); }
  else if (k === 'a') { e.preventDefault(); openCompose({ mode: 'replyAll' }); }
  else if (k === 'f') { e.preventDefault(); openCompose({ mode: 'forward' }); }
  else if (k === 'e') act('archive');
  else if (k === 'Delete' || k === '#') act('trash');
  else if (k === 'u') act('unread');
  else if (k === 's') act('star');
  else if (k === 'Escape') closeReader();
}

/* ───────── 이벤트 연결 ───────── */
function bind() {
  document.addEventListener('keydown', onKey);
  $('#folders').addEventListener('click', (e) => {
    const f = e.target.closest('.f-item');
    if (f) { selectFolder(f.dataset.scope, f.dataset.label); return; }
    const x = e.target.closest('[data-expand]');
    if (x) { const em = x.dataset.expand; state.expanded.has(em) ? state.expanded.delete(em) : state.expanded.add(em); pref.set('expanded', [...state.expanded]); renderSide(); }
  });
  document.addEventListener('click', (e) => {
    const r = e.target.closest('[data-reconnect]');
    if (r) { e.preventDefault(); doReconnect(r.dataset.reconnect); }
    if (!$('#pop').hidden && !e.target.closest('#pop, #btn-menu, [data-mact="more"]')) closePop();
    if (!$('#suggest').hidden && !e.target.closest('#suggest')) $('#suggest').hidden = true;
  });
  $('#btn-side').onclick = () => document.body.classList.add('drawer');
  $('#btn-side-close').onclick = $('#scrim').onclick = () => document.body.classList.remove('drawer');
  $('#btn-compose').onclick = $('#fab').onclick = () => { document.body.classList.remove('drawer'); openCompose({ mode: 'new' }); };
  $('#btn-add-acc').onclick = () => doAdd();
  $('#btn-menu').onclick = (e) => ($('#pop').hidden ? openMenu(e.currentTarget) : closePop());
  $('#btn-refresh').onclick = () => { loadList({ silent: !!state.items.length }); refreshCounts(); };
  let qTimer;
  $('#search').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = $('#search').value; loadList(); }, 450); });
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(qTimer); state.q = $('#search').value; loadList(); } });
  $('#chip-unread').onclick = () => { state.unreadOnly = !state.unreadOnly; loadList(); };

  $('#list').addEventListener('click', (e) => {
    if (e.target.closest('#btn-more')) { loadList({ append: true }); return; }
    const li = e.target.closest('.item'); if (!li) return;
    const t = state.items.find((x) => x.key === li.dataset.key);
    const b = e.target.closest('[data-iact]');
    if (b) { e.stopPropagation(); act(b.dataset.iact, t); return; }
    openThread(li.dataset.key);
  });
  $('#list').addEventListener('scroll', (e) => {
    const el = e.currentTarget;
    if (!state.loading && el.scrollTop + el.clientHeight > el.scrollHeight - 300 && Object.values(state.pages).some(Boolean)) loadList({ append: true });
  });

  document.querySelector('.pane-read').addEventListener('click', (e) => {
    const go = e.target.closest('[data-go="list"]');
    if (go) { $('#app').dataset.view = 'list'; return; }
    const a = e.target.closest('[data-act]');
    if (a && !a.disabled) {
      const k = a.dataset.act;
      if (['reply', 'replyAll', 'forward'].includes(k)) openCompose({ mode: k });
      else act(k);
      return;
    }
    const msgEl = e.target.closest('.msg');
    if (!msgEl) return;
    const m = state.thread?.messages.find((x) => x.id === msgEl.dataset.mid);
    const ma = e.target.closest('[data-mact]');
    if (ma && m) {
      if (ma.dataset.mact === 'reply') openCompose({ mode: 'reply', msg: m });
      else showPop(ma, `<button data-x="reply">↩ 답장</button><button data-x="replyAll">⤶ 전체 답장</button><button data-x="forward">↪ 전달</button><hr><button data-x="orig">🧾 원본 보기(Gmail 웹)</button>`, (p) => {
        p.onclick = (ev) => {
          const x = ev.target.closest('[data-x]')?.dataset.x; if (!x) return;
          closePop();
          if (x === 'orig') window.open(`https://mail.google.com/mail/u/${encodeURIComponent(m.account)}/#all/${m.threadId}`, '_blank');
          else openCompose({ mode: x, msg: m });
        };
      });
      return;
    }
    if (e.target.closest('[data-showimg]')) { fillBody(msgEl, true); return; }
    const att = e.target.closest('[data-att]');
    if (att && m) { openAttachment(m, m.attachments[Number(att.dataset.att)]); return; }
    if (e.target.closest('[data-toggle]')) {
      const wasCollapsed = msgEl.classList.toggle('collapsed') === false;
      state.thread.open = state.thread.open || new Set();
      if (wasCollapsed) { state.thread.open.add(m.id); fillBody(msgEl); }
    }
  });

  // 쓰기
  $('#cp-close').onclick = (e) => { e.stopPropagation(); closeCompose(); };
  $('#cp-min').onclick = (e) => { e.stopPropagation(); $('#compose').classList.toggle('min'); };
  $('.cp-head').onclick = () => $('#compose').classList.remove('min');
  $('#cp-ccbtn').onclick = () => { $$('#compose [data-cc]').forEach((r) => (r.hidden = false)); $('#cp-cc').focus(); };
  $('#cp-send').onclick = sendCompose;
  $('#cp-attach').onclick = () => $('#file-attach').click();
  $('#file-attach').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
  $('#cp-from').onchange = () => {
    const prevSig = acc(cp.account).signature, nextSig = acc($('#cp-from').value).signature;
    const ta = $('#cp-text');
    if (prevSig && ta.value.includes(prevSig)) ta.value = ta.value.replace(prevSig, nextSig || '');
    else if (nextSig && !ta.value.includes(nextSig)) ta.value = ta.value.replace(/\s*$/, '') + `\n\n${nextSig}\n`;
    if ($('#cp-from').value !== cp.account && cp.threadId) $('#cp-msg').textContent = '다른 계정으로 보내면 새 대화로 보내집니다.';
    else $('#cp-msg').textContent = '';
  };
  $('#cp-atts').onclick = (e) => {
    const rm = e.target.closest('[data-rm]')?.dataset.rm; if (!rm) return;
    if (rm[0] === 'f') cp.files.splice(Number(rm.slice(1)), 1); else cp.origAtts[Number(rm.slice(1))].keep = false;
    renderCpAtts();
  };
  $('#compose').addEventListener('input', () => (cp.dirty = true));
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

  // 파일 끌어놓기·붙여넣기 → 첨부
  let dragN = 0;
  window.addEventListener('dragenter', (e) => { if (cp.open && e.dataTransfer?.types?.includes('Files')) { dragN++; $('#drop').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; $('#drop').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (cp.open) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (!cp.open) return; e.preventDefault(); dragN = 0; $('#drop').hidden = true; addFiles([...e.dataTransfer.files]); });
  $('#compose').addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } });

  // 처음 화면
  $('#gate').addEventListener('click', (e) => {
    if (e.target.id === 'gate-cid-ok') {
      const v = $('#gate-cid').value.trim();
      if (!/\.apps\.googleusercontent\.com$/.test(v)) { gateMsg('형식 확인: …apps.googleusercontent.com 으로 끝나야 합니다.'); return; }
      auth.setClientId(v); gate(accs().length ? 'connect' : 'add');
    }
    if (e.target.id === 'gate-add') doAdd();
    if (e.target.id === 'gate-cid-reset') gate('client');
    if (e.target.id === 'gate-skip') { gateSkipped = true; afterConnect(); gate(null); }
  });

  // 만료 직전이면, 다음 클릭 때 조용히 새 토큰 받기 (팝업은 클릭 안에서만 허용)
  const tried = new Map();
  document.addEventListener('pointerdown', () => {
    if (DEMO) return;
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
  window.addEventListener('offline', () => setSync('offline', '● 오프라인'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && started) { loadList({ silent: true }); refreshCounts(); } });
  setInterval(() => {
    if (document.visibilityState !== 'visible' || !started || state.loading) return;
    if (!connected().length) { renderBanner(); renderSide(); return; }
    loadList({ silent: true });
    refreshCounts();
  }, 90_000);
}

/* ───────── 서비스 워커 (새 버전 안내) ───────── */
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
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
}

/* ───────── 시작 ───────── */
async function boot() {
  $('#version').textContent = DEMO ? `v${VERSION} · 점검용` : `v${VERSION}`;
  bind();
  document.body.classList.remove('booting');
  if (DEMO) {
    const demo = await import('./demo.js');
    demo.initDemo();
    gm.useBackend(demo.demoBackend);
    auth.demoSetup(demo.DEMO_ACCOUNTS);
    afterConnect();
    return;
  }
  renderSide();
  renderBanner();
  if (!auth.clientId()) { gate('client'); }
  else if (!accs().length) gate('add');
  else if (!connected().length) gate('connect');
  else afterConnect();
  auth.loadGis().catch((e) => { gateMsg(e.message); toast(e.message, 0); });
  registerSW();
}
boot();
