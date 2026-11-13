// 메일 원문(RFC 5322/MIME) 만들기·풀기 — 한글 제목·이름·본문·첨부 처리
const enc = new TextEncoder();

/* ───────── base64 ───────── */
export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export const toB64url = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();

/** 글자 집합에 맞춰 바이트 → 문자열 (EUC-KR 등 포함) */
const KOR = /^(euc-kr|ks_c_5601-1987|ks_c_5601|cp949|x-windows-949|windows-949|uhc|euc_kr|ksc5601|korean)$/;
/** 바이트가 올바른 UTF-8이면 그 문자열, 아니면 null */
function tryUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}
const hasMultibyte = (bytes) => { for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80) return true; return false; };
/**
 * 바이트 → 문자열. 표시된 글자 집합이 틀린 메일 대비:
 *  · EUC-KR(ks_c_5601)이라 적혀 있지만 실제로는 UTF-8인 경우 → UTF-8로 (일부 업무 메일 시스템)
 *  · UTF-8이라 적혀 있지만 UTF-8이 아닌 경우 → EUC-KR로
 */
export function decodeBytes(bytes, charset = 'utf-8') {
  let cs = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '').trim();
  if (KOR.test(cs)) cs = 'euc-kr';
  if (hasMultibyte(bytes)) {
    if (cs === 'euc-kr') { const u = tryUtf8(bytes); if (u != null) return u; }
    else if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') {
      const u = tryUtf8(bytes); if (u != null) return u;
      try { return new TextDecoder('euc-kr').decode(bytes); } catch { /* 아래로 */ }
    }
  }
  try { return new TextDecoder(cs).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

/* ───────── 머리글 ───────── */
const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);
/** 비ASCII 머리글 → =?UTF-8?B?…?= (낱말 하나당 45바이트 이하, 글자 중간에서 자르지 않음) */
export function encodeWord(str) {
  str = String(str ?? '');
  if (isAscii(str)) return str;
  const parts = [];
  let cur = '';
  for (const ch of str) {
    if (enc.encode(cur + ch).length > 45) { parts.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts.map((p) => `=?UTF-8?B?${bytesToB64(enc.encode(p))}?=`).join('\r\n ');
}

/** '홍길동 <a@b.com>, c@d.com; "이름" <e@f>' → [{name, email}] */
export function parseAddrList(s) {
  const out = [];
  if (!s) return out;
  let buf = '', q = false, ang = false;
  const push = () => {
    const t = buf.trim(); buf = '';
    if (!t) return;
    const m = /^(.*?)<([^>]+)>\s*$/.exec(t);
    if (m) out.push({ name: m[1].trim().replace(/^"|"$/g, '').trim(), email: m[2].trim() });
    else out.push({ name: '', email: t.replace(/^"|"$/g, '') });
  };
  for (const ch of s) {
    if (ch === '"') q = !q;
    else if (ch === '<') ang = true;
    else if (ch === '>') ang = false;
    if ((ch === ',' || ch === ';') && !q && !ang) { push(); continue; }
    buf += ch;
  }
  push();
  return out;
}
export const validEmail = (e) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(e);

export function formatAddr({ name, email }) {
  if (!name) return email;
  if (isAscii(name)) return `"${name.replace(/"/g, '')}" <${email}>`;
  return `${encodeWord(name)} <${email}>`;
}
const fmtList = (s) => parseAddrList(s).map(formatAddr).join(', ');

/* ───────── 원문 만들기 ───────── */
const boundary = () => '----=_YBMail_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
const b64Part = (type, str) => `Content-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(bytesToB64(enc.encode(str)))}\r\n`;

/** 파일 이름(한글) → RFC 2231 + 예전 방식 둘 다 */
function dispName(name) {
  if (isAscii(name)) return `filename="${name.replace(/"/g, '')}"`;
  return `filename="${encodeWord(name).replace(/\r\n /g, ' ')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * @param {object} m { from:{name,email}, to, cc, bcc, subject, text, html, inReplyTo, references, attachments:[{name,type,bytes}], inline:[{cid,name,type,bytes}] }
 * @returns {string} 메일 원문(ASCII 문자열)
 */
export function buildRaw(m) {
  const H = [];
  H.push(`From: ${formatAddr(m.from)}`);
  if (m.to) H.push(`To: ${fmtList(m.to)}`);
  if (m.cc) H.push(`Cc: ${fmtList(m.cc)}`);
  if (m.bcc) H.push(`Bcc: ${fmtList(m.bcc)}`);
  H.push(`Subject: ${encodeWord(m.subject || '')}`);
  H.push(`Date: ${new Date().toUTCString().replace('GMT', '+0000')}`);
  if (m.inReplyTo) H.push(`In-Reply-To: ${m.inReplyTo}`);
  if (m.references) H.push(`References: ${m.references}`);
  H.push('MIME-Version: 1.0');
  H.push('X-Mailer: YB-Mail');

  // 본문 속 그림(붙여넣은 캡처)은 multipart/related + Content-ID 로 넣어야 Gmail·Outlook에서 보임
  let htmlPart = b64Part('text/html', m.html || '');
  if (m.inline?.length) {
    const bRel = boundary();
    htmlPart = `Content-Type: multipart/related; boundary="${bRel}"\r\n\r\n--${bRel}\r\n${htmlPart}`;
    for (const im of m.inline) {
      htmlPart += `--${bRel}\r\nContent-Type: ${im.type}; name="${im.name}"\r\nContent-Transfer-Encoding: base64\r\n` +
        `Content-ID: <${im.cid}>\r\nContent-Disposition: inline; filename="${im.name}"\r\n\r\n${wrap76(bytesToB64(im.bytes))}\r\n`;
    }
    htmlPart += `--${bRel}--\r\n`;
  }
  const bAlt = boundary();
  const alt = `Content-Type: multipart/alternative; boundary="${bAlt}"\r\n\r\n` +
    `--${bAlt}\r\n${b64Part('text/plain', m.text || '')}` +
    `--${bAlt}\r\n${htmlPart}` +
    `--${bAlt}--\r\n`;

  let body;
  const atts = m.attachments || [];
  if (!atts.length) body = alt;
  else {
    const bMix = boundary();
    body = `Content-Type: multipart/mixed; boundary="${bMix}"\r\n\r\n--${bMix}\r\n${alt}`;
    for (const a of atts) {
      const type = a.type || 'application/octet-stream';
      body += `--${bMix}\r\nContent-Type: ${type}; name="${isAscii(a.name) ? a.name : encodeWord(a.name).replace(/\r\n /g, ' ')}"\r\n` +
        `Content-Disposition: attachment; ${dispName(a.name)}\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
        `${wrap76(bytesToB64(a.bytes))}\r\n`;
    }
    body += `--${bMix}--\r\n`;
  }
  return H.join('\r\n') + '\r\n' + body;
}

