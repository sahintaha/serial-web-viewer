// Database maintenance from the command line.
//
//   node scripts/db.js backup  <file>            consistent copy (VACUUM INTO); safe while the server runs
//   node scripts/db.js verify  <file>            integrity, foreign keys and schema version of a file
//   node scripts/db.js restore <file> [--force]  replaces DB_PATH with a verified backup
//
// restore refuses to run while the server answers on PORT (it holds the database open),
// keeps the current database as <DB_PATH>.before-restore-<time>.db, swaps the file in
// atomically, removes stale WAL / SHM files and migrates the restored copy to the
// current schema. --force skips only the "server is running" check.

const fs = require('fs');
const path = require('path');
const { openResultsDb, verifyDatabaseFile } = require('../db');

try {
  process.loadEnvFile();
} catch {
  // no .env
}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'serial-viewer.db');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function backup(target, { dbPath = DB_PATH } = {}) {
  if (fs.existsSync(target)) throw new Error(`${target} zaten var; üzerine yazılmaz`);
  const db = openResultsDb(dbPath);
  try {
    db.backupTo(target);
  } finally {
    db.close();
  }
  const check = verifyDatabaseFile(target);
  if (!check.ok) throw new Error(`Yedek doğrulanamadı: ${check.errors.join('; ')}`);
  return check;
}

async function serverRunning(port = Number(process.env.PORT) || 3000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * @returns {{previous: string|null, version: number, migratedFrom: number|null, tests: number}}
 */
function restore(source, { dbPath = DB_PATH } = {}) {
  const check = verifyDatabaseFile(source);
  if (!check.ok) throw new Error(`Yedek dosyası kullanılamaz: ${check.errors.join('; ')}`);

  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  let previous = null;
  if (fs.existsSync(dbPath)) {
    // Consistent copy of the current database (includes anything still in its WAL)
    previous = `${dbPath}.before-restore-${stamp()}.db`;
    const current = openResultsDb(dbPath);
    try {
      current.backupTo(previous);
    } finally {
      current.close();
    }
  }

  const temporary = `${dbPath}.restoring-${process.pid}`;
  fs.copyFileSync(source, temporary);
  const copied = verifyDatabaseFile(temporary);
  if (!copied.ok) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`Kopya doğrulanamadı: ${copied.errors.join('; ')}`);
  }
  // A WAL left from the old database must never be replayed onto the restored one
  for (const suffix of ['-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  fs.renameSync(temporary, dbPath);

  const db = openResultsDb(dbPath); // applies pending migrations if the backup is older
  try {
    return { previous, version: verifyDatabaseFile(dbPath).version, migratedFrom: db.migratedFrom ?? null, tests: db.list({ source: 'all' }, { limit: 1 }).total };
  } finally {
    db.close();
  }
}

async function main([command, file, ...flags]) {
  if (!command || !file) {
    console.error('Kullanım: node scripts/db.js backup|verify|restore <dosya> [--force]');
    return 2;
  }
  if (command === 'verify') {
    const check = verifyDatabaseFile(file);
    console.log(check.ok ? `Sağlam (şema sürümü ${check.version})` : `HATALI:\n- ${check.errors.join('\n- ')}`);
    return check.ok ? 0 : 1;
  }
  if (command === 'backup') {
    const check = backup(file);
    console.log(`Yedek alındı ve doğrulandı: ${file} (şema sürümü ${check.version})`);
    return 0;
  }
  if (command === 'restore') {
    if (!flags.includes('--force') && (await serverRunning())) {
      console.error('Sunucu çalışıyor. Önce durdurun (docker compose stop / Ctrl+C), sonra tekrar deneyin.');
      return 1;
    }
    const result = restore(file);
    console.log(`Geri yüklendi: ${DB_PATH}`);
    console.log(`  ${result.tests} test kaydı, şema sürümü ${result.version}${result.migratedFrom ? ` (${result.migratedFrom} sürümünden taşındı)` : ''}`);
    if (result.previous) console.log(`  Önceki veritabanı saklandı: ${result.previous}`);
    return 0;
  }
  console.error(`Bilinmeyen komut: ${command}`);
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    }
  );
}

module.exports = { backup, restore };
