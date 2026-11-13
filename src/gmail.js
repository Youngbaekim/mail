// Gmail API 호출 — 계정(email)마다 해당 계정 토큰으로 호출
import { token, dropToken, AuthError } from './auth.js';
import { parsePayload, hdr, parseAddrList, toB64url, bytesToB64 } from './mime.js';
import * as cache from './cache.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/';
let backend = null; // 점검용 가짜 서버 (?demo)
export const useBackend = (fn) => { backend = fn; };

async function call(email, path, { method = 'GET', body, query } = {}) {
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).flatMap(([k, v]) =>
    v == null ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])).toString() : '';
  if (backend) return backend(email, method, path, query || {}, body);
  const t = token(email);
  if (!t) throw new AuthError(email);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(BASE + path + qs, {
      method,
      headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) { dropToken(email); throw new AuthError(email); }
    if ((r.status === 429 || r.status >= 500) && attempt < 4) { await new Promise((s) => setTimeout(s, 1000 * 2 ** attempt + Math.random() * 400)); continue; }
    if (!r.ok) {
      let msg = `${r.status}`, reason = '';
      try { const j = await r.json(); msg = j.error?.message || msg; reason = j.error?.errors?.[0]?.reason || j.error?.status || ''; } catch { /* 무시 */ }
      // Gmail 사용량 한도(초당 요청 수)에 걸리면 403으로 옴 → 잠시 쉬었다가 다시
      if (r.status === 403 && /rate|quota|limit/i.test(reason + msg) && attempt < 4) { await new Promise((s) => setTimeout(s, 1500 * 2 ** attempt + Math.random() * 500)); continue; }
      if (r.status === 403 && /insufficient|scope/i.test(msg)) { dropToken(email); throw new AuthError(email, '메일 권한이 부족합니다. 다시 연결해 주세요.'); }
      throw new Error(`Gmail 오류 (${email}): ${msg}`);
    }
    if (r.status === 204) return {};
    const txt = await r.text();
    return txt ? JSON.parse(txt) : {};
  }
}

/** 동시 처리 개수를 제한해 순서대로 실행 */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const META = ['From', 'To', 'Subject', 'Date'];

/** 이름만 짧게: '홍길동 <a@b>' → '홍길동' */
export function shortName(from) {
  const a = parseAddrList(from)[0];
  if (!a) return '';
  return a.name || a.email.split('@')[0];
}

