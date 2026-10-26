// ============================================
// PRODUCTION TEST — wires the station, history, reports and product pages to one
// store and one outbox, and owns the sub-page navigation.
// ============================================

import { LocalDb } from './local-db.js';
import { Outbox } from './outbox.js';
import { initStation } from './station.js';
import { initHistory } from './history-ui.js';
import { initReports } from './reports-ui.js';
import { initProducts } from './products-ui.js';
import { hasRole } from './auth-ui.js';
import { $, ask, promptText } from './dom.js';

const PAGES = ['station', 'history', 'reports', 'products'];

/** In-memory stand-in when IndexedDB is unavailable (private window): pending results do not survive a reload. */
class MemoryDb {
  persistent = false;
  rows = new Map();
  async put(store, value) {
    this.rows.set(value.runId, structuredClone(value));
  }
  async get(store, key) {
    return structuredClone(this.rows.get(key));
  }
  async getAll() {
    return [...this.rows.values()].map((v) => structuredClone(v));
  }
  async delete(store, key) {
    this.rows.delete(key);
  }
}

async function outboxDb(store) {
  if (store.kind === 'local') return store.db;
  try {
    const db = new LocalDb({ name: 'serial-viewer-outbox' });
    await db.open();
    return db;
  } catch {
    return new MemoryDb();
  }
}

/**
 * @param {object} options
 * @param {object} options.store ServerStore | LocalStore
 * @param {object|null} options.user
 * @param {object} options.app hooks from app.js
 */
export async function initProduction({ store, user, app }) {
  const engineer = () => !store.requiresAuth || hasRole(user, 'engineer');
  let page = 'station';
  let products = [];

  const db = await outboxDb(store);
  const outbox = new Outbox({
    db,
    send: (submission) => store.saveRun(submission),
    onChange(event) {
      station.onOutboxEvent(event);
      history.renderOutbox();
      if (event.type === 'saved' && page === 'history') {
        history.refresh();
        history.renderStorage();
      }
    },
  });
  if (db instanceof MemoryDb) {
    app.showBanner('Tarayıcı deposu kullanılamıyor (gizli pencere?). Sunucuya gönderilemeyen sonuçlar sayfa kapanınca kaybolur.');
    window.addEventListener('beforeunload', (e) => {
      if (db.rows.size) e.preventDefault();
    });
  }

  async function reopenUnit(serial, source) {
    const reason = await promptText(`${serial} onarıldı mı? Yeniden açınca FAIL sayacı sıfırlanır; eski kayıtlar korunur. Onarım / gerekçe:`, { title: 'Onarım sonrası yeniden aç', minLength: 5, confirm: 'Yeniden aç' });
    if (!reason) return false;
    try {
      await store.reopenUnit(serial, reason, source ?? (app.getTransportKind() === 'demo' ? 'simulation' : 'hardware'));
      app.showToast(`${serial} yeniden açıldı`, 'success');
      station.lookupUnit();
      return true;
    } catch (err) {
      app.showToast(err.message);
      return false;
    }
  }

  async function loadProducts(selectCode = app.storage.get('productionProduct', null)) {
    products = await store.listProducts();
    const code = products.some((p) => p.code === selectCode) ? selectCode : products[0]?.code;
    $('pt-product').replaceChildren(...products.map((p) => new Option(`${p.code} — ${p.name} (rev ${p.revision})`, p.code, false, p.code === code)));
    history.setProducts(products);
    reports.setProducts(products);
    if (!code) return station.setProduct(null);
    if (station.busy) return; // the running test keeps its frozen revision; the new one applies next time
    app.storage.set('productionProduct', code);
    station.setProduct(products.find((p) => p.code === code));
  }

  const station = initStation({ store, outbox, app, user, onStored: () => page === 'history' && history.refresh(), reloadProducts: () => loadProducts($('pt-product').value), reopenUnit: (serial) => reopenUnit(serial) });
  const history = initHistory({ store, outbox, app, canReopen: engineer, retest: retestFromHistory, reopenUnit });
  const reports = initReports({ store, app });
  const productsPage = initProducts({ store, app, canEdit: engineer, productsChanged: (code) => loadProducts(code ?? $('pt-product').value) });

  async function retestFromHistory(serial, productCode) {
    await showPage('station');
    if (productCode && productCode !== $('pt-product').value && products.some((p) => p.code === productCode)) {
      $('pt-product').value = productCode;
      app.storage.set('productionProduct', productCode);
      station.setProduct(products.find((p) => p.code === productCode));
    }
    station.prefill(serial);
  }

  async function showPage(next) {
    if (!PAGES.includes(next)) next = 'station';
    if (page === 'products' && next !== 'products' && productsPage.hasUnsavedEdits()) {
      if (!(await ask('Ürün editöründe kaydedilmemiş değişiklik var. Sayfadan çıkılsın mı?', { title: 'Kaydedilmemiş değişiklik', yes: 'Çık', no: 'Kal', keys: false }))) return;
    }
    page = next;
    for (const name of PAGES) $(`pt-page-${name}`).classList.toggle('hidden', name !== page);
    document.querySelectorAll('#pt-subtabs .subtab').forEach((t) => {
      t.classList.toggle('active', t.dataset.page === page);
      t.setAttribute('aria-current', t.dataset.page === page ? 'page' : 'false');
    });
    app.storage.set('productionPage', page);
    if (page === 'history') {
      history.refresh();
      history.renderStorage();
    }
    if (page === 'reports') reports.refresh();
    if (page === 'products') productsPage.show();
    if (page === 'station') {
      station.render();
      $('pt-serial').focus();
    }
  }
  app.showPage = showPage;

  $('pt-subtabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.subtab');
    if (tab) showPage(tab.dataset.page);
  });
  $('pt-product').addEventListener('change', (e) => {
    const product = products.find((p) => p.code === e.target.value);
    if (!product || station.busy) return;
    app.storage.set('productionProduct', product.code);
    station.setProduct(product);
  });

  $('pt-storage').textContent = store.kind === 'sqlite' ? 'SQLite (sunucu)' : 'bu tarayıcı';
  $('pt-storage').title =
    store.kind === 'sqlite'
      ? 'Sonuçlar, ürünler ve kullanıcılar sunucudaki SQLite veritabanında'
      : 'Sunucu yok (ör. GitHub Pages): veriler yalnızca bu tarayıcıda (IndexedDB). Tekrar test kuralı yalnızca bu tarayıcı için geçerlidir; merkezi garanti için npm start ile sunucuyu kullanın.';

  // Another tab of the local store changed something: keep lists current
  store.onChange?.((event) => {
    if (event.stores?.includes('kv')) loadProducts($('pt-product').value).catch(() => {});
    if (page === 'history') history.refresh();
    history.renderOutbox();
  });

  // Server: calibration and station identity recorded with every result
  if (store.kind === 'sqlite') {
    store
      .station()
      .then((s) => {
        if (s.calibrationExpired) app.showBanner(`İstasyon kalibrasyonunun süresi doldu (${s.calibration.due}). Gerçek kart testleri sunucu tarafından reddedilir.`);
      })
      .catch(() => {});
  }

  await loadProducts().catch((err) => app.showToast(`Ürünler yüklenemedi: ${err.message}`));
  history.renderOutbox();
  outbox.start(); // also delivers results left over from before a reload
  await showPage(app.storage.get('productionPage', 'station'));

  return {
    onTheme: () => reports.onTheme(),
    get busy() {
      return station.busy;
    },
    showPage,
  };
}
