// Gmail API 호출 — 계정(email)마다 해당 계정 토큰으로 호출
import { token, dropToken, AuthError } from './auth.js';
import { parsePayload, hdr, parseAddrList, toB64url, bytesToB64 } from './mime.js';

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
    if ((r.status === 429 || r.status >= 500) && attempt < 2) { await new Promise((s) => setTimeout(s, 800 * (attempt + 1))); continue; }
    if (!r.ok) {
      let msg = `${r.status}`;
      try { const j = await r.json(); msg = j.error?.message || msg; } catch { /* 무시 */ }
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
  // 보낸 사람 묶음: 내가 보낸 건 '나'
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
 * 스레드 목록 (한 계정)
 * @param {object} o { labelIds:[], q, pageToken, max }
 */
export async function listThreads(email, { labelIds, q, pageToken, max = 25 } = {}) {
  const r = await call(email, 'threads', { query: { labelIds, q: q || undefined, pageToken, maxResults: max } });
  const ids = (r.threads || []).map((t) => t.id);
  const me = email.toLowerCase();
  const threads = await pool(ids, 8, async (id) => {
    try {
      const t = await call(email, `threads/${id}`, { query: { format: 'metadata', metadataHeaders: META } });
      return summarize(email, t, me);
    } catch (e) { if (e instanceof AuthError) throw e; return null; }
  });
  return { threads: threads.filter(Boolean), nextPageToken: r.nextPageToken || null };
}

/** 스레드 전체 (본문 포함) */
export async function getThread(email, id) {
  const t = await call(email, `threads/${id}`, { query: { format: 'full' } });
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
      snippet: decodeEntities(m.snippet || ''),
      ...body,
    };
  });
  return { id: t.id, account: email, messages };
}

export async function getAttachment(email, msgId, attId) {
  const r = await call(email, `messages/${msgId}/attachments/${attId}`);
  return r.data; // base64url
}

export const modifyThread = (email, id, add = [], remove = []) =>
  call(email, `threads/${id}/modify`, { method: 'POST', body: { addLabelIds: add, removeLabelIds: remove } });
export const trashThread = (email, id) => call(email, `threads/${id}/trash`, { method: 'POST' });
export const untrashThread = (email, id) => call(email, `threads/${id}/untrash`, { method: 'POST' });

/** 원문 보내기 — 4MB 이하는 일반 호출, 그보다 크면 업로드 방식(최대 35MB) */
export async function sendMime(email, rawStr, threadId) {
  const bytes = new TextEncoder().encode(rawStr);
  if (backend || bytes.length < 4 * 1024 * 1024) {
    const raw = toB64url(bytesToB64(bytes));
    return call(email, 'messages/send', { method: 'POST', body: threadId ? { raw, threadId } : { raw } });
  }
  const t = token(email);
  if (!t) throw new AuthError(email);
  const b = 'ybm' + Date.now().toString(36);
  const head = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(threadId ? { threadId } : {})}\r\n--${b}\r\nContent-Type: message/rfc822\r\n\r\n`;
  const blob = new Blob([head, bytes, `\r\n--${b}--`]);
  const r = await fetch('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart', {
    method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': `multipart/related; boundary=${b}` }, body: blob,
  });
  if (r.status === 401) { dropToken(email); throw new AuthError(email); }
  if (!r.ok) { let m = r.status; try { m = (await r.json()).error?.message || m; } catch { /* 무시 */ } throw new Error(`보내기 실패: ${m}`); }
  return r.json();
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
