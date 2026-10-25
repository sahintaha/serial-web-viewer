// ============================================
// TEST RUNNER — executes a product recipe against a device.
//
// Transport-agnostic: everything device-related goes through `io`, so the same
// runner drives Web Serial, the Node bridge, the simulator and the unit tests.
//
//   io.request(command, timeoutMs, signal) → reply text without "@", or null on timeout
//   io.confirm(step, signal)               → operator answer (true / false)
//   io.sleep(ms, signal)
//
// Only replies that arrive *after* a command is sent are considered, so stale
// lines from before the board was plugged in can never count as a measurement.
// ============================================

import { evaluateStep, renderCommand } from './recipe.js';

const MAX_LOG_ENTRIES = 400;

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

/**
 * Runs a product's recipe for one unit.
 *
 * @param {object} options
 * @param {object} options.product validated product revision
 * @param {string} options.serial
 * @param {object} options.io see header
 * @param {(event: object) => void} [options.onProgress] {type: 'step', phase, index, status, verdict?} | {type: 'log', entry}
 * @param {AbortSignal} [options.signal] abort with a reason string (operator cancel, lost connection)
 * @returns {Promise<{steps: object[], teardown: object[], error: string|null, log: object[], startedAt: string, finishedAt: string}>}
 */
export async function runTest({ product, serial, io, onProgress = () => {}, signal }) {
  const startedAt = new Date();
  const ctx = { serial };
  const log = [];

  const note = (dir, text) => {
    if (log.length >= MAX_LOG_ENTRIES) return;
    const entry = { t: Date.now() - startedAt.getTime(), dir, text };
    log.push(entry);
    onProgress({ type: 'log', entry });
  };

  async function request(template, timeoutMs, retries, sig) {
    const command = renderCommand(template, ctx);
    let attempts = 0;
    for (;;) {
      attempts += 1;
      note('TX', command);
      const reply = await io.request(command, timeoutMs, sig);
      if (reply !== null) {
        note('RX', reply);
        return { reply, attempts };
      }
      note('--', `cevap yok (${timeoutMs} ms)`);
      if (attempts > retries) return { reply: null, attempts };
    }
  }

  async function execute(step, sig) {
    const started = Date.now();
    let data;
    switch (step.type) {
      case 'delay':
        await io.sleep(step.ms, sig);
        data = {};
        break;
      case 'command':
        data = await request(step.send, step.timeoutMs, step.retries, sig);
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
          if (evaluateStep({ ...step, prompt: step.prompt }, { ...data, answer: true }).status !== 'PASS') {
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
  try {
    for (const [index, step] of product.recipe.steps.entries()) {
      if (signal?.aborted) throw abortError(signal.reason);
      onProgress({ type: 'step', phase: 'steps', index, status: 'RUNNING' });
      const data = await execute(step, signal);
      stepsData[index] = data;
      const verdict = evaluateStep(step, data);
      onProgress({ type: 'step', phase: 'steps', index, status: verdict.status, verdict, data });
      if (product.recipe.stopOnFail && verdict.status !== 'PASS') break;
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
    error = err.message;
  }

  // Teardown always runs (e.g. switch the board off), even after a cancel.
  // It stops at the first communication failure: the device is probably gone.
  const teardownData = [];
  for (const [index, step] of product.recipe.teardown.entries()) {
    onProgress({ type: 'step', phase: 'teardown', index, status: 'RUNNING' });
    try {
      const data = await execute(step);
      teardownData[index] = data;
      const verdict = evaluateStep(step, data);
      onProgress({ type: 'step', phase: 'teardown', index, status: verdict.status, verdict, data });
      if (verdict.status === 'ERROR') break;
    } catch (err) {
      note('--', `teardown durdu: ${err.message}`);
      onProgress({ type: 'step', phase: 'teardown', index, status: 'SKIPPED' });
      break;
    }
  }

  return {
    steps: stepsData,
    teardown: teardownData,
    error,
    log,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  };
}
