// 점검용 가짜 Gmail 서버 (주소 끝에 ?demo) — 로그인 없이 화면·동작 점검, 새로고침하면 처음 상태로
import { b64ToBytes, decodeBytes, bytesToB64, toB64url } from './mime.js';

const enc = new TextEncoder();
const b64u = (s) => toB64url(bytesToB64(enc.encode(s)));
const H = (o) => Object.entries(o).filter(([, v]) => v).map(([name, value]) => ({ name, value }));
const NOW = Date.now();
const ago = (min) => String(NOW - min * 60_000);

export const DEMO_ACCOUNTS = [
  { email: 'ybkim@ssu.ac.kr', color: '#2f6fd6', label: 'SSU', name: '김영배', signature: '김영배 | 숭실대학교 교육과정혁신센터\n02-820-0000' },
  { email: 'youngpeace@gmail.com', color: '#d9822b', label: '개인', name: '김영배', signature: '' },
];

let seq = 1000;
const db = {}; // email → { threads: Map(id → {id, messages:[]}), labels:[] }

function msg(acc, tid, { from, to, cc, subject, min, labels = ['INBOX'], text, html, atts = [], rawPart }) {
  const id = 'm' + (++seq);
  const parts = [];
  if (rawPart) parts.push(rawPart);
  else {
    const alt = [];
    if (text) alt.push({ mimeType: 'text/plain', headers: H({ 'Content-Type': 'text/plain; charset="UTF-8"' }), body: { size: text.length, data: b64u(text) } });
    if (html) alt.push({ mimeType: 'text/html', headers: H({ 'Content-Type': 'text/html; charset="UTF-8"' }), body: { size: html.length, data: b64u(html) } });
    parts.push({ mimeType: 'multipart/alternative', parts: alt });
  }
  for (const a of atts) {
    const attId = 'a' + (++seq);
    db[acc].att[attId] = a.data;
    parts.push({ mimeType: a.type, filename: a.name, headers: H({ 'Content-ID': a.cid ? `<${a.cid}>` : '', 'Content-Disposition': a.cid ? 'inline' : `attachment; filename="${a.name}"` }), body: { attachmentId: attId, size: a.size || Math.round(a.data.length * 0.75) } });
  }
  return {
    id, threadId: tid, labelIds: labels, internalDate: ago(min),
    snippet: (text || html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 120),
    payload: {
      mimeType: 'multipart/mixed',
      headers: H({ From: from, To: to, Cc: cc, Subject: subject, Date: new Date(Number(ago(min))).toUTCString(), 'Message-ID': `<${id}@demo.mail>` }),
      parts,
    },
  };
}
let hist = 5000;
function thread(acc, list) {
  const tid = 't' + (++seq);
  db[acc].threads.set(tid, { id: tid, historyId: String(++hist), messages: list.map((m) => msg(acc, tid, m)) });
}
const bump = (t) => { t.historyId = String(++hist); };

// 1×1 파란 점 (본문 안 그림 점검)
const DOT = 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAMCAYAAAAkuj5RAAAAL0lEQVR4nGPQz7_2fyhjhoF2wKgHBtoBox4YaAeMemCgHTDqgYF2wKgHBtoBlGIAvXGDDMBqICcAAAAASUVORK5CYII';
const PDF = b64u('%PDF-1.4\n% demo file\n');

