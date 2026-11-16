// Google 로그인(계정별 접근 토큰) — Google Identity Services 토큰 방식
// · 서버 없이 브라우저에서만 동작: 토큰은 1시간짜리이며 이 기기에만 보관
// · 계정을 여러 개 등록하고, 계정마다 따로 토큰을 받음(login_hint로 계정 지정)
import { CLIENT_ID, SCOPES, ACCOUNT_COLORS, PEOPLE_SCOPES } from './config.js';

// 점검용(?demo)은 따로 보관 → 실제 계정 목록과 섞이지 않음
const P = new URLSearchParams(location.search).has('demo') ? 'ybm-demo-' : 'ybm-';
const K_ACC = P + 'accounts';
const K_TOK = P + 'tok-';
const K_CID = 'ybm-client-id';

const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 무시 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};

export class AuthError extends Error {
  constructor(email, msg = '다시 연결이 필요합니다') { super(msg); this.email = email; this.name = 'AuthError'; }
}

/* ───────── 데스크톱 프로그램(YB-Mail.exe) ───────── */
// 프로그램 안에서는 window.ybDesktop 이 있음 → 로그인은 기본 브라우저에서, 연결 유지는 갱신 토큰(1시간 재연결 없음)
const D = typeof window !== 'undefined' ? window.ybDesktop : null;
export const isDesktop = !!D;

/* ───────── 클라이언트 ID ───────── */
export const clientId = () => (D ? 'desktop' : CLIENT_ID || ls.get(K_CID, '') || '');
export const setClientId = (v) => ls.set(K_CID, String(v || '').trim());

/* ───────── 계정 목록 ───────── */
export function accounts() { return ls.get(K_ACC, []); }
function saveAccounts(list) { ls.set(K_ACC, list); listeners.forEach((f) => f()); }
export function updateAccount(email, patch) {
  saveAccounts(accounts().map((a) => (a.email === email ? { ...a, ...patch } : a)));
}
export function moveAccount(email, dir) {
  const list = accounts();
  const i = list.findIndex((a) => a.email === email);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  saveAccounts(list);
}
const listeners = new Set();
export const onChange = (f) => { listeners.add(f); return () => listeners.delete(f); };

/* ───────── 토큰 ───────── */
const NEED = SCOPES.split(' ');
/** 권한이 모두 있는 토큰만 인정 (권한이 늘면 한 번 다시 동의) */
const fullScope = (t) => t.t === 'demo' || (t.scope && NEED.every((sc) => t.scope.split(' ').includes(sc)));
export function token(email) {
  const t = ls.get(K_TOK + email);
  return t && t.exp > Date.now() + 30_000 && fullScope(t) ? t.t : null;
}
export function tokenLeft(email) {
  const t = ls.get(K_TOK + email);
  return t && fullScope(t) ? t.exp - Date.now() : -1;
}
export function dropToken(email) { ls.del(K_TOK + email); listeners.forEach((f) => f()); }
const saveToken = (email, r) => ls.set(K_TOK + email, { t: r.access_token, scope: r.scope || SCOPES, exp: Date.now() + (Number(r.expires_in) || 3599) * 1000 });

/* ───────── Google 스크립트 ───────── */
let gisP = null;
export function loadGis() {
  if (D || window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisP) return gisP;
  gisP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => res();
    s.onerror = () => { gisP = null; rej(new Error('Google 로그인 스크립트를 불러오지 못했습니다(인터넷 연결 확인)')); };
    document.head.appendChild(s);
  });
  return gisP;
}

