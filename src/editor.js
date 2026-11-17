// 메일 본문 편집기 — 커서 위치에 캡처 그림 붙여넣기, 모서리를 잡아 그림 크기 조절
import { b64ToBytes } from './mime.js';

const MAX_W = 640; // 붙여넣을 때 기본 표시 너비(px)

/** 붙여넣은 HTML 정리: 실행 요소·외부 서식 제거 */
export function sanitize(html) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  d.querySelectorAll('script,style,meta,link,iframe,object,embed,form,input,button,title,head,xml,o\\:p').forEach((n) => n.remove());
  d.querySelectorAll('*').forEach((n) => {
    for (const at of [...n.attributes]) {
      const nm = at.name.toLowerCase();
      if (nm.startsWith('on') || nm === 'class' || nm === 'id' || nm.startsWith('data-') || /^\s*javascript:/i.test(at.value)) n.removeAttribute(at.name);
    }
  });
  return d.body.innerHTML.replace(/<!--[\s\S]*?-->/g, '');
}

function readAsDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}
function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

/** 큰 그림은 줄여서(긴 변 1,920px, 1MB 이하 목표) 데이터 주소로 */
async function prepare(file) {
  let url = await readAsDataURL(file);
  const img = await loadImg(url);
  let w = img.naturalWidth, h = img.naturalHeight;
  if (file.size > 1024 * 1024 || Math.max(w, h) > 1920) {
    const k = Math.min(1, 1920 / Math.max(w, h));
    w = Math.round(w * k); h = Math.round(h * k);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    const png = c.toDataURL('image/png');
    url = png.length < 1.4 * 1024 * 1024 ? png : c.toDataURL('image/jpeg', 0.88);
  }
  return { url, w };
}

export function setupEditor(el, { onFiles } = {}) {
  let saved = null;
  el.addEventListener('focus', () => { lastEditor = api; });
  document.addEventListener('selectionchange', () => {
    const s = getSelection();
    if (s.rangeCount && el.contains(s.anchorNode)) saved = s.getRangeAt(0).cloneRange();
  });

  async function insertImages(files) {
    for (const f of files) {
      const { url, w } = await prepare(f);
      const img = document.createElement('img');
      img.src = url;
      img.alt = f.name && !/^image\.\w+$/.test(f.name) ? f.name : '그림';
      img.style.width = `${Math.min(w, MAX_W)}px`;
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
      const s = getSelection();
      let r = s.rangeCount && el.contains(s.anchorNode) ? s.getRangeAt(0) : saved;
      if (!r) { r = document.createRange(); r.selectNodeContents(el); r.collapse(false); }
      r.deleteContents();
      r.insertNode(img);
      r.setStartAfter(img); r.collapse(true);
      s.removeAllRanges(); s.addRange(r);
      saved = r.cloneRange();
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  el.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...dt.files];
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    const others = files.filter((f) => !f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      if (imgs.length) insertImages(imgs);
      if (others.length) onFiles?.(others);
      return;
    }
    const html = dt.getData('text/html');
    if (html) {
      e.preventDefault();
      document.execCommand('insertHTML', false, sanitize(html));
    }
  });
  el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); e.stopPropagation(); } });
  el.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault(); e.stopPropagation();
    // 놓은 위치로 커서 이동
    const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (pos) { const s = getSelection(); s.removeAllRanges(); s.addRange(pos); saved = pos; }
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    const others = files.filter((f) => !f.type.startsWith('image/'));
    if (imgs.length) insertImages(imgs);
    if (others.length) onFiles?.(others);
    document.dispatchEvent(new Event('ybm-drop-done'));
  });

  /* ── 그림 크기 조절 (네 모서리 손잡이) ── */
  const box = document.createElement('div');
  box.className = 'img-box';
  box.hidden = true;
  box.innerHTML = ['nw', 'ne', 'sw', 'se'].map((c) => `<i data-c="${c}"></i>`).join('') + '<b class="img-size"></b>';
  document.body.append(box);
  let sel = null;
  const place = () => {
    if (!sel || !el.contains(sel)) { hide(); return; }
    const r = sel.getBoundingClientRect();
    const host = el.closest('.cp-body')?.getBoundingClientRect();
    if (host && (r.bottom < host.top || r.top > host.bottom)) { box.style.visibility = 'hidden'; return; }
    box.style.visibility = '';
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    box.querySelector('.img-size').textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
  };
  const show = (img) => { sel = img; box.hidden = false; place(); };
  const hide = () => { sel = null; box.hidden = true; };
  el.addEventListener('click', (e) => { if (e.target.tagName === 'IMG') show(e.target); else hide(); });
  el.addEventListener('keydown', (e) => {
    if (!sel) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); sel.remove(); hide(); el.dispatchEvent(new Event('input', { bubbles: true })); }
    else hide();
  });
  el.closest('.cp-body')?.addEventListener('scroll', place);
  window.addEventListener('resize', place);
  box.addEventListener('pointerdown', (e) => {
    const c = e.target.dataset?.c;
    if (!c || !sel) return;
    e.preventDefault();
    const startX = e.clientX, startW = sel.getBoundingClientRect().width;
    const k = sel.offsetWidth ? startW / sel.offsetWidth : 1; // 쓰기 화면 배율(확대·축소) 보정
    const sign = c.includes('w') ? -1 : 1;
    const maxW = el.clientWidth - 8;
    const move = (ev) => {
      const w = Math.max(40 * k, Math.min(maxW * k, startW + sign * (ev.clientX - startX)));
      sel.style.width = `${Math.round(w / k)}px`;
      sel.style.height = 'auto';
      sel.removeAttribute('width'); sel.removeAttribute('height');
      place();
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); el.dispatchEvent(new Event('input', { bubbles: true })); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });

  const api = {
    el, insertImages, hide, place,
    /** 도구함 조작 전에 편집기 안 선택 영역 되살리기 */
    restore() {
      el.focus({ preventScroll: true });
      if (saved) { const s = getSelection(); s.removeAllRanges(); s.addRange(saved); }
    },
  };
  el._ybEditor = api;
  return api;
}

