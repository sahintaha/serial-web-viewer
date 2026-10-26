// ============================================
// COMMAND CHANNEL — one per serial connection.
//
// Serialises commands (one request in flight at a time), matches replies by
// request id, enforces an owner lock while a test runs and sends heartbeats.
// See docs/protocol.md.
//
//   v2 (default):  "#00A1 MEAS?"   →  "@#00A1 V5.012,I118.3"
//   v1 (legacy, opt-in per product): "MEAS?" → "@V5.012,I118.3"
//
// In v2 a reply is only accepted when its id belongs to the request in flight,
// so a late "@OK" of an earlier command can never satisfy a later one.
// ============================================

export const PROTOCOLS = ['v2', 'v1'];
const NUMBERED_REPLY_RE = /^@#([0-9A-Z]{1,8}) ?(.*)$/;

export class ChannelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChannelError';
    this.code = code; // 'LOCKED' | 'NOT_CONNECTED' | 'WRITE_FAILED' | 'CLOSED'
  }
}

/**
 * Splits a reply line. Returns null for lines that are not protocol replies.
 * @returns {{id: string|null, body: string}|null}
 */
export function parseReply(line) {
  if (typeof line !== 'string' || !line.startsWith('@')) return null;
  const numbered = line.match(NUMBERED_REPLY_RE);
  if (numbered) return { id: numbered[1], body: numbered[2].trim() };
  return { id: null, body: line.slice(1).trim() };
}

const abortError = (reason) => Object.assign(new Error(reason || 'İptal edildi'), { name: 'AbortError' });

export class CommandChannel {
  /**
   * @param {object} options
   * @param {(line: string) => Promise<void>} options.write writes one line to the port; must reject on failure
   * @param {() => boolean} [options.isConnected]
   * @param {number} [options.staleGuardMs] v1 only: after a timeout, replies arriving within this window are discarded
   */
  constructor({ write, isConnected = () => true, staleGuardMs = 300 }) {
    this.write = write;
    this.isConnected = isConnected;
    this.staleGuardMs = staleGuardMs;
    this.queue = Promise.resolve();
    this.inflight = null; // { id, protocol, resolve }
    this.owner = null;
    this.counter = Math.floor(Math.random() * 36 ** 3);
    this.stats = { stale: 0, unmatched: 0, sent: 0 };
    this.quietUntil = 0;
    this.lastActivity = Date.now();
    this.heartbeat = null;
    this.closed = false;
  }

  /** Short base-36 id; unique within the device's reply cache window. */
  newId() {
    this.counter = (this.counter + 1) % 36 ** 4;
    return this.counter.toString(36).toUpperCase().padStart(4, '0');
  }

  // ---------- ownership ----------

  lock(owner) {
    if (this.owner && this.owner !== owner) throw new ChannelError('LOCKED', 'Port başka bir işlem tarafından kullanılıyor');
    this.owner = owner;
  }

  unlock(owner) {
    if (this.owner === owner) this.owner = null;
    this.stopHeartbeat(owner);
  }

  assertWritable(owner) {
    if (this.closed) throw new ChannelError('CLOSED', 'Bağlantı kapandı');
    if (!this.isConnected()) throw new ChannelError('NOT_CONNECTED', 'Bağlantı yok');
    if (this.owner && this.owner !== owner) {
      throw new ChannelError('LOCKED', 'Test çalışırken bu porta başka komut gönderilemez');
    }
  }

  /** Free text from the monitor ("Komut gönder"), refused while a test owns the port. */
  async sendRaw(text, owner = 'monitor', { ending = 'lf' } = {}) {
    this.assertWritable(owner);
    return this.enqueue(async () => {
      this.assertWritable(owner);
      await this.writeLine(text, { ending });
    });
  }

  // ---------- requests ----------

  enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  async writeLine(text, options) {
    try {
      await this.write(text, options);
      this.stats.sent += 1;
      this.lastActivity = Date.now();
    } catch (err) {
      throw new ChannelError('WRITE_FAILED', `Gönderilemedi: ${err.message}`);
    }
  }

