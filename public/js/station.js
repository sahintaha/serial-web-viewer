// ============================================
// TEST STATION — the operator's screen and the run lifecycle.
//
//   IDLE → CHECKING → RUNNING → TEARDOWN → SAVING → COMPLETED
//                  ↘ ERROR (refused, could not start, could not store)
//
// - The start lock is taken synchronously, before the first await: a double click
//   or two quick barcode scans cannot start a second run.
// - Every run has a runId; asynchronous callbacks only touch the run they belong to.
// - Product revision, operator, connection and data source are frozen at the start.
// - The result goes to the durable outbox before any network call. If even that
//   fails, the station refuses new tests until the result has been exported.
// - When the board could not be confirmed safe, the operator must acknowledge
//   before the next test.
// - A run is marked as active (localStorage) and holds a Web Lock while it runs. If the
//   page dies mid-test, the next load finds the mark without its lock, releases the
//   reservation and asks the operator to check the board.
// ============================================

import { validateSerial, normalizeSerial, evaluateRun, renderCommand, formatValue, EVALUATION_MODES } from './recipe.js';
import { runTest, sleep } from './runner.js';
import { $, el, fill, badge, ask, promptText, download, RESULT_TEXT, SAFETY_TEXT } from './dom.js';
import { faultForSerial, FAULTS } from './simulator.js';

const STARTABLE = ['IDLE', 'COMPLETED', 'ERROR'];
const PHASE_BADGE = { IDLE: 'idle', CHECKING: 'run', RUNNING: 'run', TEARDOWN: 'run', SAVING: 'run', COMPLETED: 'pass', ERROR: 'error' };
// The operator sees words; the technical state stays in data-phase for scripts and tests
const PHASE_TEXT = { IDLE: 'Hazır', CHECKING: 'Kontrol', RUNNING: 'Test', TEARDOWN: 'Kapatılıyor', SAVING: 'Kaydediliyor', COMPLETED: 'Bitti', ERROR: 'Hata' };
const TRANSPORT_OF = { demo: 'simulator', webserial: 'webserial', server: 'server' };
// Defects the "faulty board" button cycles through, so each try shows a different catch
const DEMO_FAULTS = ['overcurrent', 'undervoltage', 'firmware', 'selftest', 'led'];

// ---------- rendering helpers (also used by the history detail view) ----------

function stepOutput(step, data) {
  if (!data) return '';
  if (data.error && !data.reply) return data.error;
  if (step.type === 'delay') return `${step.ms} ms`;
  if (step.type === 'measure') {
    if (step.measurements?.length) {
      return step.measurements.map((m) => `${m.key} ${m.value === null ? '—' : formatValue(m.value)}${m.unit ? ' ' + m.unit : ''}`).join('  ');
    }
    const last = [...(data.replies ?? [])].reverse().find((r) => r !== null);
    return last ?? 'cevap yok';
  }
  if (step.type === 'confirm' && data.answer !== undefined && data.answer !== null) return data.answer ? 'Evet' : 'Hayır';
  return data.reply ?? 'cevap yok';
}

function stepRow(step, number, ctx) {
  const status = step.status ?? 'PENDING';
  const nameCell = el('td', {}, el('div', { textContent: step.name + (step.critical ? ' (kritik)' : '') }));
  if (step.reason && status !== 'PASS') nameCell.append(el('div', { className: `step-reason text-${status === 'FAIL' ? 'fail' : 'error'}`, textContent: step.reason }));
  return el(
    'tr',
    { className: status === 'RUNNING' ? 'row-running' : '' },
    el('td', { className: 'num muted', textContent: number }),
    nameCell,
    el('td', { className: 'mono', textContent: step.send ? renderCommand(step.send, ctx) : '' }),
    el('td', { className: 'mono step-output', textContent: stepOutput(step, step.data) }),
    el('td', {}, badge(status)),
    el('td', { className: 'num muted', textContent: step.data?.durationMs ?? '' })
  );
}

export function renderStepsTable(tbody, steps, teardown, ctx) {
  const rows = steps.map((s, i) => stepRow(s, i + 1, ctx));
  if (teardown.length) {
    rows.push(el('tr', { className: 'row-section' }, el('td', { colSpan: 6, textContent: 'Teardown — her durumda çalışır' })));
    rows.push(...teardown.map((s, i) => stepRow(s, `T${i + 1}`, ctx)));
  }
  tbody.replaceChildren(...rows);
}

