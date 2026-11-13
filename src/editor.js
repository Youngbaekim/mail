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
    const sign = c.includes('w') ? -1 : 1;
    const maxW = el.clientWidth - 8;
    const move = (ev) => {
      const w = Math.max(40, Math.min(maxW, startW + sign * (ev.clientX - startX)));
      sel.style.width = `${Math.round(w)}px`;
      sel.style.height = 'auto';
      sel.removeAttribute('width'); sel.removeAttribute('height');
      place();
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); el.dispatchEvent(new Event('input', { bubbles: true })); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });

  return { insertImages, hide, place };
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