/* ───────── 받은 메일 풀기 (Gmail API payload) ───────── */
/** =?UTF-8?B?…?= / =?EUC-KR?Q?…?= 머리글 풀기 (Gmail은 대개 이미 풀어서 주지만 예외 대비) */
export function decodeWords(s) {
  if (!s || !s.includes('=?')) return s || '';
  return s.replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (all, cs, mode, data) => {
    try {
      let bytes;
      if (mode.toUpperCase() === 'B') bytes = b64ToBytes(data);
      else {
        const t = data.replace(/_/g, ' ');
        const arr = [];
        for (let i = 0; i < t.length; i++) {
          if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { arr.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; } else arr.push(t.charCodeAt(i));
        }
        bytes = new Uint8Array(arr);
      }
      return decodeBytes(bytes, cs);
    } catch { return all; }
  });
}
const hdr = (headers, name) => decodeWords((headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '');
export { hdr };

function charsetOf(part) {
  const ct = hdr(part.headers, 'Content-Type');
  const m = /charset\s*=\s*"?([^";\s]+)/i.exec(ct);
  return m ? m[1] : 'utf-8';
}

/** payload → { html, text, attachments:[{filename,mimeType,size,attachmentId,data,contentId,inline}] } */
export function parsePayload(payload) {
  const res = { html: '', text: '', attachments: [] };
  const walk = (p) => {
    if (!p) return;
    const mt = (p.mimeType || '').toLowerCase();
    const cid = hdr(p.headers, 'Content-ID').replace(/^<|>$/g, '');
    const disp = hdr(p.headers, 'Content-Disposition').toLowerCase();
    if (p.parts?.length) { p.parts.forEach(walk); return; }
    const isFile = !!p.filename || (p.body?.attachmentId && !mt.startsWith('text/'));
    if (isFile) {
      res.attachments.push({
        filename: p.filename || (cid ? `${cid}` : '첨부파일'),
        mimeType: p.mimeType || 'application/octet-stream',
        size: p.body?.size || 0,
        attachmentId: p.body?.attachmentId || null,
        data: p.body?.data || null,
        contentId: cid,
        inline: !!cid && !disp.startsWith('attachment'),
      });
      return;
    }
    if (!p.body?.data) return;
    const str = decodeBytes(b64ToBytes(p.body.data), charsetOf(p));
    if (mt === 'text/html' && !res.html) res.html = str;
    else if (mt === 'text/plain' && !res.text) res.text = str;
  };
  walk(payload);
  return res;
}

/* ───────── 본문 변환 ───────── */
export const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function textToHtml(t) {
  return escHtml(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\r?\n/g, '<br>');
}
export function htmlToText(html) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  d.querySelectorAll('style,script,head').forEach((n) => n.remove());
  d.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
  d.querySelectorAll('td,th').forEach((n) => n.append('\t'));
  d.querySelectorAll('p,div,tr,li,h1,h2,h3,h4,blockquote').forEach((n) => n.append('\n'));
  return (d.body?.textContent || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\t/g, '  ').replace(/\n{3,}/g, '\n\n').trim();
}
