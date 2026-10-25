// ============================================
// TEST RUNNER — executes a product recipe against a device.
//
// Transport-agnostic: everything device-related goes through `io`, so the same
// runner drives Web Serial, the Node bridge, the simulator and the unit tests.
//
//   io.request(command, {timeoutMs, signal, id}) → reply body, or null on timeout
//   io.newId()                                   → request id (protocol v2), reused for retries
//   io.confirm(step, signal)                     → operator answer (true / false)
//   io.sleep(ms, signal)
//   io.startHeartbeat?({intervalMs, onFail}) / io.stopHeartbeat?()
//
// Guarantees:
//   - Teardown steps run after every outcome: PASS, FAIL, cancel, lost connection
//     and unexpected exceptions. A failing teardown step never prevents the next one.
//   - Critical teardown steps (e.g. PWR OFF) are retried at least twice.
//   - The verdict on the board and whether it was left safe are reported separately.
// ============================================

import { evaluateStep, renderCommand } from './recipe.js';

const MAX_LOG_ENTRIES = 399; // one slot left for the "lines dropped" notice
const MIN_CRITICAL_RETRIES = 2;

export function abortError(reason) {
  const err = new Error(reason || 'İptal edildi');
  err.name = 'AbortError';
  return err;
}

/** Promise-based sleep that rejects when the signal aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal.reason));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal.reason));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const isConnectionLoss = (err) => ['NOT_CONNECTED', 'CLOSED', 'WRITE_FAILED'].includes(err?.code);

/**
 * Runs a product's recipe for one unit.
 *
 * @param {object} options
 * @param {object} options.product validated product revision
 * @param {string} options.serial
 * @param {object} options.io see header
 * @param {(event: object) => void} [options.onProgress] {type: 'step', phase, index, status, verdict?, data?} | {type: 'log', entry}
 * @param {AbortSignal} [options.signal] abort with a reason string (operator cancel, lost connection)
 * @returns {Promise<{steps: object[], teardown: object[], error: string|null, log: object[], startedAt: string, finishedAt: string}>}
 */
export async function runTest({ product, serial, io, onProgress = () => {}, signal }) {
  const startedAt = new Date();
  const ctx = { serial };
  const log = [];
  let logDropped = 0;
  const internal = new AbortController();
  const runSignal = signal ? AbortSignal.any([signal, internal.signal]) : internal.signal;

  const safeProgress = (event) => {
    try {
      onProgress(event);
    } catch {
      // a UI error must never interrupt the test or skip the teardown
    }
  };

  const note = (dir, text) => {
    if (log.length >= MAX_LOG_ENTRIES) {
      logDropped += 1;
      return;
    }
    const entry = { t: Date.now() - startedAt.getTime(), dir, text };
    log.push(entry);
    safeProgress({ type: 'log', entry });
  };

  async function request(template, timeoutMs, retries, sig) {
    const command = renderCommand(template, ctx);
    const id = io.newId?.() ?? null; // the same id for every retry → the device replays instead of re-executing
    let attempts = 0;
    for (;;) {
      attempts += 1;
      note('TX', id ? `#${id} ${command}` : command);
      const reply = await io.request(command, { timeoutMs, signal: sig, id });
      if (reply !== null) {
        note('RX', reply);
        return { reply, attempts };
      }
      note('--', `cevap yok (${timeoutMs} ms)`);
      if (attempts > retries) return { reply: null, attempts };
    }
  }

  async function execute(step, sig, { critical = false } = {}) {
    const started = Date.now();
    let data;
    switch (step.type) {
      case 'delay':
        await io.sleep(step.ms, sig);
        data = {};
        break;
      case 'command':
        data = await request(step.send, step.timeoutMs, critical ? Math.max(step.retries, MIN_CRITICAL_RETRIES) : step.retries, sig);
        break;
      case 'measure': {
        const replies = [];
        for (let i = 0; i < step.samples; i += 1) {
          if (i > 0 && step.intervalMs) await io.sleep(step.intervalMs, sig);
          const { reply } = await request(step.send, step.timeoutMs, step.retries, sig);
          replies.push(reply);
          if (reply?.startsWith('ERR')) break; // the device reported a fault; more samples won't help
        }
        data = { replies };
        break;
      }
      case 'confirm': {
        data = {};
        if (step.send) {
          Object.assign(data, await request(step.send, step.timeoutMs, 0, sig));
          if (evaluateStep(step, { ...data, answer: true }).status !== 'PASS') {
            data.answer = null; // the device didn't do its part; don't ask the operator
            break;
          }
        }
        note('OP', step.prompt);
        data.answer = await io.confirm(step, sig);
        note('OP', data.answer ? 'Evet' : 'Hayır');
        break;
      }
      default:
        throw new Error(`Bilinmeyen adım tipi: ${step.type}`);
    }
    data.durationMs = Date.now() - started;
    return data;
  }

  const stepsData = [];
  let error = null;

  if (product.heartbeatMs > 0 && io.startHeartbeat) {
    io.startHeartbeat({
      intervalMs: product.heartbeatMs,
      onFail: (reason) => internal.abort(reason),
    });
  }

  try {
    for (const [index, step] of product.recipe.steps.entries()) {
      if (runSignal.aborted) throw abortError(runSignal.reason);
      safeProgress({ type: 'step', phase: 'steps', index, status: 'RUNNING' });
      const data = await execute(step, runSignal);
      stepsData[index] = data;
      const verdict = evaluateStep(step, data);
      safeProgress({ type: 'step', phase: 'steps', index, status: verdict.status, verdict, data });
      if (product.recipe.stopOnFail && verdict.status !== 'PASS') break;
    }
  } catch (err) {
    if (err.name === 'AbortError') error = err.message;
    else if (isConnectionLoss(err)) error = `Bağlantı koptu: ${err.message}`;
    else error = `Beklenmeyen hata: ${err.message}`;
    note('--', error);
  } finally {
    io.stopHeartbeat?.();
  }

  // ---------- teardown: always, step by step, never short-circuited by a failure ----------
  const teardownData = [];
  let connectionGone = false;
  for (const [index, step] of product.recipe.teardown.entries()) {
    if (connectionGone) {
      teardownData[index] = { reply: null, attempts: 1, error: 'Bağlantı yok, gönderilemedi', durationMs: 0 };
      safeProgress({ type: 'step', phase: 'teardown', index, status: 'ERROR', verdict: { status: 'ERROR', reason: 'Bağlantı yok, gönderilemedi' } });
      continue;
    }
    safeProgress({ type: 'step', phase: 'teardown', index, status: 'RUNNING' });
    let data;
    try {
      // No abort signal: a cancel must not stop the board from being switched off
      data = await execute(step, undefined, { critical: step.critical });
    } catch (err) {
      connectionGone = isConnectionLoss(err) || err.code === 'WRITE_FAILED';
      data = { reply: null, attempts: 1, error: err.message.slice(0, 200), durationMs: 0 };
      note('--', `teardown "${step.name}": ${err.message}`);
    }
    teardownData[index] = data;
    const verdict = evaluateStep(step, data);
    safeProgress({ type: 'step', phase: 'teardown', index, status: verdict.status, verdict, data });
  }

  if (logDropped) log.push({ t: Date.now() - startedAt.getTime(), dir: '--', text: `${logDropped} kayıt satırı sınır nedeniyle atlandı` });

  return {
    steps: stepsData,
    teardown: teardownData,
    error,
    log,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  };
}
