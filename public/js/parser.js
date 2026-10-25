// ============================================
// LINE PARSER — pure functions, no DOM access (unit tested in /test)
// ============================================

const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const KEY_VALUE_RE = /^([^:=]+?)\s*[:=]\s*(.*)$/;
const PREFIX_VALUE_RE = /^([A-Za-z_]+)\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)$/;

/** Returns a finite number for numeric strings, otherwise null. */
export function toNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return NUMBER_RE.test(trimmed) ? Number(trimmed) : null;
}

function parseJson(line) {
  if (!line.startsWith('{')) return null;
  try {
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return Object.entries(obj)
      .filter(([, v]) => v === null || ['number', 'string', 'boolean'].includes(typeof v))
      .map(([key, v]) => ({ key, raw: String(v) }));
  } catch {
    return null;
  }
}

function parseDelimited(line) {
  return line
    .split(/[,;\t]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => {
      const prefixed = part.match(PREFIX_VALUE_RE);
      if (prefixed) return { key: prefixed[1], raw: prefixed[2] };
      const kv = part.match(KEY_VALUE_RE);
      if (kv) return { key: kv[1].trim(), raw: kv[2].trim() };
      return { key: `#${index + 1}`, raw: part };
    });
}

/**
 * Parses one line of serial output into named fields.
 *
 * Supported formats (auto-detected):
 *   A25.5,B60,C1013        prefix + value  → keys "A", "B", "C"
 *   temp:25.5;hum=60       key:value / key=value
 *   {"temp":25.5,"hum":60} JSON object
 *   25.5,60,1013           plain values    → keys "#1", "#2", "#3"
 *
 * @param {string} line
 * @param {{prefix: string, label: string}[]} labels user mappings (key → display name)
 * @returns {{key: string, label: string, raw: string, value: number|null}[]}
 *   Configured labels come first (missing ones get raw "---"), followed by any
 *   other keys found in the line.
 */
export function parseLine(line, labels = []) {
  const text = String(line ?? '').trim();
  if (!text) return [];

  const found = parseJson(text) ?? parseDelimited(text);
  const byKey = new Map(found.map((f) => [f.key, f.raw]));
  const fields = [];
  const used = new Set();

  for (const { prefix, label } of labels) {
    if (!prefix || used.has(prefix)) continue;
    used.add(prefix);
    const raw = byKey.has(prefix) ? byKey.get(prefix) : '---';
    fields.push({ key: prefix, label: label || prefix, raw, value: toNumber(raw) });
  }

  for (const { key, raw } of found) {
    if (used.has(key)) continue;
    used.add(key);
    fields.push({ key, label: key, raw, value: toNumber(raw) });
  }

  return fields;
}

/**
 * Splits a stream of text chunks into complete lines (handles "\n" and "\r\n").
 * Incomplete trailing text is buffered until the next chunk.
 */
export function createLineSplitter(maxLineLength = 4096) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop();
      if (buffer.length > maxLineLength) {
        parts.push(buffer);
        buffer = '';
      }
      return parts.map((l) => l.replace(/\r$/, '')).filter(Boolean);
    },
    flush() {
      const rest = buffer;
      buffer = '';
      return rest ? [rest] : [];
    },
  };
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Builds a CSV document from recorded rows.
 * @param {{time: string, raw: string, fields: {label: string, raw: string}[]}[]} rows
 */
export function rowsToCsv(rows) {
  const columns = [];
  for (const row of rows) {
    for (const f of row.fields) if (!columns.includes(f.label)) columns.push(f.label);
  }
  const header = ['time', ...columns, 'raw'];
  const lines = rows.map((row) => {
    const byLabel = new Map(row.fields.map((f) => [f.label, f.raw]));
    return [row.time, ...columns.map((c) => byLabel.get(c) ?? ''), row.raw].map(csvCell).join(',');
  });
  return [header.map(csvCell).join(','), ...lines].join('\n');
}