  /**
   * Sends one command and waits for its reply.
   * @param {string} command
   * @param {object} options
   * @param {number} options.timeoutMs
   * @param {string} [options.owner] must match the lock holder, if any
   * @param {string} [options.id] reuse an id to retry the same request (the device replays its cached reply)
   * @param {'v2'|'v1'} [options.protocol]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{reply: string|null, id: string|null}>} reply body, or null on timeout
   */
  request(command, { timeoutMs, owner, id, protocol = 'v2', signal }) {
    const requestId = protocol === 'v2' ? id ?? this.newId() : null;
    return this.enqueue(async () => {
      if (signal?.aborted) throw abortError(signal.reason);
      this.assertWritable(owner);
      if (protocol === 'v1') {
        // Let replies to an earlier, timed-out command drain before asking again
        const wait = this.quietUntil - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(() => {
          if (protocol === 'v1') this.quietUntil = Date.now() + this.staleGuardMs;
          resolve({ reply: null, id: requestId });
        }), timeoutMs);
        const onAbort = () => finish(() => reject(abortError(signal.reason)));
        const finish = (fn) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          this.inflight = null;
          fn();
        };
        this.inflight = { id: requestId, protocol, resolve: (reply) => finish(() => resolve({ reply, id: requestId })) };
        signal?.addEventListener('abort', onAbort, { once: true });
        const line = protocol === 'v2' ? `#${requestId} ${command}` : command;
        this.writeLine(line).catch((err) => finish(() => reject(err)));
      });
    });
  }

  /** Feed every received line here. Returns true when the line was consumed as a reply. */
  handleLine(line) {
    const reply = parseReply(line);
    if (!reply) return false;
    this.lastActivity = Date.now();
    const current = this.inflight;
    if (current?.protocol === 'v2' && reply.id === current.id) {
      current.resolve(reply.body);
      return true;
    }
    if (current?.protocol === 'v1' && reply.id === null && Date.now() >= this.quietUntil) {
      current.resolve(reply.body);
      return true;
    }
    // A late reply to an earlier request, a duplicate, or a reply to someone else's command
    if (reply.id !== null) this.stats.stale += 1;
    else this.stats.unmatched += 1;
    return false;
  }

  // ---------- heartbeat ----------

  /**
   * Sends "PING" whenever the line has been idle for intervalMs, keeping the
   * device watchdog fed during long waits (operator questions, delays).
   * onBeat({id, reply, ms}) reports every heartbeat, so the run log can show them.
   */
  startHeartbeat({ owner, intervalMs, timeoutMs = 500, maxMisses = 3, onFail, onBeat }) {
    this.stopHeartbeat();
    let misses = 0;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || this.inflight || Date.now() - this.lastActivity < intervalMs) return;
      busy = true;
      try {
        const sent = Date.now();
        const { reply, id } = await this.request('PING', { timeoutMs, owner });
        try {
          onBeat?.({ id, reply, ms: Date.now() - sent });
        } catch {
          // logging must never stop the heartbeat
        }
        misses = reply === null ? misses + 1 : 0;
        if (misses >= maxMisses) {
          this.stopHeartbeat();
          onFail?.(`Cihaz ${maxMisses} heartbeat'e cevap vermedi`);
        }
      } catch {
        // the test itself reports write / lock errors
      } finally {
        busy = false;
      }
    }, Math.max(50, Math.floor(intervalMs / 4)));
    this.heartbeat = { owner, timer };
  }

  stopHeartbeat(owner) {
    if (!this.heartbeat || (owner && this.heartbeat.owner !== owner)) return;
    clearInterval(this.heartbeat.timer);
    this.heartbeat = null;
  }

  /**
   * Best-effort write that bypasses the queue and the lock — only for the page being
   * closed in the middle of a test ("PWR OFF"). The device watchdog is the real safeguard.
   */
  emergency(text) {
    if (this.closed || !this.isConnected()) return;
    this.write(text).catch(() => {});
  }

  close() {
    this.closed = true;
    this.stopHeartbeat();
    this.inflight?.resolve(null);
    this.owner = null;
  }
}