/** 팝업으로 토큰 요청 — 반드시 클릭(사용자 동작) 안에서 호출해야 팝업이 차단되지 않음 */
function requestToken(override, scope = SCOPES) {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) { reject(new Error('Google 로그인 준비 중입니다. 잠시 뒤 다시 누르세요.')); return; }
    const cid = clientId();
    if (!cid) { reject(new Error('클라이언트 ID가 설정되지 않았습니다')); return; }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: cid,
      scope,
      include_granted_scopes: true, // 이미 받은 권한(메일·주소록)을 합친 토큰
      callback: (r) => {
        if (r.error) { reject(new Error(errText(r.error, r.error_description))); return; }
        if (!google.accounts.oauth2.hasGrantedAllScopes(r, ...SCOPES.split(' '))) {
          reject(new Error('권한 항목 중 체크하지 않은 것이 있습니다. 다시 연결하면서 Gmail 관련 항목(메일·설정)을 모두 체크해 주세요.'));
          return;
        }
        resolve(r);
      },
      error_callback: (e) => reject(new Error(e?.type === 'popup_closed' ? '로그인 창을 닫았습니다' : e?.type === 'popup_failed_to_open' ? '팝업이 차단되었습니다. 브라우저 주소창의 팝업 허용을 눌러 주세요.' : (e?.message || '로그인 실패'))),
    });
    client.requestAccessToken(override);
  });
}

function errText(code, desc) {
  const map = {
    access_denied: '접근이 거부되었습니다(학교 계정이면 관리자 정책, 개인 계정이면 테스트 사용자 등록을 확인)',
    admin_policy_enforced: '학교(조직) 관리자 정책으로 이 앱이 차단되어 있습니다',
    rate_limit_exceeded: 'Google 로그인 속도 제한에 걸렸습니다. 잠시 뒤 다시 시도하세요',
  };
  return map[code] || `${code}${desc ? ' — ' + desc : ''}`;
}

async function whoAmI(accessToken) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`계정 확인 실패 (${r.status})`);
  return r.json(); // { emailAddress, messagesTotal, threadsTotal, historyId }
}

function addToList(email) {
  const list = accounts();
  if (!list.some((a) => a.email === email)) {
    const used = new Set(list.map((a) => a.color));
    const color = ACCOUNT_COLORS.find((c) => !used.has(c)) || ACCOUNT_COLORS[list.length % ACCOUNT_COLORS.length];
    list.push({ email, color, label: email.split('@')[1] === 'gmail.com' ? '개인' : email.split('@')[1].split('.')[0].toUpperCase(), name: '', signature: '' });
    saveAccounts(list);
  } else listeners.forEach((f) => f());
}

/** 새 계정 추가 (계정 선택 창) */
export async function addAccount() {
  if (D) { const r = await D.signIn(); saveToken(r.email, r); addToList(r.email); return r.email; }
  const r = await requestToken({ prompt: 'select_account consent' });
  const p = await whoAmI(r.access_token);
  const email = p.emailAddress.toLowerCase();
  saveToken(email, r);
  const list = accounts();
  if (!list.some((a) => a.email === email)) {
    const used = new Set(list.map((a) => a.color));
    const color = ACCOUNT_COLORS.find((c) => !used.has(c)) || ACCOUNT_COLORS[list.length % ACCOUNT_COLORS.length];
    list.push({ email, color, label: email.split('@')[1] === 'gmail.com' ? '개인' : email.split('@')[1].split('.')[0].toUpperCase(), name: '', signature: '' });
    saveAccounts(list);
  } else listeners.forEach((f) => f());
  return email;
}

/** 등록된 계정 다시 연결 — 이미 허락한 계정이면 창이 잠깐 떴다 닫힘 */
const pending = new Map();
export function reconnect(email, { force = false } = {}) {
  if (pending.has(email)) return pending.get(email);
  const p = (async () => {
    if (D) {
      // 저장된 갱신 토큰으로 먼저 (창 없음), 안 되면 브라우저 로그인
      let r = force ? null : await D.token(email);
      if (!r || r.error) r = await D.signIn(email);
      saveToken(email, r);
      listeners.forEach((f) => f());
      return email;
    }
    const r = await requestToken({ prompt: force ? 'consent' : '', login_hint: email });
    const who = await whoAmI(r.access_token);
    if (who.emailAddress.toLowerCase() !== email) {
      throw new Error(`다른 계정(${who.emailAddress})이 선택되었습니다. ${email} 계정을 골라 주세요.`);
    }
    saveToken(email, r);
    listeners.forEach((f) => f());
    return email;
  })().finally(() => pending.delete(email));
  pending.set(email, p);
  return p;
}
export const isReconnecting = (email) => pending.has(email);

