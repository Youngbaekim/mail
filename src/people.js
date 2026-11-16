// 주소록 검색 (Google People API) — 받는 사람 자동 완성
// ① 학교 디렉터리(같은 도메인 구성원) ② 내 연락처 ③ 기타 연락처(주고받으며 자동으로 쌓인 주소)
// 계정마다 '주소록 검색' 권한을 한 번 동의해야 함(읽기 전용). 권한이 없는 출처는 건너뜀
import { token } from './auth.js';
import { PEOPLE_SCOPES } from './config.js';

const BASE = 'https://people.googleapis.com/v1/';
const [SC_CONTACTS, SC_OTHER, SC_DIR] = PEOPLE_SCOPES;
let demo = null; // 점검용(?demo) 가짜 결과
export const useDemo = (fn) => { demo = fn; };

const warmed = new Set();
const noDir = new Set(); // 디렉터리가 없는 계정(개인 Gmail 등)·막힌 계정은 다시 묻지 않음
const memo = new Map(); // `${email}|${q}` → 결과

async function get(email, path, query) {
  const t = token(email);
  if (!t) return null;
  const qs = new URLSearchParams(Object.entries(query).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])));
  const r = await fetch(`${BASE}${path}?${qs}`, { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) { const e = new Error(`People ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}

function pick(p, source) {
  const name = p.names?.[0]?.displayName || '';
  const photo = p.photos?.find((x) => !x.default)?.url || '';
  return (p.emailAddresses || []).filter((e) => e.value).map((e) => ({ name, email: e.value.toLowerCase(), photo, source }));
}

/** 검색어 q로 email 계정의 세 출처를 함께 검색 → [{ name, email, photo, source }] */
export async function search(email, q, scopes) {
  if (demo) return demo(q);
  const key = `${email}|${q}`;
  if (memo.has(key)) return memo.get(key);
  const has = (s) => scopes.includes(s);
  const jobs = [];
  const RM = 'names,emailAddresses,photos';
  // 연락처 검색은 첫 검색 전에 빈 검색으로 '데우기'가 필요(Google 권장)
  const warm = async (path, readMask) => { if (warmed.has(email + path)) return; warmed.add(email + path); await get(email, path, { query: '', readMask, pageSize: 1 }).catch(() => {}); };
  if (has(SC_CONTACTS)) jobs.push(warm('people:searchContacts', RM).then(() => get(email, 'people:searchContacts', { query: q, readMask: RM, pageSize: 10 })).then((r) => (r?.results || []).flatMap((x) => pick(x.person, 'contact'))));
  if (has(SC_OTHER)) jobs.push(warm('otherContacts:search', 'names,emailAddresses').then(() => get(email, 'otherContacts:search', { query: q, readMask: 'names,emailAddresses', pageSize: 10 })).then((r) => (r?.results || []).flatMap((x) => pick(x.person, 'other'))));
  if (has(SC_DIR) && !noDir.has(email)) {
    jobs.push(get(email, 'people:searchDirectoryPeople', { query: q, readMask: RM, pageSize: 15, sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE', 'DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT'] })
      .then((r) => (r?.people || []).flatMap((p) => pick(p, 'dir')))
      .catch((e) => { if (e.status === 400 || e.status === 403) noDir.add(email); return []; }));
  }
  const out = (await Promise.all(jobs.map((j) => j.catch(() => [])))).flat();
  memo.set(key, out);
  if (memo.size > 300) memo.delete(memo.keys().next().value);
  return out;
}
