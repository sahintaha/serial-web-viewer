// ============================================
// PRODUCTS & RECIPES — engineers edit a draft, review the diff against the
// published revision and publish it with a note; published revisions never
// change. Archive / restore need a reason. Operators see the recipe read-only.
// Every change is written to the audit log by the store (who / when / what / why).
// ============================================

import { validateProduct, formatValue, EVALUATION_MODES } from './recipe.js';
import { $, el, ask, promptText, download, formatDateTime, diffLines, renderDiff } from './dom.js';

const TYPE_TEXT = { command: 'komut', measure: 'ölçüm', delay: 'bekle', confirm: 'operatör' };
const REV_STATUS = { draft: 'taslak', published: 'yayında', superseded: 'eski' };
const FIELDS = ['pr-code', 'pr-name', 'pr-mask', 'pr-attempts', 'pr-max-errors', 'pr-protocol', 'pr-heartbeat', 'pr-recipe'];

const NEW_TEMPLATE = {
  code: '',
  name: '',
  serialMask: 'ABC-######',
  maxAttempts: 3,
  maxErrors: 3,
  protocol: 'v2',
  heartbeatMs: 1000,
  recipe: {
    stopOnFail: true,
    steps: [
      { type: 'command', name: 'Kimlik', send: 'ID?', expect: 'SVB-* *', capture: 'firmware' },
      { type: 'command', name: 'Seri numarasını yaz', send: 'SN {serial}', expect: 'OK' },
      { type: 'command', name: 'Beslemeyi aç', send: 'PWR ON', expect: 'OK' },
      { type: 'delay', name: 'Oturma süresi', ms: 300 },
      { type: 'measure', name: 'Ölçüm', send: 'MEAS?', samples: 5, intervalMs: 100, evaluate: 'mean', limits: [{ key: 'V', name: 'Voltaj', unit: 'V', min: 4.9, max: 5.1 }] },
    ],
    teardown: [
      { type: 'command', name: 'Beslemeyi kapat', send: 'PWR OFF', expect: 'OK', critical: true, retries: 2 },
      { type: 'command', name: 'Kapanmayı doğrula', send: 'STATUS?', expect: 'PWR=0 *', critical: true },
    ],
  },
};

const definitionOf = (p) => ({
  code: p.code,
  name: p.name,
  serialMask: p.serialMask,
  maxAttempts: p.maxAttempts,
  maxErrors: p.maxErrors,
  protocol: p.protocol,
  heartbeatMs: p.heartbeatMs,
  recipe: p.recipe,
});
const pretty = (def) => JSON.stringify(def, null, 2);

/**
 * @param {object} ctx
 * @param {object} ctx.store
 * @param {object} ctx.app
 * @param {() => boolean} ctx.canEdit engineer or admin
 * @param {(code?: string) => Promise<void>} ctx.productsChanged reload the station's product list
 */