function seed() {
  for (const a of DEMO_ACCOUNTS) db[a.email] = { threads: new Map(), att: {}, labels: [], drafts: [], filters: [] };
  const S = 'ybkim@ssu.ac.kr', P = 'youngpeace@gmail.com';
  db[S].labels = [{ id: 'Label_1', name: '대학혁신지원사업', type: 'user' }, { id: 'Label_2', name: 'CQI', type: 'user' }];
  db[P].labels = [{ id: 'Label_9', name: '테니스', type: 'user' }];

  thread(S, [{ from: '학사팀 박○○ <haksa@ssu.ac.kr>', to: 'ybkim@ssu.ac.kr', subject: '[협조] 2027-1학기 융합전공 교과목 개설 검토 요청', min: 12, labels: ['INBOX', 'UNREAD', 'IMPORTANT', 'Label_1'],
    html: '<p>팀장님 안녕하십니까.</p><p>2027-1학기 <b>융합전공 신규 교과목</b> 개설 검토를 요청드립니다.</p><table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>전공</th><th>교과목</th><th>학점</th></tr><tr><td>AI융합</td><td>생성형 AI 실무</td><td>3</td></tr><tr><td>데이터경영</td><td>공공데이터 분석</td><td>3</td></tr></table><p><img src="cid:dot1" alt="표시"> 회신은 11. 20.(금)까지 부탁드립니다.</p>',
    atts: [{ name: '2027-1 융합전공 개설안.pdf', type: 'application/pdf', data: PDF }, { name: 'dot.png', type: 'image/png', data: DOT, cid: 'dot1' }] }]);
  thread(S, [
    { from: '김영배 <ybkim@ssu.ac.kr>', to: 'eval@ssu.ac.kr', subject: 'CQI 보고서 제출 현황 공유', min: 60 * 26, labels: ['SENT'], text: '평가팀 담당자님,\n\n학과별 CQI 보고서 제출 현황을 공유드립니다.\n\n김영배 드림' },
    { from: '평가·전략사업추진팀 <eval@ssu.ac.kr>', to: 'ybkim@ssu.ac.kr', subject: 'Re: CQI 보고서 제출 현황 공유', min: 60 * 3, labels: ['INBOX', 'UNREAD', 'Label_2'], text: '팀장님, 확인했습니다.\n미제출 3개 학과는 다음 주까지 독려하겠습니다.\n\n> 학과별 CQI 보고서 제출 현황을 공유드립니다.' },
  ]);
  thread(S, [{ from: '교무처 <academic@ssu.ac.kr>', to: '전체 교직원 <staff@ssu.ac.kr>', subject: '2026학년도 2학기 성적 입력 일정 안내', min: 60 * 30, labels: ['INBOX', 'STARRED'], text: '성적 입력 기간: 12. 15.(화) ~ 12. 24.(목)\n자세한 사항은 첨부를 참고하시기 바랍니다.' }]);
  thread(S, [{ from: '총무팀 <general@ssu.ac.kr>', to: 'ybkim@ssu.ac.kr', subject: '[EUC-KR] 2027학년도 교육과정 개편 일정 안내', min: 60 * 50, labels: ['INBOX'],
    rawPart: { mimeType: 'text/plain', headers: H({ 'Content-Type': 'text/plain; charset=euc-kr' }), body: { size: 120, data: 'W7GzwLDH9b3FxsBdIDIwMjfH0LPitbUgsbPAsLD6waQgsLPG7SDAz8GkIL7Is7sKCr7Is-fHz73KtM-x7i4gw7e6ziDAz8GkwLsgyK7AziC6zsW5teW4s7TPtNkuCihFVUMtS1IgwM7E2rX5ILjewM8gwaGwy7_rKQ==' } } }]);
  for (let i = 0; i < 6; i++) {
    thread(S, [{ from: `교육성과연구팀 <outcome${i}@ssu.ac.kr>`, to: 'ybkim@ssu.ac.kr', subject: `[주간보고] ${i + 1}주차 만족도 조사 응답률`, min: 60 * (60 + i * 24), labels: ['INBOX'], text: `${i + 1}주차 응답률은 ${(41 + i * 3.2).toFixed(1)}%입니다.` }]);
  }

  thread(P, [{ from: '테니스 동호회 <club@example.com>', to: 'youngpeace@gmail.com', subject: '이번 주 토요일 정기전 조 편성', min: 35, labels: ['INBOX', 'UNREAD', 'Label_9'], text: '토요일 오전 7시, 1코트 A조입니다.\n늦지 않게 와 주세요!' }]);
  thread(P, [{ from: '한국투자증권 <noreply@example.com>', to: 'youngpeace@gmail.com', subject: '[알림] 주문 체결 내역 안내', min: 60 * 5, labels: ['INBOX'], html: '<div style="font-family:sans-serif"><h3 style="color:#c00">체결 안내</h3><p>고객님의 주문이 체결되었습니다.</p></div>' }]);
  thread(P, [{ from: '무료 쿠폰 <promo@spam.example>', to: 'youngpeace@gmail.com', subject: '[광고] 오늘만 90% 할인 쿠폰', min: 60 * 8, labels: ['SPAM'], text: '지금 바로 받으세요.' }]);
  thread(P, [{ from: 'GitHub <noreply@github.com>', to: 'youngpeace@gmail.com', subject: '[youngbaekim/receipt] Deploy to GitHub Pages: succeeded', min: 60 * 20, labels: ['INBOX', 'UNREAD'], text: 'All jobs have completed successfully.\nhttps://github.com/youngbaekim/receipt/actions' }]);
}

const fmtThread = (t, format) => {
  if (format === 'metadata') return { ...t, messages: t.messages.map((m) => ({ ...m, payload: { headers: m.payload.headers, mimeType: m.payload.mimeType, parts: m.payload.parts.map((p) => ({ filename: p.filename, body: p.body, mimeType: p.mimeType })) } })) };
  return t;
};
const tLabels = (t) => new Set(t.messages.flatMap((m) => m.labelIds));
const tDate = (t) => Math.max(...t.messages.map((m) => Number(m.internalDate)));

