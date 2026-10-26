// ============================================
// OUTBOX — durable queue of finished test runs that are not stored yet.
//
// A run is written here (IndexedDB) before it is sent, and removed only after the
// store confirmed it. Network and server errors keep it pending with backoff;
// permanent refusals (validation, conflict, missing reservation) mark it
// "rejected" so a person can export or retry it. Nothing is discarded silently.
// The store's runId idempotency makes resends after a lost response harmless.
// ============================================

const BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];

export class Outbox {
  /**
   * @param {object} options
   * @param {import('./local-db.js').LocalDb} options.db
   * @param {(submission: object) => Promise<object>} options.send stores one run; errors with `permanent: true` are not retried
   * @param {(event: object) => void} [options.onChange] {type: 'queued'|'saved'|'failed'|'rejected'|'discarded', runId, ...}
   */
  constructor({ db, send, onChange = () => {} }) {
    this.db = db;
    this.send = send;
    this.onChange = onChange;
    this.flushing = null;
    this.timer = null;
  }

  /** Persists a run before any network activity. Throws StorageError if the browser cannot store it. */
  async add(submission) {
    const now = new Date().toISOString();
    await this.db.put('outbox', { runId: submission.runId, submission, state: 'pending', attempts: 0, lastError: null, createdAt: now, updatedAt: now, nextAttemptAt: 0 });
    this.onChange({ type: 'queued', runId: submission.runId });
  }

  list() {
    return this.db.getAll('outbox');
  }

  async counts() {
    const entries = await this.list();
    return { pending: entries.filter((e) => e.state === 'pending').length, rejected: entries.filter((e) => e.state === 'rejected').length };
  }

  /** Sends one entry now. Resolves with the stored record, rejects with the send error. */
  async deliver(runId) {
    const entry = await this.db.get('outbox', runId);
    if (!entry) return null;
    try {
      const record = await this.send(entry.submission);
      await this.db.delete('outbox', runId);
      this.onChange({ type: 'saved', runId, record });
      return record;
    } catch (err) {
      const attempts = entry.attempts + 1;
      const permanent = Boolean(err.permanent);
      await this.db.put('outbox', {
        ...entry,
        state: permanent ? 'rejected' : 'pending',
        attempts,
        lastError: err.message,
        updatedAt: new Date().toISOString(),
        nextAttemptAt: Date.now() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)],
      });
      this.onChange({ type: permanent ? 'rejected' : 'failed', runId, error: err.message });
      throw err;
    }
  }

  /** Sends every due pending entry, oldest first. Only one flush runs at a time. */
  flush({ force = false } = {}) {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      const entries = (await this.list()).filter((e) => e.state === 'pending' && (force || e.nextAttemptAt <= Date.now()));
      entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const entry of entries) {
        try {
          await this.deliver(entry.runId);
        } catch {
          // recorded on the entry; keep going with the others
        }
      }
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Puts a rejected entry back in the queue and tries it now. */
  async retry(runId) {
    const entry = await this.db.get('outbox', runId);
    if (!entry) return null;
    await this.db.put('outbox', { ...entry, state: 'pending', nextAttemptAt: 0 });
    return this.deliver(runId);
  }

  /** Explicit, user-confirmed removal (after exporting). */
  async discard(runId) {
    await this.db.delete('outbox', runId);
    this.onChange({ type: 'discarded', runId });
  }

  async exportJson() {
    return JSON.stringify({ exportedAt: new Date().toISOString(), entries: await this.list() }, null, 2);
  }

  /** Retries on an interval, when the browser comes back online and right away (page reload recovery). */
  start(intervalMs = 5000) {
    this.stop();
    this.timer = setInterval(() => this.flush(), intervalMs);
    this.onOnline = () => this.flush({ force: true });
    globalThis.addEventListener?.('online', this.onOnline);
    return this.flush({ force: true });
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.onOnline) globalThis.removeEventListener?.('online', this.onOnline);
  }
}