export function initProducts(ctx) {
  const { store, app } = ctx;
  let list = [];
  // What the editor shows: published = current published revision (or null), draft = the draft (or null)
  let current = { code: null, published: null, draft: null, isNew: false };

  const editable = () => ctx.canEdit();
  const baseline = () => current.draft ?? current.published; // what "revert" goes back to

  async function reload(selectCode = current.code) {
    try {
      list = await store.listProducts({ drafts: editable(), archived: editable() && $('pr-show-archived').checked });
    } catch (err) {
      app.showToast(`Ürünler yüklenemedi: ${err.message}`);
      return;
    }
    renderList();
    const code = list.some((p) => p.code === selectCode) ? selectCode : list[0]?.code;
    if (code && !current.isNew) await select(code);
  }

  function renderList() {
    $('pr-list').replaceChildren(
      ...list.map((p) =>
        el(
          'li',
          {},
          el(
            'button',
            { type: 'button', className: `product-item${current.code === p.code ? ' active' : ''}`, dataset: { code: p.code }, ariaCurrent: current.code === p.code ? 'true' : 'false' },
            el('span', { className: 'mono', textContent: p.code }),
            el('span', { textContent: p.name }),
            el(
              'span',
              { className: 'muted mono' },
              p.status === 'draft' ? 'yayınlanmadı' : `rev ${p.revision}`,
              p.draftRevision && p.status !== 'draft' ? el('span', { className: 'badge badge-run ml-xs', textContent: 'taslak' }) : null,
              p.archived ? el('span', { className: 'badge badge-idle ml-xs', textContent: 'arşiv' }) : null
            )
          )
        )
      )
    );
  }

  async function select(code) {
    try {
      const head = list.find((p) => p.code === code);
      const published = head?.status === 'draft' ? null : await store.getProduct(code);
      const draft = editable() && head?.draftRevision ? await store.getDraft(code) : null;
      current = { code, published, draft, isNew: false };
      fill(definitionOf(draft ?? published));
      renderRevisions();
    } catch (err) {
      app.showToast(`Ürün açılamadı: ${err.message}`);
    }
  }

  function fill(def) {
    const shown = current.draft ?? current.published;
    $('pr-title').textContent = current.isNew ? 'Yeni ürün' : `${current.code} · ${shown?.name ?? ''}`;
    $('pr-meta').textContent = current.isNew
      ? 'Henüz kaydedilmedi'
      : [
          current.published ? `yayında: rev ${current.published.revision} (${formatDateTime(current.published.publishedAt)}${current.published.publishedBy ? `, ${current.published.publishedBy}` : ''})` : 'yayınlanmış revizyon yok',
          current.draft ? `düzenlenen taslak: rev ${current.draft.revision}` : null,
          shown?.archived ? 'ARŞİVDE' : null,
        ]
          .filter(Boolean)
          .join(' · ');
    $('pr-code').value = def.code;
    $('pr-name').value = def.name;
    $('pr-mask').value = def.serialMask;
    $('pr-attempts').value = def.maxAttempts;
    $('pr-max-errors').value = def.maxErrors ?? 3;
    $('pr-protocol').value = def.protocol ?? 'v2';
    $('pr-heartbeat').value = def.heartbeatMs ?? 0;
    $('pr-recipe').value = JSON.stringify(def.recipe, null, 2);
    const readOnly = !editable();
    for (const id of FIELDS) {
      $(id).readOnly = readOnly || (id === 'pr-code' && !current.isNew);
      if ($(id).tagName === 'SELECT') $(id).disabled = readOnly;
    }
    $('pr-readonly').classList.toggle('hidden', !readOnly);
    $('pr-archive').textContent = shown?.archived ? 'Arşivden çıkar' : 'Arşivle…';
    $('pr-archive').disabled = current.isNew;
    $('pr-diff-wrap').classList.add('hidden');
    validate();
    renderList();
  }

  function read() {
    let recipe;
    try {
      recipe = JSON.parse($('pr-recipe').value);
    } catch (err) {
      return { errors: [`Reçete JSON hatası: ${err.message}`] };
    }
    return validateProduct({
      code: $('pr-code').value,
      name: $('pr-name').value,
      serialMask: $('pr-mask').value,
      maxAttempts: $('pr-attempts').value,
      maxErrors: $('pr-max-errors').value,
      protocol: $('pr-protocol').value,
      heartbeatMs: $('pr-heartbeat').value === '' ? undefined : Number($('pr-heartbeat').value),
      recipe,
    });
  }

  function validate() {
    const { product: def, errors } = read();
    const jsonError = errors.some((e) => e.startsWith('Reçete JSON'));
    $('pr-errors').replaceChildren(...errors.map((e) => el('li', { textContent: e })));
    $('pr-recipe').classList.toggle('invalid', jsonError);
    const base = baseline();
    const dirty = current.isNew || !def || !base || pretty(def) !== pretty(definitionOf(base));
    $('pr-dirty').textContent = current.isNew ? '' : dirty ? 'Kaydedilmemiş değişiklik var' : current.draft ? 'Taslak kayıtlı' : 'Yayındaki revizyonla aynı';
    $('pr-save').disabled = errors.length > 0 || !dirty;
    $('pr-publish').disabled = !current.draft || dirty;
    $('pr-publish').title = dirty ? 'Önce taslağı kaydedin' : current.draft ? '' : 'Yayınlanacak taslak yok';
    $('pr-discard').disabled = !current.draft;
    $('pr-revert').disabled = !dirty || current.isNew;
    renderPreview(jsonError ? null : def);
  }

  function renderPreview(def) {
    if (!def) {
      $('pr-preview').replaceChildren();
      return;
    }
    const describe = (s) => {
      if (s.type === 'measure') {
        return `${s.limits.map((l) => `${l.key}: ${formatValue(l.min)}…${formatValue(l.max)}${l.unit ? ' ' + l.unit : ''}`).join(', ')} (${s.samples} örnek, ${EVALUATION_MODES[s.evaluate ?? 'mean'].toLowerCase()})`;
      }
      if (s.type === 'delay') return `${s.ms} ms`;
      if (s.type === 'confirm') return s.prompt;
      return [s.expect, s.capture ? `→ ${s.capture}` : null, s.critical ? 'kritik' : null].filter(Boolean).join(' · ');
    };
    const row = (s, n) =>
      el(
        'tr',
        {},
        el('td', { className: 'num muted', textContent: n }),
        el('td', { textContent: TYPE_TEXT[s.type] ?? s.type }),
        el('td', { textContent: s.name }),
        el('td', { className: 'mono', textContent: s.send ?? '' }),
        el('td', { className: 'mono', textContent: describe(s) ?? '' })
      );
    $('pr-preview').replaceChildren(
      ...def.recipe.steps.map((s, i) => row(s, i + 1)),
      ...(def.recipe.teardown.length ? [el('tr', { className: 'row-section' }, el('td', { colSpan: 5, textContent: 'Teardown — her durumda çalışır' }))] : []),
      ...def.recipe.teardown.map((s, i) => row(s, `T${i + 1}`))
    );
  }

  function showDiff(title, before, after) {
    $('pr-diff-title').textContent = title;
    renderDiff($('pr-diff'), diffLines(before, after));
    $('pr-diff-wrap').classList.remove('hidden');
    $('pr-diff-wrap').scrollIntoView({ block: 'nearest' });
  }

  async function renderRevisions() {
    if (!editable() || current.isNew) {
      $('pr-revisions').replaceChildren(el('tr', { className: 'table-empty' }, el('td', { colSpan: 6, textContent: editable() ? '' : 'Revizyon geçmişi mühendis ve yöneticilere açık' })));
      return;
    }
    let data;
    try {
      data = await store.listRevisions(current.code);
    } catch (err) {
      app.showToast(`Revizyonlar yüklenemedi: ${err.message}`);
      return;
    }
    const revisions = data.revisions;
    $('pr-revisions').replaceChildren(
      ...revisions.map((r, i) => {
        const previous = revisions[i + 1];
        const diff = el('button', { type: 'button', className: 'btn btn-sm', textContent: previous ? `rev ${previous.revision} ile farkı` : 'İçerik' });
        diff.addEventListener('click', () => showDiff(previous ? `rev ${previous.revision} → rev ${r.revision}` : `rev ${r.revision}`, previous ? pretty(previous.definition) : '', pretty(r.definition)));
        return el(
          'tr',
          {},
          el('td', { className: 'num mono', textContent: r.revision }),
          el('td', { textContent: REV_STATUS[r.status] ?? r.status }),
          el('td', { textContent: r.status === 'draft' ? r.createdBy ?? '—' : r.publishedBy ?? r.createdBy ?? '—' }),
          el('td', { className: 'mono', textContent: formatDateTime(r.publishedAt ?? r.createdAt) }),
          el('td', { className: 'pt-reason', textContent: r.note ?? '' }),
          el('td', {}, diff)
        );
      })
    );
  }

  // ---------- actions ----------

  async function save() {
    const { product: def, errors } = read();
    if (errors.length) return;
    if (current.isNew && list.some((p) => p.code === def.code)) return app.showToast(`${def.code} zaten var; listeden seçip düzenleyin`);
    try {
      const res = await store.saveDraft(def);
      if (res.unchanged) return app.showToast('Yayındaki revizyonla aynı; taslak oluşturulmadı');
      app.showToast(`${def.code} taslağı kaydedildi (rev ${res.product.revision}). İstasyon yayınlanana kadar eski revizyonu kullanır.`, 'success');
      current.isNew = false;
      await reload(def.code);
    } catch (err) {
      app.showToast(`Kaydedilemedi: ${err.message}`);
    }
  }

  async function publish() {
    if (!current.draft) return;
    showDiff(current.published ? `Yayındaki rev ${current.published.revision} → taslak rev ${current.draft.revision}` : `İlk yayın: rev ${current.draft.revision}`, current.published ? pretty(definitionOf(current.published)) : '', pretty(definitionOf(current.draft)));
    const note = await promptText(`${current.code} rev ${current.draft.revision} yayınlanacak. Yeni testler bu revizyonla yapılır. Neyi, neden değiştirdiniz? (fark aşağıda)`, { title: 'Yayın notu', minLength: 5, confirm: 'Yayınla' });
    if (!note) return;
    try {
      const published = await store.publish(current.code, note);
      app.showToast(`${current.code} rev ${published.revision} yayınlandı`, 'success');
      await reload(current.code);
      await ctx.productsChanged(current.code);
    } catch (err) {
      app.showToast(`Yayınlanamadı: ${err.message}`);
    }
  }

  async function discard() {
    if (!current.draft) return;
    if (!(await ask(`${current.code} taslağı (rev ${current.draft.revision}) silinsin mi? Yayındaki revizyon değişmez.`, { title: 'Taslağı sil', yes: 'Sil', no: 'Vazgeç', keys: false, danger: true }))) return;
    try {
      await store.discardDraft(current.code);
      const code = current.published ? current.code : null;
      current = { code, published: null, draft: null, isNew: false };
      await reload(code);
    } catch (err) {
      app.showToast(`Silinemedi: ${err.message}`);
    }
  }

  async function toggleArchive() {
    const shown = current.draft ?? current.published;
    if (!shown) return;
    try {
      if (shown.archived) {
        await store.restore(current.code);
        app.showToast(`${current.code} arşivden çıkarıldı`, 'success');
      } else {
        const reason = await promptText(`${current.code} arşivlenecek: istasyon listesinden kalkar, geçmiş kayıtlar korunur. Gerekçe:`, { title: 'Arşivle', minLength: 5, confirm: 'Arşivle' });
        if (!reason) return;
        await store.archive(current.code, reason);
        app.showToast(`${current.code} arşivlendi`, 'success');
      }
      await reload(current.code);
      await ctx.productsChanged();
    } catch (err) {
      app.showToast(err.message);
    }
  }

  // ---------- events ----------

  $('pr-list').addEventListener('click', (e) => {
    const item = e.target.closest('.product-item');
    if (!item) return;
    current.isNew = false;
    select(item.dataset.code);
  });
  $('pr-new').addEventListener('click', () => {
    current = { code: null, published: null, draft: null, isNew: true };
    fill(NEW_TEMPLATE);
    renderRevisions();
    $('pr-code').focus();
  });
  for (const id of FIELDS) $(id).addEventListener('input', validate);
  $('pr-save').addEventListener('click', save);
  $('pr-publish').addEventListener('click', publish);
  $('pr-discard').addEventListener('click', discard);
  $('pr-revert').addEventListener('click', () => fill(definitionOf(baseline())));
  $('pr-archive').addEventListener('click', toggleArchive);
  $('pr-show-archived').addEventListener('change', () => reload());
  $('pr-export').addEventListener('click', () => {
    const { product: def } = read();
    const data = def ?? (baseline() ? definitionOf(baseline()) : null);
    if (data) download(JSON.stringify(data, null, 2), `${data.code || 'urun'}.json`, 'application/json');
  });
  $('pr-import').addEventListener('click', () => $('pr-import-file').click());
  $('pr-import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const def = JSON.parse(await file.text());
      const code = String(def.code ?? '').toUpperCase();
      if (list.some((p) => p.code === code)) await select(code);
      else current = { code: null, published: null, draft: null, isNew: true };
      fill({ ...NEW_TEMPLATE, ...def, recipe: def.recipe ?? NEW_TEMPLATE.recipe });
      app.showToast('Dosya editöre yüklendi; "Taslağı kaydet" ile taslak olur, yayınlanana kadar istasyonu etkilemez', 'success');
    } catch (err) {
      app.showToast(`Dosya okunamadı: ${err.message}`);
    }
  });

  return {
    reload,
    show() {
      if (!current.code && !current.isNew) reload();
    },
    /** Leaving the page with unsaved edits loses them; ask first. */
    hasUnsavedEdits() {
      if (!editable()) return false;
      const { product: def } = read();
      const base = baseline();
      return current.isNew ? $('pr-code').value.trim() !== '' : Boolean(base) && (!def || pretty(def) !== pretty(definitionOf(base)));
    },
  };
}