/* ───────── 서식 도구함 ───────── */
let lastEditor = null;
export const activeEditor = () => lastEditor;

export const FONTS = [
  { label: '맑은 고딕', value: "'Malgun Gothic','맑은 고딕',sans-serif" },
  { label: '굴림', value: "Gulim,'굴림',sans-serif" },
  { label: '돋움', value: "Dotum,'돋움',sans-serif" },
  { label: '바탕', value: "Batang,'바탕',serif" },
  { label: '궁서', value: "Gungsuh,'궁서',serif" },
  { label: '나눔고딕', value: "'Nanum Gothic','나눔고딕',sans-serif" },
  { label: 'Arial', value: 'Arial,sans-serif' },
  { label: 'Times New Roman', value: "'Times New Roman',serif" },
  { label: 'Courier New', value: "'Courier New',monospace" },
];
export const SIZES = ['10px', '11px', '12px', '13px', '14.5px', '16px', '18px', '20px', '24px', '28px', '32px'];
/* 글자색: 저장값은 그대로(받는 사람은 흰 바탕), 다크 모드 쓰기 화면에서만 밝은 톤으로 표시 — YB-EverNote와 같은 방식 */
export const TEXT_COLORS = [
  { label: '검정', color: '#111111' },
  { label: '군청', color: '#1F3A93' },
  { label: '파랑', color: '#1565C0' },
  { label: '빨강', color: '#D32F2F' },
  { label: '주황', color: '#E65100' },
  { label: '초록', color: '#2E7D32' },
  { label: '보라', color: '#6A1B9A' },
  { label: '회색', color: '#757575' },
];
export const HIGHLIGHTS = [
  { label: '노랑', color: '#FFF176' },
  { label: '연두', color: '#C5E1A5' },
  { label: '분홍', color: '#F8BBD0' },
  { label: '하늘', color: '#B3E5FC' },
  { label: '주황', color: '#FFCC80' },
];

