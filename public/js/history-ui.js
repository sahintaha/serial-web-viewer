// ============================================
// HISTORY — paged test list (summaries only), per-test detail fetched on demand,
// printable single-test report, CSV export with the same filters, the outbox of
// results that are not stored yet, and the browser storage panel.
// ============================================

import { formatValue, EVALUATION_MODES } from './recipe.js';
import { renderStepsTable, renderLog } from './station.js';
import { $, el, fill, badge, ask, promptText, download, formatDateTime, formatBytes, duration, openModal, RESULT_TEXT, STATUS_TEXT, SOURCE_TEXT, SAFETY_TEXT } from './dom.js';

const PAGE_SIZE = 50;
const OUTBOX_STATE = { pending: 'bekliyor', rejected: 'reddedildi' };

function dayBound(value, end) {
  return value ? new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`).toISOString() : undefined;
}

function measurementStatus(m) {
  if (m.status === 'MISSING') return badge('ERROR', 'eksik');
  if (m.status === 'INVALID') return badge('ERROR', 'geçersiz');
  return badge(m.status);
}

function table(headers, rows) {
  return el(
    'div',
    { className: 'table-wrap' },
    el('table', { className: 'table' }, el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { textContent: h })))), el('tbody', {}, ...rows))
  );
}

function measurementsTable(measurements) {
  return table(
    ['Ölçüm', 'Değer', 'Min', 'Max', 'Örnek', 'Mod', 'Durum'],
    measurements.map((m) =>
      el(
        'tr',
        {},
        el('td', { textContent: m.name }),
        el('td', { className: 'num', textContent: m.value === null ? '—' : `${formatValue(m.value)}${m.unit ? ' ' + m.unit : ''}` }),
        el('td', { className: 'num', textContent: formatValue(m.min) }),
        el('td', { className: 'num', textContent: formatValue(m.max) }),
        el('td', { className: 'num', textContent: m.invalid ? `${m.count} (+${m.invalid} geçersiz)` : m.count }),
        el('td', { textContent: EVALUATION_MODES[m.mode ?? 'mean'] ?? m.mode }),
        el('td', {}, measurementStatus(m))
      )
    )
  );
}

/** Key facts of a record: where, with what, by whom. */
function recordFacts(r) {
  const station = r.station ?? {};
  const facts = [
    ['Ürün', r.productCode ? `${r.productCode} ${r.productName ?? ''} · rev ${r.recipeRevision}` : '—'],
    ['Seri no', r.serial],
    ['Sonuç', `${RESULT_TEXT[r.result]}${r.failedStep !== null && r.failedStep !== undefined ? ` (adım ${r.failedStep + 1})` : ''}`],
    ['Deneme', r.attempt],
    ['Başlangıç', formatDateTime(r.startedAt)],
    ['Süre', duration(r)],
    ['Operatör', r.operator || '—'],
    ['Kaynak', `${SOURCE_TEXT[r.source ?? 'unknown']}${r.transport ? ` · ${r.transport}` : ''}`],
    ['Güvenli kapanma', r.safety ? `${SAFETY_TEXT[r.safety.state]}${r.safety.reason ? ` — ${r.safety.reason}` : ''}` : 'kayıtlı değil (eski kayıt)'],
    ['Kart firmware', r.captures?.firmware ?? '—'],
    ['İstasyon', [station.id, station.fixture ? `fikstür ${station.fixture}` : null].filter(Boolean).join(' · ') || '—'],
    ['Kalibrasyon', station.calibration?.id ? `${station.calibration.id}${station.calibration.due ? ` (son tarih ${station.calibration.due})` : ''}${station.calibrationExpired ? ' — SÜRESİ DOLMUŞ' : ''}` : '—'],
    ['Yazılım', station.appVersion ?? '—'],
  ];
  if (r.retestReason) facts.push(['Tekrar test gerekçesi', r.retestReason]);
  return facts;
}

const factList = (facts) => el('dl', { className: 'kv' }, ...facts.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: String(v ?? '') })]));

/**
 * @param {object} ctx
 * @param {object} ctx.store
 * @param {import('./outbox.js').Outbox} ctx.outbox
 * @param {object} ctx.app
 * @param {() => boolean} ctx.canReopen
 * @param {(serial: string, productCode: string) => void} ctx.retest open the station with this board
 * @param {(serial: string) => Promise<boolean>} ctx.reopenUnit
 */
export function initHistory(ctx) {
  const { store, outbox, app } = ctx;
  let page = { offset: 0, total: 0 };
  let items = [];
  let token = 0;
  let sourceTouched = false;

  function readFilters() {
    return {
      serial: $('pt-filter-serial').value.trim(),
      product: $('pt-filter-product').value,
      result: $('pt-filter-result').value,
      source: $('pt-filter-source').value,
      from: dayBound($('pt-filter-from').value, false),
      to: dayBound($('pt-filter-to').value, true),
    };
  }

  async function refresh(offset = 0) {
    const mine = ++token;
    if (!sourceTouched) $('pt-filter-source').value = app.getTransportKind() === 'demo' ? 'simulation' : 'production';
    $('pt-history-body').setAttribute('aria-busy', 'true');
    try {
      const res = await store.query(readFilters(), { limit: PAGE_SIZE, offset });
      if (mine !== token) return; // a newer query was started (filter changed while loading)
      items = res.items;
      page = { offset: res.offset, total: res.total };
      renderStats(res.stats);
      renderRows();
      renderPager();
    } catch (err) {
      if (mine === token) app.showToast(`Geçmiş yüklenemedi: ${err.message}`);
    } finally {
      if (mine === token) $('pt-history-body').removeAttribute('aria-busy');
    }
  }

  function renderStats(stats) {
    const cell = (label, value, cls = '') => el('div', { className: `pt-stat ${cls}` }, el('span', { textContent: label }), el('strong', { textContent: value }));
    $('pt-stats').replaceChildren(
      cell('Test', stats.total),
      cell('PASS', stats.PASS, 'pt-pass'),
      cell('FAIL', stats.FAIL, 'pt-fail'),
      cell('HATA', stats.ERROR, 'pt-error'),
      cell('Deneme verimi', stats.yield === null ? '—' : `%${stats.yield}`)
    );
  }

  function renderRows() {
    const body = $('pt-history-body');
    if (!items.length) {
      body.replaceChildren(el('tr', { className: 'table-empty' }, el('td', { colSpan: 9, textContent: 'Bu filtreyle kayıt yok' })));
      return;
    }
    body.replaceChildren(
      ...items.map((r, i) =>
        el(
          'tr',
          { className: 'row-link', dataset: { index: i }, tabIndex: 0, ariaLabel: `${r.serial} ${RESULT_TEXT[r.result]}, detay için Enter` },
          el('td', { className: 'mono', textContent: formatDateTime(r.finishedAt) }),
          el('td', { className: 'mono', textContent: r.serial }),
          el('td', { className: 'mono', textContent: r.productCode ? `${r.productCode} r${r.recipeRevision}` : '—' }),
          el('td', { className: 'num', textContent: r.attempt }),
          el('td', {}, badge(r.result, RESULT_TEXT[r.result]), r.safety && !['SAFE', 'NOT_CHECKED'].includes(r.safety.state) ? el('span', { className: 'badge badge-fail ml-xs', textContent: 'güvenlik', title: SAFETY_TEXT[r.safety.state] }) : null),
          el('td', { className: 'pt-reason', textContent: r.reason ?? '' }),
          el('td', { textContent: SOURCE_TEXT[r.source ?? 'unknown'] }),
          el('td', { textContent: r.operator ?? '' }),
          el('td', { className: 'num', textContent: duration(r) })
        )
      )
    );
  }

  function renderPager() {
    const pager = $('pt-pager');
    const pages = Math.max(1, Math.ceil(page.total / PAGE_SIZE));
    const current = Math.floor(page.offset / PAGE_SIZE) + 1;
    const prev = el('button', { type: 'button', className: 'btn btn-sm', textContent: '‹ Önceki', disabled: current <= 1 });
    const next = el('button', { type: 'button', className: 'btn btn-sm', textContent: 'Sonraki ›', disabled: current >= pages });
    prev.addEventListener('click', () => refresh(page.offset - PAGE_SIZE));
    next.addEventListener('click', () => refresh(page.offset + PAGE_SIZE));
    const from = page.total ? page.offset + 1 : 0;
    pager.replaceChildren(prev, el('span', { className: 'muted', textContent: `${from}–${page.offset + items.length} / ${page.total} kayıt · sayfa ${current}/${pages}` }), next);
  }

  // ---------- detail ----------

  async function openDetail(summary) {
    let record;
    try {
      record = await store.getRun(summary.id);
    } catch (err) {
      app.showToast(`Kayıt açılamadı: ${err.message}`);
      return;
    }
    $('pt-detail-title').textContent = `${record.serial} · ${RESULT_TEXT[record.result]}`;
    $('pt-detail-sub').textContent = [record.productCode ? `${record.productCode} rev ${record.recipeRevision}` : null, `${record.attempt}. deneme`, formatDateTime(record.finishedAt), SOURCE_TEXT[record.source ?? 'unknown']]
      .filter(Boolean)
      .join(' · ');

    const stepsBody = el('tbody');
    renderStepsTable(stepsBody, record.steps ?? [], record.teardown ?? [], { serial: record.serial });
    const logBox = el('div', { className: 'log comm-log' });
    renderLog(logBox, record.log ?? []);
    fill(
      $('pt-detail-body'),
      record.reason ? el('p', { className: `detail-reason text-${record.result === 'FAIL' ? 'fail' : 'error'}`, textContent: record.reason }) : null,
      factList(recordFacts(record)),
      el('h3', { className: 'section-title', textContent: 'Adımlar' }),
      record.steps?.length
        ? el('div', { className: 'table-wrap' }, el('table', { className: 'table' }, el('thead', {}, el('tr', {}, ...['#', 'Adım', 'Komut', 'Cevap / değer', 'Durum', 'ms'].map((h) => el('th', { textContent: h })))), stepsBody))
        : el('p', { className: 'muted', textContent: 'Bu kayıt adım bilgisi içermiyor (eski sürüm).' }),
      record.measurements?.length ? el('h3', { className: 'section-title', textContent: 'Ölçümler' }) : null,
      record.measurements?.length ? measurementsTable(record.measurements) : null,
      record.log?.length ? el('details', { className: 'tech-details' }, el('summary', { className: 'section-title', textContent: `Haberleşme kaydı (${record.log.length} satır)` }), logBox) : null
    );

    const reopen = $('pt-detail-reopen');
    reopen.classList.toggle('hidden', !(ctx.canReopen() && record.result === 'FAIL'));
    reopen.onclick = async () => {
      if (await ctx.reopenUnit(record.serial, record.source)) refresh(page.offset);
    };
    $('pt-detail-retest').onclick = () => {
      close();
      ctx.retest(record.serial, record.productCode);
    };
    $('pt-detail-print').onclick = () => printRecord(record);
    const close = openModal($('pt-detail'));
    $('pt-detail-close').onclick = close;
  }

  /** One-page report for the board's traveller / customer: no UI chrome, no logs. */
  function printRecord(r) {
    const area = $('print-area');
    fill(
      area,
      el('h1', { textContent: `Test raporu · ${r.serial}` }),
      el('p', { className: `print-result print-${r.result.toLowerCase()}`, textContent: RESULT_TEXT[r.result] + (r.reason ? ` — ${r.reason}` : '') }),
      factList(recordFacts(r)),
      r.measurements?.length ? el('h2', { textContent: 'Ölçümler' }) : null,
      r.measurements?.length ? measurementsTable(r.measurements) : null,
      el('h2', { textContent: 'Adımlar' }),
      table(
        ['#', 'Adım', 'Durum', 'Not'],
        [...(r.steps ?? []).map((s, i) => [i + 1, s]), ...(r.teardown ?? []).map((s, i) => [`T${i + 1}`, s])].map(([n, s]) =>
          el('tr', {}, el('td', { textContent: n }), el('td', { textContent: s.name }), el('td', { textContent: STATUS_TEXT[s.status] ?? s.status }), el('td', { textContent: s.status === 'PASS' ? '' : s.reason ?? '' }))
        )
      ),
      el('p', { className: 'print-footer', textContent: `Kayıt #${r.id} · runId ${r.runId ?? '—'} · yazdırıldı ${formatDateTime(new Date().toISOString())}` })
    );
    area.setAttribute('aria-hidden', 'false');
    document.body.classList.add('printing');
    const done = () => {
      document.body.classList.remove('printing');
      area.setAttribute('aria-hidden', 'true');
      area.replaceChildren();
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  }

  // ---------- outbox ----------

  async function renderOutbox() {
    let entries;
    try {
      entries = await outbox.list();
    } catch (err) {
      app.showToast(`Bekleyen kayıtlar okunamadı: ${err.message}`);
      return;
    }
    const pending = entries.filter((e) => e.state === 'pending').length;
    const rejected = entries.length - pending;
    const pill = $('pt-outbox-pill');
    pill.classList.toggle('hidden', !entries.length);
    pill.className = `outbox-pill${rejected ? ' outbox-rejected' : ''}${entries.length ? '' : ' hidden'}`;
    pill.textContent = rejected ? `${rejected} reddedilen, ${pending} bekleyen kayıt` : `${pending} kayıt bekliyor`;
    $('pt-outbox-panel').classList.toggle('hidden', !entries.length);
    entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    $('pt-outbox-body').replaceChildren(
      ...entries.map((e) => {
        const retry = el('button', { type: 'button', className: 'btn btn-sm', textContent: 'Tekrar gönder' });
        retry.addEventListener('click', async () => {
          try {
            await outbox.retry(e.runId);
            app.showToast(`${e.submission.serial} kaydedildi`, 'success');
          } catch (err) {
            app.showToast(`Gönderilemedi: ${err.message}`);
          }
        });
        const discard = el('button', { type: 'button', className: 'btn btn-sm btn-danger', textContent: 'Sil…' });
        discard.addEventListener('click', async () => {
          const ok = await ask(`${e.submission.serial} sonucu kalıcı olarak silinecek ve hiçbir yere kaydedilmeyecek. Önce "JSON indir" ile dışa aktardınız mı?`, { title: 'Kaydedilmemiş sonucu sil', yes: 'Sil', no: 'Vazgeç', keys: false, danger: true });
          if (ok) await outbox.discard(e.runId);
        });
        return el(
          'tr',
          {},
          el('td', { className: 'mono', textContent: formatDateTime(e.submission.finishedAt) }),
          el('td', { className: 'mono', textContent: e.submission.serial }),
          el('td', {}, badge(e.state === 'pending' ? 'PENDING' : 'FAIL', OUTBOX_STATE[e.state])),
          el('td', { className: 'num', textContent: e.attempts }),
          el('td', { className: 'pt-reason', textContent: e.lastError ?? '' }),
          el('td', { className: 'row' }, retry, discard)
        );
      })
    );
  }

  // ---------- browser storage (local store only) ----------

  async function renderStorage() {
    if (store.kind !== 'local') return;
    $('pt-storage-panel').classList.remove('hidden');
    try {
      const info = await store.storageInfo();
      const usage = info.quota ? `${formatBytes(info.usage)} / ${formatBytes(info.quota)} (%${((info.usage / info.quota) * 100).toFixed(1)})` : 'tarayıcı bildirmiyor';
      $('pt-storage-info').textContent = `${info.runs} test kaydı · ${info.outbox} bekleyen · kullanılan alan: ${usage} · ${info.persisted ? 'kalıcı depolama verildi' : 'kalıcı depolama verilmedi: tarayıcı yer darlığında verileri silebilir, düzenli dışa aktarın'}`;
    } catch (err) {
      $('pt-storage-info').textContent = `Depo bilgisi okunamadı: ${err.message}`;
    }
  }

  // ---------- events ----------

  $('pt-filters').addEventListener('submit', (e) => {
    e.preventDefault();
    refresh(0);
  });
  $('pt-filter-source').addEventListener('change', () => {
    sourceTouched = true;
  });
  // Until the user picks a source, the list follows the connection (simulator → simulation results)
  app.onStatus(() => {
    if (!sourceTouched && !$('pt-page-history').classList.contains('hidden')) refresh(0);
  });
  $('pt-export').addEventListener('click', () => store.exportCsv(readFilters()));
  const rowOf = (e) => e.target.closest('tr[data-index]');
  $('pt-history-body').addEventListener('click', (e) => {
    const row = rowOf(e);
    if (row) openDetail(items[Number(row.dataset.index)]);
  });
  $('pt-history-body').addEventListener('keydown', (e) => {
    const row = rowOf(e);
    if (row && e.key === 'Enter') openDetail(items[Number(row.dataset.index)]);
  });
  $('pt-outbox-retry').addEventListener('click', async () => {
    await outbox.flush({ force: true });
    const { pending } = await outbox.counts();
    app.showToast(pending ? `${pending} kayıt hâlâ gönderilemedi` : 'Bekleyen kayıtlar gönderildi', pending ? undefined : 'success');
  });
  $('pt-outbox-export').addEventListener('click', async () => download(await outbox.exportJson(), `bekleyen-sonuclar-${new Date().toISOString().slice(0, 10)}.json`, 'application/json'));
  $('pt-outbox-pill').addEventListener('click', () => app.showPage('history'));
  $('pt-storage-export').addEventListener('click', () => store.exportAll());
  $('pt-storage-prune').addEventListener('click', async () => {
    const date = await promptText('Bu tarihten (YYYY-AA-GG) önce biten test kayıtları silinecek.', { title: 'Eski kayıtları sil', minLength: 10, placeholder: '2026-01-01', confirm: 'İleri' });
    if (!date) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return app.showToast('Tarih YYYY-AA-GG biçiminde olmalı');
    const ok = await ask(`${date} öncesindeki kayıtlar bu tarayıcıdan kalıcı olarak silinecek. "Tümünü JSON indir" ile yedek aldınız mı?`, { title: 'Kalıcı silme', yes: 'Sil', no: 'Vazgeç', keys: false, danger: true });
    if (!ok) return;
    try {
      const count = await store.deleteRunsBefore(new Date(`${date}T00:00:00`).toISOString());
      app.showToast(`${count} kayıt silindi`, 'success');
      refresh(0);
      renderStorage();
    } catch (err) {
      app.showToast(`Silinemedi: ${err.message}`);
    }
  });

  return {
    refresh: () => refresh(page.offset),
    renderOutbox,
    renderStorage,
    setProducts(products) {
      const current = $('pt-filter-product').value;
      $('pt-filter-product').replaceChildren(new Option('Tüm ürünler', ''), ...products.map((p) => new Option(p.code, p.code, false, p.code === current)));
    },
  };
}
