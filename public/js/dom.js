// ============================================
// DOM helpers shared by the views: element builder, badges, accessible dialogs
// (focus trap, Escape, focus restore), prompts, downloads and a line diff.
// ============================================

export const $ = (id) => document.getElementById(id);

export function el(tag, { dataset, ...props } = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

/** replaceChildren() that skips null / false children (it would print them as text). */
export function fill(node, ...children) {
  node.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

export const RESULT_TEXT = { PASS: 'PASS', FAIL: 'FAIL', ERROR: 'HATA' };
export const STATUS_TEXT = { PENDING: 'bekliyor', RUNNING: 'çalışıyor', PASS: 'PASS', FAIL: 'FAIL', ERROR: 'HATA', SKIPPED: 'atlandı' };
const STATUS_BADGE = { PENDING: 'idle', RUNNING: 'run', PASS: 'pass', FAIL: 'fail', ERROR: 'error', SKIPPED: 'idle' };
export const SOURCE_TEXT = { hardware: 'gerçek kart', simulation: 'simülasyon', unknown: 'kaynak bilinmiyor' };
export const SAFETY_TEXT = {
  SAFE: 'Kart güvenli durumda: besleme kapalı (doğrulandı)',
  UNSAFE: 'KART GÜVENLİ DEĞİL: besleme kapanmadı',
  UNVERIFIED: 'Güvenli kapanma doğrulanamadı',
  NOT_CHECKED: 'Reçetede kapanma doğrulaması yok',
};

export const badge = (status, text = STATUS_TEXT[status] ?? status) =>
  el('span', { className: `badge badge-${STATUS_BADGE[status] ?? 'idle'}`, textContent: text });

export function formatDateTime(iso) {
  return iso ? new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'medium' }) : '';
}