function matchQ(t, q) {
  if (!q) return true;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = t.messages.map((m) => m.payload.headers.map((h) => h.value).join(' ') + ' ' + m.snippet).join(' ').toLowerCase();
  return words.every((w) => {
    if (w === 'is:unread') return tLabels(t).has('UNREAD');
    if (w === 'has:attachment') return t.messages.some((m) => m.payload.parts.some((p) => p.filename));
    return hay.includes(w.replace(/^(from|to|subject):/, ''));
  });
}

export const sent = []; // 보낸 원문 (점검용)

export function demoBackend(email, method, path, q, body) {
  const D = db[email];
  const delay = (v) => new Promise((r) => setTimeout(() => r(structuredClone(v)), 120));
  let m;
  if (path === 'profile') return delay({ emailAddress: email });
  if (path === 'labels') return delay({ labels: [...D.labels] });
  if ((m = /^labels\/(\w+)$/.exec(path))) {
    const n = [...D.threads.values()].filter((t) => { const L = tLabels(t); return L.has(m[1]) && L.has('UNREAD'); }).length;
    return delay({ id: m[1], threadsUnread: n });
  }
  if (path === 'threads') {
    const ids = [].concat(q.labelIds || []);
    let list = [...D.threads.values()].filter((t) => {
      const L = tLabels(t);
      if (!ids.includes('TRASH') && t.messages.every((x) => x.labelIds.includes('TRASH'))) return false;
      if (!t.messages.length) return false;
      if (!ids.includes('SPAM') && t.messages.every((x) => x.labelIds.includes('SPAM'))) return false;
      return ids.every((i) => L.has(i)) && matchQ(t, q.q);
    }).sort((a, b) => tDate(b) - tDate(a));
    const start = Number(q.pageToken || 0), max = Number(q.maxResults || 25);
    const page = list.slice(start, start + max);
    return delay({ threads: page.map((t) => ({ id: t.id, historyId: t.historyId })), nextPageToken: start + max < list.length ? String(start + max) : undefined });
  }
  if ((m = /^threads\/(\w+)$/.exec(path))) { window.__ybCalls = window.__ybCalls || { metadata: 0, full: 0 }; window.__ybCalls[q.format] = (window.__ybCalls[q.format] || 0) + 1; return delay(fmtThread(D.threads.get(m[1]), q.format)); }
  if ((m = /^threads\/(\w+)\/modify$/.exec(path))) {
    const t = D.threads.get(m[1]);
    for (const x of t.messages) {
      x.labelIds = x.labelIds.filter((l) => !(body.removeLabelIds || []).includes(l));
      for (const l of body.addLabelIds || []) if (!x.labelIds.includes(l)) x.labelIds.push(l);
    }
    bump(t);
    return delay({});
  }
  if ((m = /^threads\/(\w+)\/(un)?trash$/.exec(path))) {
    const t = D.threads.get(m[1]);
    for (const x of t.messages) x.labelIds = m[2] ? x.labelIds.filter((l) => l !== 'TRASH') : [...x.labelIds.filter((l) => l !== 'INBOX'), 'TRASH'];
    if (m[2]) t.messages.forEach((x) => { if (!x.labelIds.includes('SENT')) x.labelIds.push('INBOX'); });
    bump(t);
    return delay({});
  }
  if ((m = /^messages\/\w+\/attachments\/(\w+)$/.exec(path))) { window.__ybAttCalls = (window.__ybAttCalls || 0) + 1; return delay({ data: D.att[m[1]], size: Math.round(D.att[m[1]].length * 0.75) }); }
  if ((m = /^messages\/(\w+)$/.exec(path)) && q.format === 'raw') return delay({ raw: b64u('From: demo@demo\r\nSubject: demo\r\n\r\n(점검용 원본)\r\n') });
  if (path === 'messages/send') {
    const raw = decodeBytes(b64ToBytes(body.raw));
    sent.push({ account: email, raw, threadId: body.threadId });
    window.__ybSent = sent;
    const subj = /^Subject: (.*(?:\r\n .*)*)/m.exec(raw)?.[1] || '';
    const decoded = subj.replace(/=\?UTF-8\?B\?([^?]+)\?=(\r\n )?/g, (_, b) => decodeBytes(b64ToBytes(b)));
    const tid = body.threadId || 't' + (++seq);
    if (!D.threads.has(tid)) D.threads.set(tid, { id: tid, historyId: '0', messages: [] });
    bump(D.threads.get(tid));
    D.threads.get(tid).messages.push(msg(email, tid, { from: `김영배 <${email}>`, to: (/^To: (.*)$/m.exec(raw) || [])[1], subject: decoded, min: 0, labels: ['SENT'], text: '(YB-Mail 점검용으로 보낸 메일)' }));
    return delay({ id: 'm' + seq, threadId: tid });
  }
  if ((m = /^messages\/(\w+)\/(un)?trash$/.exec(path))) {
    for (const t of D.threads.values()) for (const x of t.messages) if (x.id === m[1]) {
      x.labelIds = m[2] ? x.labelIds.filter((l) => l !== 'TRASH') : [...x.labelIds.filter((l) => l !== 'INBOX'), 'TRASH'];
      bump(t);
    }
    return delay({});
  }
  // 임시 저장
  if (path === 'drafts' && method === 'GET') return delay({ drafts: D.drafts.map((d) => ({ id: d.id, message: { id: d.mid, threadId: d.tid } })) });
  if ((path === 'drafts' && method === 'POST') || ((m = /^drafts\/(\w+)$/.exec(path)) && method === 'PUT')) {
    const raw = decodeBytes(b64ToBytes(body.message.raw));
    window.__ybDrafts = (window.__ybDrafts || []).concat(raw);
    let d = m ? D.drafts.find((x) => x.id === m[1]) : null;
    const tid = body.message.threadId || d?.tid || 't' + (++seq);
    if (!D.threads.has(tid)) D.threads.set(tid, { id: tid, historyId: '0', messages: [] });
    const t = D.threads.get(tid);
    if (d) t.messages = t.messages.filter((x) => x.id !== d.mid);
    const subj = (/^Subject: (.*(?:\r\n .*)*)/m.exec(raw)?.[1] || '').replace(/=\?UTF-8\?B\?([^?]+)\?=(\r\n )?/g, (_, b) => decodeBytes(b64ToBytes(b)));
    const html = (() => { const i = raw.indexOf('Content-Type: text/html'); if (i < 0) return ''; const j = raw.indexOf('\r\n\r\n', i); const k = raw.indexOf('\r\n--', j); return decodeBytes(b64ToBytes(raw.slice(j + 4, k).replace(/\r\n/g, ''))); })();
    const nm = msg(email, tid, { from: `김영배 <${email}>`, to: (/^To: (.*)$/m.exec(raw) || [])[1] || '', subject: subj, min: 0, labels: ['DRAFT'], html });
    t.messages.push(nm);
    bump(t);
    if (d) d.mid = nm.id; else { d = { id: 'r' + (++seq), mid: nm.id, tid }; D.drafts.push(d); }
    return delay({ id: d.id, message: { id: nm.id, threadId: tid } });
  }
  if ((m = /^drafts\/(\w+)$/.exec(path)) && method === 'DELETE') {
    const d = D.drafts.find((x) => x.id === m[1]);
    if (d) { const t = D.threads.get(d.tid); t.messages = t.messages.filter((x) => x.id !== d.mid); if (!t.messages.length) D.threads.delete(d.tid); else bump(t); D.drafts = D.drafts.filter((x) => x !== d); }
    return delay({});
  }
  // 필터(차단)
  if (path === 'settings/filters' && method === 'GET') return delay({ filter: D.filters });
  if (path === 'settings/filters' && method === 'POST') { const f = { id: 'f' + (++seq), ...body }; D.filters.push(f); return delay(f); }
  if ((m = /^settings\/filters\/(\w+)$/.exec(path)) && method === 'DELETE') { D.filters = D.filters.filter((f) => f.id !== m[1]); return delay({}); }
  return Promise.reject(new Error('demo: ' + path));
}