export function renderLog(container, entries) {
  container.replaceChildren(
    ...entries.map((e) =>
      el('div', { className: `log-line log-${e.dir === '--' ? 'warn' : e.dir.toLowerCase()}` }, el('span', { className: 'log-time', textContent: `${String(e.t).padStart(6, ' ')} ms` }), el('span', { className: 'log-dir', textContent: e.dir }), e.text)
    )
  );
  container.scrollTop = container.scrollHeight;
}

function gauge(limit, value) {
  const span = limit.max - limit.min || Math.abs(limit.max) || 1;
  const lo = limit.min - span * 0.25;
  const hi = limit.max + span * 0.25;
  const pct = (v) => Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));
  const track = el('div', { className: 'pt-gauge', role: 'img', ariaLabel: `Limit ${limit.min}…${limit.max}${value === null ? '' : `, değer ${formatValue(value)}`}` });
  const zone = el('div', { className: 'pt-gauge-zone' });
  zone.style.left = `${pct(limit.min)}%`;
  zone.style.width = `${pct(limit.max) - pct(limit.min)}%`;
  track.append(zone);
  if (value !== null && value !== undefined) {
    const marker = el('div', { className: 'pt-gauge-marker' });
    marker.style.left = `${pct(value)}%`;
    track.append(marker);
  }
  return track;
}

function measurementCards(container, measureSteps) {
  container.replaceChildren(
    ...measureSteps.flatMap((step) =>
      step.limits.map((limit) => {
        const m = step.measurements?.find((x) => x.key === limit.key);
        const value = m?.value ?? null;
        const status = m?.status ?? null;
        const unit = limit.unit ? ` ${limit.unit}` : '';
        const mode = EVALUATION_MODES[m?.mode ?? step.evaluate ?? 'mean'].toLowerCase();
        return el(
          'div',
          { className: `pt-measure ${status ? 'pt-' + status.toLowerCase() : ''}` },
          el('div', { className: 'pt-measure-head' }, el('span', { className: 'pt-measure-name', textContent: limit.name }), el('span', { className: 'pt-measure-detail', textContent: m ? `${m.count}/${step.samples} örnek · ${mode}` : step.name })),
          el('div', { className: 'pt-measure-value', textContent: value === null ? '—' : `${formatValue(value)}${unit}` }),
          gauge(limit, value),
          el('div', { className: 'pt-measure-limit', textContent: `${formatValue(limit.min)} … ${formatValue(limit.max)}${unit}` })
        );
      })
    )
  );
}

/**
 * @param {object} ctx
 * @param {object} ctx.store ServerStore | LocalStore
 * @param {import('./outbox.js').Outbox} ctx.outbox
 * @param {object} ctx.app hooks from app.js
 * @param {object|null} ctx.user logged-in user (server) or null (local)
 * @param {(record: object) => void} ctx.onStored a result reached the store
 * @param {() => Promise<void>} ctx.reloadProducts
 * @param {(serial: string) => Promise<void>} ctx.reopenUnit engineer action
 */