export function duration(record) {
  const s = (Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000;
  return Number.isFinite(s) ? `${s.toFixed(1)} s` : '';
}

export function download(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

// ---------- dialogs ----------

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const openDialogs = [];

/**
 * Shows a modal (.modal element): traps Tab inside it, closes on Escape (unless
 * `escape` is false), and returns focus to where it was when it closes.
 * @returns {() => void} close function
 */
export function openModal(modal, { onClose, escape = true, initialFocus } = {}) {
  const previous = document.activeElement;
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  const focusables = () => [...modal.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
  (initialFocus ?? focusables()[0])?.focus();

  const onKey = (e) => {
    if (openDialogs.at(-1) !== entry) return;
    if (e.key === 'Escape' && escape) {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  const onBackdrop = (e) => {
    if (e.target === modal && escape) close();
  };
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', onKey, true);
    modal.removeEventListener('click', onBackdrop);
    openDialogs.splice(openDialogs.indexOf(entry), 1);
    if (previous?.isConnected) previous.focus();
    onClose?.();
  }
  const entry = { modal, close };
  openDialogs.push(entry);
  document.addEventListener('keydown', onKey, true);
  modal.addEventListener('click', onBackdrop);
  return close;
}

function stopButton({ label, onClick }) {
  const button = el('button', { type: 'button', className: 'btn btn-sm btn-stop', textContent: label });
  button.addEventListener('click', onClick);
  return button;
}

/** Generic dialog container reused by ask() / promptText(). */
function dialogShell(title) {
  const box = el('div', { className: 'modal-box confirm-box', role: 'document' });
  const modal = el('div', { className: 'modal', role: 'dialog', ariaModal: 'true', ariaLabel: title }, box);
  modal.setAttribute('aria-modal', 'true');
  document.body.append(modal);
  return { modal, box };
}

/**
 * Yes / no question. Keyboard: E or Y = yes, H or N = no (barcode-station friendly).
 * `stop` ({label, onClick}) adds a separate action, e.g. stopping the running test; it
 * should abort `signal`, which closes the dialog.
 * @returns {Promise<boolean>} rejects with an AbortError when the signal aborts
 */
export function ask(question, { title = 'Onay', yes = 'Evet', no = 'Hayır', signal, keys = true, danger = false, stop = null } = {}) {
  return new Promise((resolve, reject) => {
    const abort = () => Object.assign(new Error(signal.reason || 'İptal edildi'), { name: 'AbortError' });
    if (signal?.aborted) return reject(abort());
    const { modal, box } = dialogShell(title);
    const yesBtn = el('button', { type: 'button', className: `btn btn-lg ${danger ? 'confirm-no' : 'confirm-yes'}` }, yes, keys ? el('kbd', { textContent: 'E' }) : null);
    const noBtn = el('button', { type: 'button', className: `btn btn-lg ${danger ? 'confirm-yes' : 'confirm-no'}` }, no, keys ? el('kbd', { textContent: 'H' }) : null);
    box.append(
      el('div', { className: 'panel-head' }, el('h2', { textContent: title })),
      el(
        'div',
        { className: 'panel-body' },
        el('p', { className: 'confirm-question', textContent: question }),
        el('div', { className: 'row confirm-actions' }, yesBtn, noBtn),
        stop ? el('div', { className: 'confirm-stop' }, stopButton(stop)) : null
      )
    );
    const finish = (fn, value) => {
      document.removeEventListener('keydown', onKey, true);
      signal?.removeEventListener('abort', onAbort);
      close();
      modal.remove();
      fn(value);
    };
    const onKey = (e) => {
      if (!keys || e.target.closest?.('input, textarea')) return;
      const k = e.key.toLowerCase();
      if (k === 'e' || k === 'y') {
        e.preventDefault();
        finish(resolve, true);
      } else if (k === 'h' || k === 'n') {
        e.preventDefault();
        finish(resolve, false);
      }
    };
    const onAbort = () => finish(reject, abort());
    const close = openModal(modal, { escape: false, initialFocus: yesBtn });
    yesBtn.addEventListener('click', () => finish(resolve, true));
    noBtn.addEventListener('click', () => finish(resolve, false));
    document.addEventListener('keydown', onKey, true);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Asks for a short text (a reason, a note). Resolves with the trimmed text or null when cancelled.
 */
export function promptText(question, { title = 'Gerekçe', minLength = 1, placeholder = '', confirm = 'Devam' } = {}) {
  return new Promise((resolve) => {
    const { modal, box } = dialogShell(title);
    const input = el('textarea', { className: 'textarea', rows: 3, placeholder, maxLength: 500, ariaLabel: question });
    const error = el('p', { className: 'pt-errors', role: 'alert' });
    const ok = el('button', { type: 'submit', className: 'btn btn-primary', textContent: confirm });
    const cancel = el('button', { type: 'button', className: 'btn', textContent: 'Vazgeç' });
    const form = el('form', { className: 'panel-body' }, el('p', { className: 'confirm-question', textContent: question }), input, error, el('div', { className: 'row mt-md' }, ok, cancel));
    box.append(el('div', { className: 'panel-head' }, el('h2', { textContent: title })), form);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      close();
      modal.remove();
      resolve(value);
    };
    // Escape / backdrop close the dialog as "cancelled"
    const close = openModal(modal, { onClose: () => finish(null), initialFocus: input });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = input.value.trim();
      if (value.length < minLength) {
        error.textContent = `En az ${minLength} karakter girin`;
        input.focus();
        return;
      }
      finish(value);
    });
    cancel.addEventListener('click', () => finish(null));
  });
}

// ---------- diff ----------

/**
 * Line diff (longest common subsequence) between two texts.
 * @returns {{type: 'same'|'add'|'del', text: string}[]}
 */
export function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000) {
    // Too big for an exact LCS table: show everything as replaced
    return [...a.map((text) => ({ type: 'del', text })), ...b.map((text) => ({ type: 'add', text }))];
  }
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i += 1;
    } else {
      out.push({ type: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++] });
  while (j < b.length) out.push({ type: 'add', text: b[j++] });
  return out;
}

/** Renders a diff, collapsing long unchanged stretches. */
export function renderDiff(container, lines, context = 2) {
  const keep = lines.map((l, i) => l.type !== 'same' || lines.slice(Math.max(0, i - context), i + context + 1).some((x) => x.type !== 'same'));
  const out = [];
  let skipped = 0;
  lines.forEach((line, i) => {
    if (!keep[i]) {
      skipped += 1;
      return;
    }
    if (skipped) {
      out.push(el('div', { className: 'diff-line diff-skip', textContent: `… ${skipped} satır aynı` }));
      skipped = 0;
    }
    out.push(el('div', { className: `diff-line diff-${line.type}`, textContent: `${line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '} ${line.text}` }));
  });
  if (skipped) out.push(el('div', { className: 'diff-line diff-skip', textContent: `… ${skipped} satır aynı` }));
  if (!lines.some((l) => l.type !== 'same')) out.splice(0, out.length, el('div', { className: 'diff-line diff-skip', textContent: 'Fark yok' }));
  container.replaceChildren(...out);
}