function summarize(email, t, myEmail) {
  const msgs = t.messages || [];
  const last = msgs[msgs.length - 1] || {};
  const first = msgs[0] || {};
  const labels = new Set(msgs.flatMap((m) => m.labelIds || []));
  const h = (m, n) => hdr(m.payload?.headers, n);
  const senders = [];
  for (const m of msgs) {
    const f = h(m, 'From');
    const a = parseAddrList(f)[0];
    const nm = a && a.email.toLowerCase() === myEmail ? '나' : shortName(f);
    if (nm && !senders.includes(nm)) senders.push(nm);
  }
  const lastIn = [...msgs].reverse().find((m) => !(m.labelIds || []).includes('SENT')) || last;
  return {
    key: `${email}|${t.id}`,
    account: email,
    id: t.id,
    historyId: t.historyId || '',
    subject: h(first, 'Subject') || '(제목 없음)',
    from: h(lastIn, 'From'),
    to: h(last, 'To'),
    senders,
    date: Number(last.internalDate) || 0,
    snippet: decodeEntities(last.snippet || t.snippet || ''),
    count: msgs.length,
    unread: labels.has('UNREAD'),
    starred: labels.has('STARRED'),
    important: labels.has('IMPORTANT'),
    hasAttach: msgs.some((m) => hasAttachPart(m.payload)),
    labelIds: [...labels],
  };
}
function hasAttachPart(p) {
  if (!p) return false;
  if (p.filename && p.body?.attachmentId) return true;
  return (p.parts || []).some(hasAttachPart);
}
function decodeEntities(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

/**
 * 스레드 목록 (한 계정) — 기기 저장본과 historyId가 같으면 다시 받지 않음
 * @param {object} o { labelIds:[], q, pageToken, max }
 */
export async function listThreads(email, { labelIds, q, pageToken, max = 25 } = {}) {
  const r = await call(email, 'threads', { query: { labelIds, q: q || undefined, pageToken, maxResults: max } });
  const me = email.toLowerCase();
  const threads = await pool(r.threads || [], 5, async (t) => {
    try { return await ensureSummary(email, t, me); } catch (e) { if (e instanceof AuthError) throw e; return null; }
  });
  return { threads: threads.filter(Boolean), nextPageToken: r.nextPageToken || null };
}

/** 요약 확보: 저장본이 최신이면 그대로, 아니면 머리글만 받아 갱신(본문은 메시지 구성이 같으면 유지) */
async function ensureSummary(email, t, me) {
  const key = `${email}|${t.id}`;
  const rec = await cache.getThread(key);
  if (rec && rec.summary && rec.historyId === t.historyId) return rec.summary;
  const meta = await call(email, `threads/${t.id}`, { query: { format: 'metadata', metadataHeaders: META } });
  const summary = summarize(email, meta, me);
  let raw = rec?.raw || null;
  if (raw) {
    const ids = new Set(raw.messages.map((m) => m.id));
    const same = meta.messages.length === raw.messages.length && meta.messages.every((m) => ids.has(m.id));
    if (same) {
      const byId = Object.fromEntries(meta.messages.map((m) => [m.id, m.labelIds || []]));
      raw.messages.forEach((m) => { m.labelIds = byId[m.id]; });
      raw.historyId = meta.historyId;
    } else raw = null; // 새 메시지가 붙음 → 본문 다시 받기
  }
  await cache.putThread({ key, account: email, id: t.id, historyId: meta.historyId || t.historyId, date: summary.date, summary, raw });
  return summary;
}

/** 스레드 본문 원문 — 저장본 우선, 없으면 받아서 저장 */
export async function fetchFull(email, id, { force = false } = {}) {
  const key = `${email}|${id}`;
  const rec = await cache.getThread(key);
  if (!force && rec?.raw) return rec.raw;
  const raw = await call(email, `threads/${id}`, { query: { format: 'full' } });
  const summary = summarize(email, raw, email.toLowerCase());
  await cache.putThread({ key, account: email, id, historyId: raw.historyId, date: summary.date, summary, raw });
  return raw;
}
export async function hasFull(email, id) {
  const rec = await cache.getThread(`${email}|${id}`);
  return !!rec?.raw;
}

/** 원문 → 화면용 */
export function parseThread(email, t) {
  const messages = (t.messages || []).map((m) => {
    const H = m.payload?.headers;
    const body = parsePayload(m.payload);
    return {
      id: m.id,
      threadId: t.id,
      account: email,
      labelIds: m.labelIds || [],
      date: Number(m.internalDate) || 0,
      from: hdr(H, 'From'),
      to: hdr(H, 'To'),
      cc: hdr(H, 'Cc'),
      replyTo: hdr(H, 'Reply-To'),
      subject: hdr(H, 'Subject'),
      messageId: hdr(H, 'Message-ID') || hdr(H, 'Message-Id'),
      references: hdr(H, 'References'),
      inReplyTo: hdr(H, 'In-Reply-To'),
      bcc: hdr(H, 'Bcc'),
      snippet: decodeEntities(m.snippet || ''),
      ...body,
    };
  });
  return { id: t.id, account: email, historyId: t.historyId, messages };
}

export async function getThread(email, id, opts) {
  return parseThread(email, await fetchFull(email, id, opts));
}

/** 메시지 원본(.eml) */
export async function getRawEml(email, msgId) {
  const r = await call(email, `messages/${msgId}`, { query: { format: 'raw' } });
  return r.raw;
}

/** 첨부 내용(base64url) — 10MB 이하는 기기에 보관 */
export async function getAttachment(email, msgId, attId, { name = '', size = 0 } = {}) {
  const key = `${email}|${msgId}|${name}|${size}`;
  const hit = name ? await cache.getAtt(key) : null;
  if (hit) return hit;
  const r = await call(email, `messages/${msgId}/attachments/${attId}`);
  if (name && (r.size || size) <= 10 * 1024 * 1024) cache.putAtt(key, r.data);
  return r.data;
}

/** 여러 스레드 한꺼번에 라벨 변경 */
export const modifyMany = (email, ids, add = [], remove = []) => pool(ids, 5, (id) => modifyThread(email, id, add, remove));
export const trashMany = (email, ids) => pool(ids, 5, (id) => trashThread(email, id));
export const untrashMany = (email, ids) => pool(ids, 5, (id) => untrashThread(email, id));

/** 편지함 전체 읽음 처리 (최대 500개 대화) */
export async function markAllRead(email, label) {
  let pageToken, n = 0;
  do {
    const r = await call(email, 'threads', { query: { labelIds: label === 'ALL' ? undefined : [label], q: 'is:unread', maxResults: 100, pageToken } });
    const ids = (r.threads || []).map((t) => t.id);
    await modifyMany(email, ids, [], ['UNREAD']);
    n += ids.length;
    pageToken = r.nextPageToken;
  } while (pageToken && n < 500);
  return n;
}

/** 미리 받기 — 받은편지함 최근 limit개 대화의 본문을 기기에 저장 (진행 상황 콜백) */
export async function prefetch(email, { limit = 200, onProgress, shouldStop } = {}) {
  const me = email.toLowerCase();
  const list = [];
  let pageToken;
  while (list.length < limit) {
    const r = await call(email, 'threads', { query: { labelIds: ['INBOX'], maxResults: Math.min(100, limit - list.length), pageToken } });
    list.push(...(r.threads || []));
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  let done = 0;
  const need = [];
  for (const t of list) {
    if (shouldStop?.()) return;
    await ensureSummary(email, t, me).catch(() => null);
    if (!(await hasFull(email, t.id))) need.push(t.id); else done++;
  }
  onProgress?.(done, list.length);
  await pool(need, 2, async (id) => {
    if (shouldStop?.()) return;
    try {
      const raw = await fetchFull(email, id);
      await prefetchInline(email, raw);
    } catch (e) { if (e instanceof AuthError) throw e; }
    onProgress?.(++done, list.length);
  });
  await cache.prune(email, 600);
}

/** 본문 속 그림(cid) 미리 받기 (각 500KB 이하) */
export async function prefetchInline(email, raw) {
  for (const m of raw.messages || []) {
    const { attachments } = parsePayload(m.payload);
    for (const a of attachments) {
      if (a.contentId && a.attachmentId && a.size <= 500 * 1024) {
        await getAttachment(email, m.id, a.attachmentId, { name: a.filename, size: a.size }).catch(() => null);
      }
    }
  }
}

export const modifyThread = (email, id, add = [], remove = []) =>
  call(email, `threads/${id}/modify`, { method: 'POST', body: { addLabelIds: add, removeLabelIds: remove } });
export const trashThread = (email, id) => call(email, `threads/${id}/trash`, { method: 'POST' });
export const untrashThread = (email, id) => call(email, `threads/${id}/untrash`, { method: 'POST' });

/** 원문 올리기 — 4MB 이하는 일반 호출, 그보다 크면 업로드 방식(최대 35MB) */
async function putMime(email, path, method, rawStr, meta, wrap) {
  const bytes = new TextEncoder().encode(rawStr);
  if (backend || bytes.length < 4 * 1024 * 1024) {
    const raw = toB64url(bytesToB64(bytes));
    return call(email, path, { method, body: wrap({ raw, ...meta }) });
  }
  const t = token(email);
  if (!t) throw new AuthError(email);
  const b = 'ybm' + Date.now().toString(36);
  const head = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(wrap(meta))}\r\n--${b}\r\nContent-Type: message/rfc822\r\n\r\n`;
  const blob = new Blob([head, bytes, `\r\n--${b}--`]);
  const r = await fetch(`https://gmail.googleapis.com/upload/gmail/v1/users/me/${path}?uploadType=multipart`, {
    method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': `multipart/related; boundary=${b}` }, body: blob,
  });
  if (r.status === 401) { dropToken(email); throw new AuthError(email); }
  if (!r.ok) { let m = r.status; try { m = (await r.json()).error?.message || m; } catch { /* 무시 */ } throw new Error(`Gmail 오류: ${m}`); }
  return r.json();
}
const tid = (threadId) => (threadId ? { threadId } : {});
export const sendMime = (email, rawStr, threadId) => putMime(email, 'messages/send', 'POST', rawStr, tid(threadId), (x) => x);

