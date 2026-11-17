// 메일 검색 — Gmail 서버 검색(메일함 전체·단어 단위) + PC 저장본 부분 일치(띄어쓰기 무시) 혼합
import { parsePayload, htmlToText } from './mime.js';

/** 검색 조건 (빈 값 = 조건 없음) */
export const emptySearch = () => ({
  text: '',        // 포함 (모든 단어)
  phrase: '',      // 정확한 문구
  exclude: '',     // 제외 단어
  from: '', to: '',
  where: 'all',    // all = 제목+본문, subject = 제목만
  period: '',      // '' | 7d | 1m | 3m | 1y | custom
  after: '', before: '', // YYYY-MM-DD (custom)
  attach: false, unread: false, starred: false,
  scope: 'folder', // folder = 지금 편지함, all = 전체 메일함(스팸·휴지통 제외)
});
export const isActive = (s) => !!(s.text.trim() || s.phrase.trim() || s.exclude.trim() || s.from.trim() || s.to.trim() || s.period || s.attach || s.unread || s.starred || s.scope === 'all' || s.where === 'subject');

const words = (v) => String(v || '').split(/[\s,]+/).map((w) => w.trim()).filter(Boolean);
/** 비교용: 소문자 + 띄어쓰기 없앰 */
export const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, '');
const ymd = (d) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;

/** 기간 → [시작, 끝) (ms) */
export function range(s) {
  const now = new Date();
  const back = { '7d': 7, '1m': 30, '3m': 91, '1y': 365 }[s.period];
  if (back) { const a = new Date(now); a.setDate(a.getDate() - back); a.setHours(0, 0, 0, 0); return [a.getTime(), Infinity]; }
  if (s.period === 'custom') {
    const a = s.after ? new Date(`${s.after}T00:00:00`).getTime() : -Infinity;
    const b = s.before ? new Date(`${s.before}T00:00:00`).getTime() + 86_400_000 : Infinity; // 끝 날짜 포함
    return [a, b];
  }
  return [-Infinity, Infinity];
}

const q = (w) => (/[\s()":]/.test(w) ? `"${w.replace(/"/g, '')}"` : w);
/** Gmail 검색어 만들기 */
export function gmailQuery(s) {
  const parts = [];
  const inc = words(s.text);
  if (s.where === 'subject') { if (inc.length) parts.push(`subject:(${inc.map(q).join(' ')})`); if (s.phrase.trim()) parts.push(`subject:"${s.phrase.trim().replace(/"/g, '')}"`); }
  else { parts.push(...inc.map(q)); if (s.phrase.trim()) parts.push(`"${s.phrase.trim().replace(/"/g, '')}"`); }
  parts.push(...words(s.exclude).map((w) => `-${q(w)}`));
  if (s.from.trim()) parts.push(`from:(${s.from.trim()})`);
  if (s.to.trim()) parts.push(`to:(${s.to.trim()})`);
  const [a, b] = range(s);
  if (a > -Infinity) parts.push(`after:${ymd(new Date(a))}`);
  if (b < Infinity) parts.push(`before:${ymd(new Date(b))}`);
  if (s.attach) parts.push('has:attachment');
  if (s.unread) parts.push('is:unread');
  if (s.starred) parts.push('is:starred');
  return parts.join(' ');
}

/* ── PC 저장본 검색 ── */
const bodyText = new Map(); // key|historyId → 본문 글자(비교용)
function bodyOf(rec) {
  if (!rec.raw) return '';
  const k = `${rec.key}|${rec.historyId}`;
  if (bodyText.has(k)) return bodyText.get(k);
  let t = '';
  try {
    for (const m of rec.raw.messages || []) {
      if ((m.labelIds || []).includes('TRASH')) continue;
      const p = parsePayload(m.payload);
      t += ' ' + (p.text || (p.html ? htmlToText(p.html) : ''));
      const names = p.attachments.map((x) => x.filename).join(' ');
      t += ' ' + names;
    }
  } catch { /* 무시 */ }
  t = norm(t).slice(0, 60_000);
  if (bodyText.size > 3000) bodyText.clear();
  bodyText.set(k, t);
  return t;
}

/**
 * 저장본에서 부분 일치로 찾기
 * @param {object[]} recs cache.allThreads()
 * @param {object} s 검색 조건
 * @param {object} o { accounts:Set, label } label: 지금 편지함(범위가 folder일 때)
 */
export function localSearch(recs, s, { accounts, label }) {
  const inc = words(s.text).map(norm), exc = words(s.exclude).map(norm);
  const phrase = norm(s.phrase), from = norm(s.from), to = norm(s.to);
  const [a, b] = range(s);
  const out = [];
  for (const rec of recs) {
    const t = rec.summary;
    if (!t || !accounts.has(rec.account)) continue;
    const L = new Set(t.labelIds || []);
    if (s.scope === 'folder' && label !== 'ALL' ? !L.has(label) : (L.has('SPAM') || (L.has('TRASH') && t.count <= 1))) continue;
    if (t.date < a || t.date >= b) continue;
    if (s.attach && !t.hasAttach) continue;
    if (s.unread && !t.unread) continue;
    if (s.starred && !t.starred) continue;
    if (from && !norm(t.from + ' ' + (t.senders || []).join(' ')).includes(from)) continue;
    if (to && !norm(t.to).includes(to)) continue;
    const head = norm(t.subject) + (s.where === 'subject' ? '' : '\u0001' + norm(t.from) + norm(t.to) + norm(t.snippet));
    const needBody = s.where !== 'subject' && (inc.length || phrase || exc.length);
    let hay = head;
    const has = (w) => hay.includes(w) || (needBody && (hay = head + '\u0001' + bodyOf(rec)).includes(w));
    if (!inc.every(has)) continue;
    if (phrase && !has(phrase)) continue;
    if (exc.length) { if (needBody) hay = head + '\u0001' + bodyOf(rec); if (exc.some((w) => hay.includes(w))) continue; }
    out.push(t);
  }
  return out;
}

/** 칩 표시용 */
export function chips(s) {
  const c = [];
  if (s.text.trim()) c.push(['text', `포함: ${s.text.trim()}`]);
  if (s.phrase.trim()) c.push(['phrase', `문구: "${s.phrase.trim()}"`]);
  if (s.exclude.trim()) c.push(['exclude', `제외: ${s.exclude.trim()}`]);
  if (s.from.trim()) c.push(['from', `보낸 사람: ${s.from.trim()}`]);
  if (s.to.trim()) c.push(['to', `받는 사람: ${s.to.trim()}`]);
  if (s.where === 'subject') c.push(['where', '제목에서만']);
  if (s.period) c.push(['period', { '7d': '최근 1주', '1m': '최근 1개월', '3m': '최근 3개월', '1y': '최근 1년' }[s.period] || `기간: ${s.after || '처음'} ~ ${s.before || '오늘'}`]);
  if (s.attach) c.push(['attach', '첨부 있음']);
  if (s.unread) c.push(['unread', '안읽음']);
  if (s.starred) c.push(['starred', '별표']);
  if (s.scope === 'all') c.push(['scope', '전체 메일함']);
  return c;
}