const SENTINEL_FG = 'rgb(1, 2, 3)';
const SENTINEL_BG = 'rgb(1, 2, 4)';
/** 서식 적용 (편집기 = setupEditor 결과) */
export function format(ed, cmd, value) {
  if (!ed) return;
  ed.restore();
  document.execCommand('styleWithCSS', false, true);
  const root = ed.el;
  if (cmd === 'fontName') document.execCommand('fontName', false, value);
  else if (cmd === 'fontSize') {
    document.execCommand('fontSize', false, '7');
    root.querySelectorAll('font[size="7"]').forEach((f) => { const sp = document.createElement('span'); sp.style.fontSize = value; sp.append(...f.childNodes); f.replaceWith(sp); });
    root.querySelectorAll('[style*="xxx-large"]').forEach((n) => { n.style.fontSize = value; });
  } else if (cmd === 'foreColor') {
    if (value) document.execCommand('foreColor', false, value);
    else { document.execCommand('foreColor', false, SENTINEL_FG); root.querySelectorAll('[style]').forEach((n) => { if (n.style.color === SENTINEL_FG) n.style.color = ''; }); }
  } else if (cmd === 'hiliteColor') {
    if (value) document.execCommand('hiliteColor', false, value);
    else { document.execCommand('hiliteColor', false, SENTINEL_BG); root.querySelectorAll('[style]').forEach((n) => { if (n.style.backgroundColor === SENTINEL_BG) n.style.backgroundColor = ''; }); }
  } else document.execCommand(cmd, false, value ?? null);
  // 빈 style 정리
  root.querySelectorAll('span[style=""]').forEach((n) => n.replaceWith(...n.childNodes));
  root.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 도구함 HTML (글꼴·크기·글자색·형광펜·굵게·기울임·밑줄) */
export function toolbarHtml() {
  return `<div class="fmt" role="toolbar" aria-label="서식">
    <select class="sel fmt-font" data-fmt="fontName" title="글꼴">${FONTS.map((f, i) => `<option value="${f.value}"${i ? '' : ' selected'}>${f.label}</option>`).join('')}</select>
    <select class="sel fmt-size" data-fmt="fontSize" title="글자 크기">${SIZES.map((z) => `<option value="${z}"${z === '14.5px' ? ' selected' : ''}>${parseFloat(z)}</option>`).join('')}</select>
    <button type="button" class="fmt-b" data-fmt="bold" title="굵게 (Ctrl+B)"><b>가</b></button>
    <button type="button" class="fmt-b" data-fmt="italic" title="기울임 (Ctrl+I)"><i>가</i></button>
    <button type="button" class="fmt-b" data-fmt="underline" title="밑줄 (Ctrl+U)"><u>가</u></button>
    <button type="button" class="fmt-b fmt-pal" data-pal="fg" title="글자 색"><span class="fmt-a">가</span><i class="fmt-bar" style="background:#D32F2F"></i></button>
    <button type="button" class="fmt-b fmt-pal" data-pal="bg" title="형광펜(배경색)"><span class="fmt-hl">🖍</span><i class="fmt-bar" style="background:#FFF176"></i></button>
  </div>`;
}
export function paletteHtml(kind) {
  const list = kind === 'fg' ? TEXT_COLORS : HIGHLIGHTS;
  const cmd = kind === 'fg' ? 'foreColor' : 'hiliteColor';
  return `<div class="pal"><div class="pop-h">${kind === 'fg' ? '글자 색' : '형광펜 (배경색)'}</div><div class="pal-grid">${list.map((c) => `<button data-k="${cmd}|${c.color}" class="sw ${kind}" data-c="${c.color}" style="--c:${c.color}" title="${c.label}">${kind === 'fg' ? '가' : ''}</button>`).join('')}<button data-k="${cmd}|" class="sw none" title="${kind === 'fg' ? '기본 색' : '지우기'}">${kind === 'fg' ? '자동' : '⌀'}</button></div></div>`;
}

/**
 * 보낼 HTML 만들기: data: 그림 → cid: 로 바꾸고 첨부 목록 반환
 * @returns {{html:string, inline:{cid,name,type,bytes}[]}}
 */
export function extractInline(html) {
  const d = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const inline = [];
  d.querySelectorAll('img[src^="data:"]').forEach((img, i) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(img.getAttribute('src') || '');
    if (!m) { img.remove(); return; }
    const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg');
    const cid = `img${i + 1}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}@ybmail`;
    inline.push({ cid, name: `image${i + 1}.${ext}`, type: m[1], bytes: b64ToBytes(m[2]) });
    img.setAttribute('src', `cid:${cid}`);
    const w = parseInt(img.style.width, 10);
    if (w) img.setAttribute('width', String(w));
  });
  return { html: d.getElementById('root').innerHTML, inline };
}