// 점검용 주소록(학교 디렉터리 흉내)
export const DEMO_PEOPLE = [
  ['김남은', 'miracle524@ssu.ac.kr'], ['김남수', '1@ssu.ac.kr'], ['김남수', 'nskim@ssu.ac.kr'], ['김남수', '777@ssu.ac.kr'],
  ['김남훈', 'knh2@ssu.ac.kr'], ['김남미', 'nammee@ssu.ac.kr'], ['김남숙', 'tbr211@ssu.ac.kr'], ['김남엽', 'namyup.kim@ssu.ac.kr'],
  ['박지훈', 'jhpark@ssu.ac.kr'], ['Jane Doe', 'jane@example.com'],
].map(([name, email]) => ({ name, email, photo: '', source: 'dir' }));

export function initDemo() {
  seed();
  // 점검용: 새 메일 도착 흉내
  window.__ybDemoNew = (acc = 'ybkim@ssu.ac.kr') => thread(acc, [{ from: '기획조정실 이○○ <plan@ssu.ac.kr>', to: acc, subject: '[긴급] 2027 대학혁신지원사업 계획서 제출 일정 변경', min: 0, labels: ['INBOX', 'UNREAD'], text: '팀장님, 계획서 제출 마감이 11. 20.(금)로 앞당겨졌습니다. 확인 부탁드립니다.' }]);
}