export function initStation(ctx) {
  const { store, outbox, app, user } = ctx;
  // An unconfirmed unsafe board survives a page reload: the acknowledgement is kept until given
  const ACK_KEY = 'stationSafetyAck';
  const ACTIVE_KEY = 'stationActiveRuns';
  const lockName = (runId) => `sv-run-${runId}`;
  const pendingAck = app.storage.get(ACK_KEY, null);
  const state = {
    phase: 'IDLE',
    product: null, // published revision selected for the next run
    run: null, // the run in progress (frozen snapshot)
    last: pendingAck ? { ...pendingAck, saved: null } : null, // what the result box shows
    log: [],
    ackRequired: Boolean(pendingAck),
    unsaved: null, // a submission that could not even be stored locally
    message: null, // why the last start was refused
  };
  let unitLookup = 0;

  const sourceNow = () => (app.getTransportKind() === 'demo' ? 'simulation' : 'hardware');
  const describeHolder = (r) => {
    const minutes = Math.max(0, Math.round((Date.now() - Date.parse(r.createdAt)) / 60000));
    const who = user && r.userId === user.id ? 'sizin yarım kalmış testiniz' : r.user ?? 'bilinmeyen kullanıcı';
    return [who, r.station, `${minutes} dk önce başladı`].filter(Boolean).join(', ');
  };
  const idleSteps = (product) => ({
    steps: product.recipe.steps.map((s) => ({ ...s, status: 'PENDING', data: null })),
    teardown: product.recipe.teardown.map((s) => ({ ...s, status: 'PENDING', data: null })),
  });

  let transitions = 0;
  function setPhase(phase) {
    state.phase = phase;
    // Transition counter on the badge: lets tests and kiosk scripts see that a new run happened
    $('pt-phase').dataset.transitions = String(++transitions);
    render();
  }

  // ---------- rendering ----------

  function render() {
    const busy = !STARTABLE.includes(state.phase);
    const { connected, label } = app.getConnection();
    const simulation = app.getTransportKind() === 'demo';
    $('pt-phase').textContent = PHASE_TEXT[state.phase];
    $('pt-phase').dataset.phase = state.phase;
    $('pt-phase').className = `badge badge-${PHASE_BADGE[state.phase]}`;
    $('pt-sim-badge').classList.toggle('hidden', !simulation);
    $('pt-start').classList.toggle('hidden', busy);
    $('pt-start').disabled = busy || !state.product || state.ackRequired || Boolean(state.unsaved);
    $('pt-cancel').classList.toggle('hidden', state.phase !== 'RUNNING');
    for (const id of ['pt-product', 'pt-serial', 'pt-operator']) $(id).disabled = busy;
    $('pt-operator-field').classList.toggle('hidden', Boolean(user));
    const quickTry = simulation && /^[A-Z0-9-]*#{6}$/.test(state.product?.serialMask ?? '');
    $('pt-demo-actions').classList.toggle('hidden', !quickTry);
    $('pt-demo-actions').querySelectorAll('button').forEach((b) => (b.disabled = busy || state.ackRequired));

    const product = state.run?.product ?? state.product;
    if (!product) return;
    $('pt-mask').textContent = `· ${product.serialMask}`;
    $('pt-serial').placeholder = product.serialMask;
    $('pt-recipe-info').textContent = `${product.code} rev ${product.revision} · ${product.recipe.steps.length} adım · protokol ${product.protocol}${product.recipe.stopOnFail ? ' · ilk hatada durur' : ''}`;

    const view = state.run?.view ?? (state.last?.steps ? state.last : idleSteps(product));
    renderStepsTable($('pt-steps'), view.steps, view.teardown, { serial: state.run?.serial ?? state.last?.serial ?? '' });
    measurementCards($('pt-measurements'), view.steps.filter((s) => s.type === 'measure'));
    renderResult(connected, label);
    renderSafety();
    renderSave();
  }

  function renderResult(connected, label) {
    const box = $('pt-result');
    const run = state.run;
    if (run && ['CHECKING', 'RUNNING', 'TEARDOWN', 'SAVING'].includes(state.phase)) {
      const done = run.view.steps.filter((s) => !['PENDING', 'RUNNING'].includes(s.status)).length;
      const current = run.view.steps.find((s) => s.status === 'RUNNING') ?? run.view.teardown.find((s) => s.status === 'RUNNING');
      const what = { CHECKING: 'kontrol ediliyor', RUNNING: current?.name ?? '', TEARDOWN: `kapatılıyor: ${current?.name ?? ''}`, SAVING: 'kaydediliyor' }[state.phase];
      box.className = 'pt-result pt-running';
      fill(
        box,
        el('div', { className: 'pt-result-title', textContent: state.phase === 'SAVING' ? 'KAYIT' : 'TEST' }),
        el('div', { className: 'pt-result-sub', textContent: `${run.serial} · ${done}/${run.view.steps.length} adım · ${what}` }),
        el('div', { className: 'pt-progress' }, Object.assign(el('div', { className: 'pt-progress-bar' }), { style: `width:${(done / run.view.steps.length) * 100}%` }))
      );
      return;
    }
    if (state.message) {
      box.className = `pt-result pt-${state.message.kind}`;
      fill(
        box,
        el('div', { className: 'pt-result-title', textContent: state.message.title }),
        el('div', { className: 'pt-result-sub', textContent: state.message.serial ?? '' }),
        el('div', { className: 'pt-result-reason', textContent: state.message.text }),
        state.message.reopen ? reopenButton(state.message.serial) : null,
        state.message.release ? releaseButton(state.message.serial, state.message.release) : null
      );
      return;
    }
    if (state.last) {
      const last = state.last;
      const sub = [last.serial, last.attempt ? `${last.attempt}. deneme` : null, last.source === 'simulation' ? 'simülasyon' : null].filter(Boolean).join(' · ');
      // The verdict is about the board; the safe state is about the fixture. Never show one as the other.
      const unsafe = last.safety && !['SAFE', 'NOT_CHECKED'].includes(last.safety.state);
      box.className = `pt-result pt-${last.result.toLowerCase()}${unsafe ? ' pt-attention' : ''}`;
      fill(
        box,
        el('div', { className: 'pt-result-title', textContent: RESULT_TEXT[last.result] }),
        el('div', { className: 'pt-result-sub', textContent: sub }),
        last.reason ? el('div', { className: 'pt-result-reason', textContent: last.reason }) : null,
        unsafe ? el('div', { className: 'pt-result-reason text-fail', textContent: 'Test sonucu kaydedildi, ancak kart güvenli durumda değil — aşağıdaki uyarıya bakın.' }) : null
      );
      return;
    }
    box.className = 'pt-result';
    fill(
      box,
      el('div', { className: 'pt-result-title muted', textContent: 'HAZIR' }),
      el('div', { className: 'pt-result-sub', textContent: connected ? `${label ?? 'Cihaz'} · seri numarasını okutun` : 'Önce Bağlantı panelinden cihaza bağlanın' })
    );
  }

  /** Lets the holder of an interrupted reservation (or an engineer) release it. */
  function releaseButton(serial, reservations) {
    const canRelease = (r) => !user || r.userId === user.id || ['engineer', 'admin'].includes(user.role);
    if (!reservations?.length || !reservations.every(canRelease)) return null;
    const button = el('button', { type: 'button', className: 'btn btn-sm mt-sm', textContent: 'Yarım kalan testi kapat…' });
    button.addEventListener('click', async () => {
      const ok = await ask(`${serial} için açık kalan test kapatılacak. Kart şu anda başka bir istasyonda test edilmiyorsa devam edin.`, {
        title: 'Yarım kalan test',
        yes: 'Kapat',
        no: 'Vazgeç',
        keys: false,
        danger: true,
      });
      if (!ok) return;
      try {
        for (const r of reservations) await store.abandon(r.runId);
      } catch (err) {
        app.showToast(`Kapatılamadı: ${err.message}`);
        return;
      }
      state.message = null;
      render();
      app.showToast("Açık test kapatıldı. Başlatmak için Enter'a basın.", 'success');
      $('pt-serial').value = serial;
      $('pt-serial').focus();
    });
    return button;
  }

  function reopenButton(serial) {
    if (!(user ? ['engineer', 'admin'].includes(user.role) : true)) return null;
    const button = el('button', { type: 'button', className: 'btn btn-sm mt-sm', textContent: 'Onarım sonrası yeniden aç…' });
    button.addEventListener('click', async () => {
      await ctx.reopenUnit(serial);
      state.message = null;
      render();
      lookupUnit();
    });
    return button;
  }

  function renderSafety() {
    const box = $('pt-safety');
    const safety = state.last?.safety;
    if (!safety || state.run) {
      box.classList.add('hidden');
      return;
    }
    box.className = `pt-safety pt-safety-${safety.state.toLowerCase()}`;
    const children = [el('strong', { textContent: SAFETY_TEXT[safety.state] }), safety.reason ? el('span', { textContent: ` — ${safety.reason}` }) : null];
    if (state.ackRequired) {
      const ack = el('button', { type: 'button', className: 'btn btn-sm', textContent: 'Beslemeyi kontrol ettim, kart güvenli' });
      ack.addEventListener('click', () => {
        state.ackRequired = false;
        app.storage.set(ACK_KEY, null);
        render();
        $('pt-serial').focus();
      });
      children.push(el('div', { className: 'mt-sm' }, el('span', { textContent: 'Kartı fikstürden çıkarmadan önce beslemenin kesildiğini kontrol edin. ' }), ack));
    }
    fill(box, ...children);
  }

  function renderSave() {
    const box = $('pt-save');
    const last = state.last;
    if (!last || state.run) {
      box.classList.add('hidden');
      return;
    }
    const text = {
      saving: ['idle', 'Kaydediliyor…'],
      saved: ['pass', store.kind === 'sqlite' ? 'Sunucuya kaydedildi' : 'Bu tarayıcıya kaydedildi'],
      pending: ['error', `Sonuç bu tarayıcıda güvende; sunucuya henüz gönderilemedi (${last.saveError ?? ''}). Otomatik tekrar denenecek.`],
      rejected: ['fail', `Sonuç reddedildi: ${last.saveError ?? ''}. Geçmiş sayfasındaki "bekleyen kayıtlar" listesinden inceleyin.`],
      unsaved: ['fail', 'Sonuç hiçbir yere kaydedilemedi (tarayıcı deposu). Yeni teste geçmeden önce dışa aktarın.'],
    }[last.saved];
    if (!text) {
      box.classList.add('hidden');
      return;
    }
    box.className = 'pt-save';
    const children = [badge(text[0] === 'pass' ? 'PASS' : text[0] === 'idle' ? 'PENDING' : text[0] === 'fail' ? 'FAIL' : 'ERROR', 'kayıt'), el('span', { textContent: ` ${text[1]}` })];
    if (last.saved === 'unsaved') {
      const exportButton = el('button', { type: 'button', className: 'btn btn-sm', textContent: 'Sonucu JSON indir' });
      exportButton.addEventListener('click', () => {
        download(JSON.stringify(state.unsaved, null, 2), `test-${state.unsaved.serial}-${state.unsaved.runId}.json`, 'application/json');
        state.unsaved = null;
        render();
      });
      children.push(el('div', { className: 'mt-sm' }, exportButton));
    }
    fill(box, ...children);
  }

  // ---------- unit status line ----------

  async function lookupUnit() {
    const product = state.product;
    const serial = normalizeSerial($('pt-serial').value);
    const token = ++unitLookup;
    if (!product || validateSerial(serial, product.serialMask)) {
      $('pt-unit').textContent = '';
      return;
    }
    try {
      const unit = await store.unitStatus(serial, product.code, sourceNow());
      if (token !== unitLookup) return; // a newer lookup (the operator kept typing) wins
      $('pt-unit').className = `pt-unit${unit.blocked ? ' text-fail' : ''}`;
      $('pt-unit').textContent = unit.attempts
        ? `${unit.attempts} deneme · son: ${RESULT_TEXT[unit.lastResult]} · FAIL ${unit.failures}/${product.maxAttempts}${unit.errors ? ` · HATA ${unit.errors}/${product.maxErrors}` : ''}${unit.blocked ? ' · onarıma gönderin' : ''}${unit.openReservations ? ' · şu an başka istasyonda' : ''}`
        : 'Yeni kart';
    } catch {
      if (token === unitLookup) $('pt-unit').textContent = '';
    }
  }

  // ---------- device io (through the port's command channel) ----------

  function deviceIo(run) {
    const channel = () => {
      const c = app.getChannel();
      if (!c) throw Object.assign(new Error('Bağlantı yok'), { code: 'NOT_CONNECTED' });
      return c;
    };
    return {
      request: (command, { timeoutMs, signal, id }) =>
        channel().request(command, { timeoutMs, signal, id, owner: run.runId, protocol: run.product.protocol }).then((r) => r.reply),
      newId: () => (run.product.protocol === 'v2' ? channel().newId() : null),
      // The question covers the page, so it carries its own "stop" action
      confirm: (step, signal) =>
        ask(step.prompt, { title: 'Operatör kontrolü', signal, stop: { label: 'Testi durdur', onClick: () => run.controller.abort('Test operatör tarafından durduruldu') } }),
      sleep,
      startHeartbeat: (o) => channel().startHeartbeat({ ...o, owner: run.runId }),
      stopHeartbeat: () => app.getChannel()?.stopHeartbeat(run.runId),
    };
  }

  // ---------- active-run marks (recovery after a crash or reload) ----------

  function markActive(run) {
    const runs = app.storage.get(ACTIVE_KEY, {}) ?? {};
    runs[run.runId] = { serial: run.serial, productCode: run.product.code, source: run.source, startedAt: new Date().toISOString() };
    app.storage.set(ACTIVE_KEY, runs);
    run.finished = new Promise((resolve) => (run.finish = resolve));
    navigator.locks?.request(lockName(run.runId), () => run.finished).catch(() => {});
  }

  function clearActive(run) {
    const runs = app.storage.get(ACTIVE_KEY, {}) ?? {};
    delete runs[run.runId];
    app.storage.set(ACTIVE_KEY, runs);
    run.finish?.();
  }

  /**
   * Runs marked active whose lock is gone belong to a page that died mid-test. Their
   * reservation is released (unless the result already reached the outbox) and the
   * board is treated as unverified until the operator has checked it.
   */
  async function recoverInterruptedRuns() {
    const runs = app.storage.get(ACTIVE_KEY, {}) ?? {};
    if (!Object.keys(runs).length) return;
    // Without the Web Locks API (very old browsers) every mark is treated as interrupted
    const locks = navigator.locks?.query ? await navigator.locks.query().catch(() => null) : null;
    const held = new Set((locks?.held ?? []).map((l) => l.name));
    const queued = new Set((await outbox.list().catch(() => [])).map((e) => e.runId));
    const interrupted = [];
    for (const [runId, mark] of Object.entries(runs)) {
      if (held.has(lockName(runId))) continue; // still running in another tab
      if (!queued.has(runId)) {
        try {
          await store.abandon(runId);
        } catch {
          continue; // server unreachable or not allowed: keep the mark and try again next time
        }
        interrupted.push(mark);
      }
      delete runs[runId];
    }
    app.storage.set(ACTIVE_KEY, runs);
    const last = interrupted.at(-1);
    if (!last || state.run) return;
    state.last = {
      serial: last.serial,
      result: 'ERROR',
      reason: 'Önceki test yarıda kaldı: sayfa test bitmeden kapandı. Sonuç kaydedilmedi, rezervasyon kapatıldı.',
      safety: { state: 'UNVERIFIED', reason: 'Sayfa test sırasında kapandı; kapanma doğrulanmadı' },
      source: last.source,
      saved: null,
    };
    state.ackRequired = true;
    app.storage.set(ACK_KEY, { ...state.last });
    render();
  }

  async function releasePort(run) {
    if (run.locked) {
      run.locked = false;
      await app.unlockPort(run.runId).catch(() => {});
    }
    app.setTestActive(false);
  }

  // ---------- the run ----------

  /**
   * Starts a test. Everything up to setPhase('CHECKING') is synchronous, so a second
   * call (double click, barcode scanner repeat) sees the phase and returns.
   */
  async function start(rawSerial, { retestReason } = {}) {
    if (!STARTABLE.includes(state.phase)) return;
    if (state.ackRequired) return app.showToast('Önce önceki kartın beslemesini kontrol ettiğinizi onaylayın');
    if (state.unsaved) return app.showToast('Kaydedilemeyen sonucu önce dışa aktarın');
    const product = state.product;
    if (!product) return;
    const serial = normalizeSerial(rawSerial);
    const serialError = validateSerial(serial, product.serialMask);
    $('pt-serial').classList.toggle('invalid', Boolean(serialError));
    if (serialError) return app.showToast(serialError);
    const connection = app.getConnection();
    const kind = app.getTransportKind();
    if (!connection.connected || !kind) return app.showToast('Önce cihaza bağlanın (donanım yoksa Simülatör modu)');

    const run = {
      runId: crypto.randomUUID(),
      serial,
      product, // frozen: a revision published meanwhile does not affect this run
      operator: user?.displayName ?? $('pt-operator').value.trim(),
      connection: { ...connection, kind },
      source: kind === 'demo' ? 'simulation' : 'hardware',
      transport: TRANSPORT_OF[kind],
      controller: new AbortController(),
      view: idleSteps(product),
      locked: false,
    };
    state.run = run;
    state.message = null;
    state.last = null;
    state.log = [];
    renderLog($('pt-log'), state.log);
    setPhase('CHECKING');

    try {
      // A result of this board still waiting in the outbox would hold its reservation open
      const queued = (await outbox.list()).find((e) => e.submission.serial === serial);
      if (queued) throw Object.assign(new Error('Bu kartın önceki sonucu henüz kaydedilmedi. Geçmiş → "Kaydedilmeyi bekleyen sonuçlar" listesinden gönderin.'), { code: 'OUTBOX_PENDING' });
      await app.lockPort(run.runId);
      run.locked = true;
      app.setTestActive(true);
      await store.reserve({
        runId: run.runId,
        serial,
        productCode: product.code,
        recipeRevision: product.revision,
        source: run.source,
        transport: run.transport,
        retestReason,
      });
      markActive(run);
    } catch (err) {
      await releasePort(run);
      state.run = null;
      if (err.code === 'PASSED_NEEDS_REASON') {
        setPhase('IDLE');
        const reason = await promptText(`${serial} daha önce PASS aldı. Neden tekrar test ediliyor?`, { title: 'Tekrar test gerekçesi', minLength: 5, placeholder: 'ör. müşteri iadesi kontrolü' });
        if (reason) return start(serial, { retestReason: reason });
        return;
      }
      if (err.code === 'REVISION_OUTDATED') await ctx.reloadProducts();
      const holders = err.code === 'IN_PROGRESS' ? err.details?.reservations ?? [] : [];
      state.message = {
        kind: err.code === 'BLOCKED' ? 'fail' : 'error',
        title: err.code === 'BLOCKED' ? 'ONARIM' : 'BAŞLATILAMADI',
        serial,
        text: holders.length ? `${err.message}: ${holders.map(describeHolder).join('; ')}` : err.message,
        reopen: err.code === 'BLOCKED',
        release: holders.length ? holders : null,
      };
      setPhase('ERROR');
      return;
    }

    setPhase('RUNNING');
    let raw = null;
    let crash = null;
    try {
      raw = await runTest({
        product,
        serial,
        io: deviceIo(run),
        signal: run.controller.signal,
        onProgress(event) {
          if (state.run !== run) return; // a stale callback of an earlier run
          if (event.type === 'log') {
            if (event.replace && state.log.length) state.log[state.log.length - 1] = event.entry; // heartbeat counter
            else state.log.push(event.entry);
            renderLog($('pt-log'), state.log);
            return;
          }
          if (event.phase === 'teardown' && state.phase === 'RUNNING') state.phase = 'TEARDOWN';
          const list = event.phase === 'steps' ? run.view.steps : run.view.teardown;
          list[event.index] = { ...list[event.index], status: event.status, ...(event.verdict ?? {}), data: event.data ?? list[event.index].data };
          render();
        },
      });
    } catch (err) {
      crash = err; // runTest reports device errors in its result; this is a bug, not a board failure
    } finally {
      await releasePort(run);
    }
    if (!raw) {
      store.abandon(run.runId).catch(() => {});
      clearActive(run);
      state.run = null;
      state.message = { kind: 'error', title: 'HATA', serial, text: `Test yürütülemedi: ${crash?.message}. Kartın beslemesini kontrol edin.` };
      setPhase('ERROR');
      return;
    }

    const verdict = evaluateRun(product.recipe, raw.steps, raw.teardown, { error: raw.error });
    state.last = { ...verdict, serial, source: run.source, runId: run.runId, saved: 'saving' };
    setPhase('SAVING');

    const submission = {
      runId: run.runId,
      serial,
      operator: run.operator,
      productCode: product.code,
      recipeRevision: product.revision,
      source: run.source,
      transport: run.transport,
      startedAt: raw.startedAt,
      finishedAt: raw.finishedAt,
      steps: raw.steps,
      teardown: raw.teardown,
      error: raw.error,
      log: raw.log,
      appVersion: app.version,
    };

    if (!['SAFE', 'NOT_CHECKED'].includes(verdict.safety.state)) {
      state.ackRequired = true;
      app.storage.set(ACK_KEY, { serial, result: verdict.result, reason: verdict.reason, safety: verdict.safety, source: run.source, runId: run.runId });
    }
    try {
      await outbox.add(submission); // write-ahead: from here on the result cannot be lost
      clearActive(run);
    } catch (err) {
      // Nothing was stored: release the unit; the exported JSON is the only copy
      store.abandon(run.runId).catch(() => {});
      clearActive(run);
      state.unsaved = submission;
      state.last = { ...state.last, saved: 'unsaved', saveError: err.message };
      state.run = null;
      setPhase('ERROR');
      return;
    }
    try {
      const record = await outbox.deliver(run.runId);
      if (state.last?.runId === run.runId) state.last = { ...record, saved: 'saved' };
      ctx.onStored(record);
    } catch (err) {
      if (state.last?.runId === run.runId) state.last = { ...state.last, saved: err.permanent ? 'rejected' : 'pending', saveError: err.message };
    }
    state.run = null;
    $('pt-serial').value = '';
    $('pt-unit').textContent = '';
    setPhase('COMPLETED');
    $('pt-serial').focus();
  }

  // ---------- simulator quick try ----------

  /**
   * Next unused demo serial whose simulated board has the wanted defect (the simulator
   * derives a board's defect from its serial number, like a real batch with bad units).
   */
  function demoSerial(fault) {
    const mask = state.product.serialMask;
    const prefix = mask.slice(0, mask.indexOf('#'));
    let n = app.storage.get('demoSerialNext', 700000);
    let serial;
    do serial = `${prefix}${String((n += 1) % 1_000_000).padStart(6, '0')}`;
    while (faultForSerial(serial) !== fault);
    app.storage.set('demoSerialNext', n);
    return serial;
  }

  function quickTry(kind) {
    if (!STARTABLE.includes(state.phase) || !state.product) return;
    let fault = 'none';
    if (kind === 'faulty') {
      const i = app.storage.get('demoFaultNext', 0) % DEMO_FAULTS.length;
      app.storage.set('demoFaultNext', i + 1);
      fault = DEMO_FAULTS[i];
      app.showToast(`Bu kartta gizli bir arıza var: ${FAULTS[fault].toLowerCase()}. İstasyon yakalayabilecek mi?`, 'success');
    }
    app.setSimulatorFault?.('auto');
    const serial = demoSerial(fault);
    $('pt-serial').value = serial;
    start(serial);
  }

  $('pt-demo-actions').addEventListener('click', (e) => {
    const kind = e.target.closest('[data-demo]')?.dataset.demo;
    if (kind === 'reports') ctx.showSampleReports?.();
    else if (kind) quickTry(kind);
  });

  // ---------- events ----------

  $('pt-form').addEventListener('submit', (e) => {
    e.preventDefault();
    start($('pt-serial').value);
  });
  let unitTimer = null;
  $('pt-serial').addEventListener('input', () => {
    $('pt-serial').classList.remove('invalid');
    state.message = null;
    clearTimeout(unitTimer);
    unitTimer = setTimeout(lookupUnit, 250);
  });
  $('pt-cancel').addEventListener('click', () => state.run?.controller.abort('Test operatör tarafından durduruldu'));
  $('pt-operator').value = app.storage.get('productionOperator', '');
  $('pt-operator').addEventListener('change', () => app.storage.set('productionOperator', $('pt-operator').value.trim()));

  // A lost connection aborts the run; the teardown still tries, the watchdog covers the rest
  app.onStatus(({ connected }) => {
    if (!connected && state.run && ['RUNNING', 'CHECKING'].includes(state.phase)) state.run.controller.abort('Test sırasında cihaz bağlantısı koptu');
    render();
  });

  // Closing the tab mid-test: best-effort power off; the board's watchdog is the real guarantee
  window.addEventListener('pagehide', () => {
    if (state.run && ['RUNNING', 'TEARDOWN'].includes(state.phase)) app.getChannel()?.emergency('PWR OFF');
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.run || state.unsaved) e.preventDefault();
  });

  recoverInterruptedRuns().catch(() => {});

  return {
    start,
    render,
    lookupUnit,
    get phase() {
      return state.phase;
    },
    get busy() {
      return !STARTABLE.includes(state.phase);
    },
    /** Outbox events: a pending result of the last run was stored (or refused) later. */
    onOutboxEvent(event) {
      if (state.last?.runId !== event.runId || state.run) return;
      if (event.type === 'saved') state.last = { ...event.record, saved: 'saved' };
      else if (event.type === 'rejected') state.last = { ...state.last, saved: 'rejected', saveError: event.error };
      else return;
      render();
    },
    setProduct(product) {
      if (state.run) return; // never swap the recipe of a running test
      state.product = product;
      if (!state.ackRequired) state.last = null; // keep the unsafe-board warning visible
      state.message = null;
      render();
      lookupUnit();
    },
    prefill(serial) {
      if (this.busy) return;
      $('pt-serial').value = serial;
      lookupUnit();
      $('pt-serial').focus();
    },
  };
}