/* ───────── 임시메일함(Gmail 임시보관함) ───────── */
export const createDraft = (email, rawStr, threadId) => putMime(email, 'drafts', 'POST', rawStr, tid(threadId), (x) => ({ message: x }));
export const updateDraft = (email, id, rawStr, threadId) => putMime(email, `drafts/${id}`, 'PUT', rawStr, tid(threadId), (x) => ({ id, message: x }));
export const deleteDraft = (email, id) => call(email, `drafts/${id}`, { method: 'DELETE' });
/** 메시지 id → 임시 저장 id */
export async function draftIdOf(email, messageId) {
  let pageToken;
  do {
    const r = await call(email, 'drafts', { query: { maxResults: 100, pageToken } });
    const hit = (r.drafts || []).find((d) => d.message?.id === messageId);
    if (hit) return hit.id;
    pageToken = r.nextPageToken;
  } while (pageToken);
  return null;
}

/* ───────── 차단(필터) — gmail.settings.basic 권한 ───────── */
/** 보낸 사람 차단: 앞으로 오는 메일을 스팸함으로 (스팸 지정이 거부되면 휴지통으로) */
export async function blockSender(email, from) {
  try {
    return { ...(await call(email, 'settings/filters', { method: 'POST', body: { criteria: { from }, action: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] } } })), to: 'SPAM' };
  } catch (e) {
    if (e instanceof AuthError) throw e;
    return { ...(await call(email, 'settings/filters', { method: 'POST', body: { criteria: { from }, action: { addLabelIds: ['TRASH'] } } })), to: 'TRASH' };
  }
}
export async function listBlocked(email) {
  const r = await call(email, 'settings/filters');
  return (r.filter || []).filter((f) => f.criteria?.from && ((f.action?.addLabelIds || []).some((l) => l === 'SPAM' || l === 'TRASH')))
    .map((f) => ({ id: f.id, from: f.criteria.from, to: (f.action.addLabelIds || []).includes('SPAM') ? 'SPAM' : 'TRASH' }));
}
export const unblock = (email, id) => call(email, `settings/filters/${id}`, { method: 'DELETE' });
/** 그 사람이 보낸 기존 메일도 스팸함으로 */
export async function moveFromSender(email, from, label = 'SPAM') {
  const r = await call(email, 'threads', { query: { q: `from:${from}`, maxResults: 100 } });
  const ids = (r.threads || []).map((t) => t.id);
  if (label === 'TRASH') await trashMany(email, ids); else await modifyMany(email, ids, ['SPAM'], ['INBOX']);
  return ids.length;
}

/** 사용자 라벨 목록 */
export async function listLabels(email) {
  const r = await call(email, 'labels');
  return (r.labels || []).filter((l) => l.type === 'user' && l.labelListVisibility !== 'labelHide')
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

/** 읽지 않은 스레드 수 */
export async function unreadCount(email, label = 'INBOX') {
  const r = await call(email, `labels/${label}`);
  return r.threadsUnread || 0;
}