/* ───────── 주소록 검색 권한 (선택) ───────── */
const ALL_PEOPLE = PEOPLE_SCOPES;
/** 이 계정 토큰이 가진 권한 목록 */
export function grantedScopes(email) {
  const t = ls.get(K_TOK + email);
  if (t?.t === 'demo') return [...SCOPES.split(' '), ...ALL_PEOPLE];
  return String(t?.scope || '').split(' ').filter(Boolean);
}
export const hasPeople = (email) => { const g = grantedScopes(email); return ALL_PEOPLE.some((s) => g.includes(s)); };
/** 주소록 검색 권한 동의 (계정별 한 번). 반드시 클릭 안에서 호출 */
export async function grantPeople(email, scopes = ALL_PEOPLE) {
  if (D) {
    const r = await D.signIn(email, scopes);
    saveToken(email, r);
  } else {
    const r = await new Promise((resolve, reject) => {
      if (!window.google?.accounts?.oauth2) { reject(new Error('Google 로그인 준비 중입니다. 잠시 뒤 다시 누르세요.')); return; }
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId(),
        scope: [...SCOPES.split(' '), ...scopes].join(' '),
        include_granted_scopes: true,
        callback: (x) => (x.error ? reject(new Error(errText(x.error, x.error_description))) : resolve(x)),
        error_callback: (e) => reject(new Error(e?.type === 'popup_closed' ? '로그인 창을 닫았습니다' : (e?.message || '동의 실패'))),
      });
      client.requestAccessToken({ prompt: 'consent', login_hint: email });
    });
    const who = await whoAmI(r.access_token);
    if (who.emailAddress.toLowerCase() !== email) throw new Error(`다른 계정(${who.emailAddress})이 선택되었습니다. ${email} 계정을 골라 주세요.`);
    if (!NEED.every((sc) => String(r.scope).split(' ').includes(sc))) throw new Error('메일 권한 항목도 체크해 주세요.');
    saveToken(email, r);
  }
  listeners.forEach((f) => f());
  return hasPeople(email);
}

/** 데스크톱: 프로그램에 연결 정보가 남아 있는데 목록에 없는 계정 되살리기 */
export async function desktopRestore() {
  if (!D) return;
  try { for (const email of await D.accounts()) addToList(email); } catch { /* 무시 */ }
}
/** 데스크톱: 창 없이 토큰 새로 받기 (갱신 토큰). 성공하면 true */
export async function silentRefresh(email) {
  if (!D) return false;
  try {
    const r = await D.token(email);
    if (!r || r.error) return false;
    saveToken(email, r);
    return true;
  } catch { return false; }
}
/** 데스크톱: 만료가 가까운 계정 모두 조용히 갱신 */
export async function refreshAllSilently(minLeftMs = 10 * 60_000) {
  if (!D) return;
  let changed = false;
  for (const a of accounts()) if (tokenLeft(a.email) < minLeftMs && (await silentRefresh(a.email))) changed = true;
  if (changed) listeners.forEach((f) => f());
}

export function removeAccount(email) {
  if (D) D.signOut(email).catch(() => {});
  const t = token(email);
  if (t && window.google?.accounts?.oauth2) { try { google.accounts.oauth2.revoke(t, () => {}); } catch { /* 무시 */ } }
  ls.del(K_TOK + email);
  saveAccounts(accounts().filter((a) => a.email !== email));
}

/* ───────── 점검용(?demo) ───────── */
export function demoSetup(list) {
  ls.set(K_ACC, list);
  for (const a of list) ls.set(K_TOK + a.email, { t: 'demo', exp: Date.now() + 3600_000 });
}
