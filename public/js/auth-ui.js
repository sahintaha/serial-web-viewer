// ============================================
// AUTH UI — first-time setup, login, user menu, password change and user
// management (administrators). Only used with the Node server; the static
// demo has no users (documented limitation).
// ============================================

import { $, el, openModal, promptText, formatDateTime } from './dom.js';

const ROLE_TEXT = { operator: 'Operatör', engineer: 'Mühendis', admin: 'Yönetici' };
const RANK = { operator: 1, engineer: 2, admin: 3 };

export const hasRole = (user, role) => Boolean(user) && RANK[user.role] >= RANK[role];

/** Shows role-dependent controls: .engineer-only and .admin-only elements. */
export function applyRoleVisibility(user, { requiresAuth }) {
  const engineer = !requiresAuth || hasRole(user, 'engineer');
  const admin = requiresAuth && hasRole(user, 'admin');
  document.querySelectorAll('.engineer-only').forEach((n) => n.classList.toggle('role-hidden', !engineer));
  document.querySelectorAll('.admin-only').forEach((n) => n.classList.toggle('role-hidden', !admin));
}

/**
 * Resolves with the logged-in user (server store) or null (local store, no users).
 * Keeps the login screen up until a session exists.
 */
export async function ensureSession(store) {
  if (!store.requiresAuth) return null;
  const state = await store.authState();
  if (state.user) return state.user;
  return showAuthScreen(store, state.setupRequired);
}

function showAuthScreen(store, setupRequired) {
  return new Promise((resolve) => {
    const screen = $('auth-screen');
    const form = $('auth-form');
    $('auth-title').textContent = setupRequired ? 'İlk kurulum: yönetici hesabı' : 'Oturum aç';
    $('auth-hint').textContent = setupRequired
      ? 'Henüz kullanıcı yok. Sunucu başlarken konsola yazdığı kurulum kodunu girin ve yönetici hesabını oluşturun. Varsayılan parola yoktur.'
      : 'Test kayıtları, oturum açan kullanıcının adıyla saklanır.';
    $('auth-token-field').classList.toggle('hidden', !setupRequired);
    $('auth-name-field').classList.toggle('hidden', !setupRequired);
    $('auth-password').autocomplete = setupRequired ? 'new-password' : 'current-password';
    $('auth-submit').textContent = setupRequired ? 'Yönetici hesabını oluştur' : 'Giriş yap';
    screen.classList.remove('hidden');
    (setupRequired ? $('auth-token') : $('auth-username')).focus();

    const onSubmit = async (e) => {
      e.preventDefault();
      $('auth-error').textContent = '';
      $('auth-submit').disabled = true;
      try {
        const res = setupRequired
          ? await store.setup({ setupToken: $('auth-token').value.trim(), username: $('auth-username').value.trim(), displayName: $('auth-display').value.trim(), password: $('auth-password').value })
          : await store.login($('auth-username').value.trim(), $('auth-password').value);
        form.removeEventListener('submit', onSubmit);
        $('auth-password').value = '';
        screen.classList.add('hidden');
        resolve(res.user);
      } catch (err) {
        $('auth-error').textContent = err.message;
      } finally {
        $('auth-submit').disabled = false;
      }
    };
    form.addEventListener('submit', onSubmit);
  });
}

/** Header user menu: name / role, password change, user management, backup, logout. */
export function initUserMenu({ store, user, showToast }) {
  if (!user) return;
  const menu = $('user-menu');
  const button = $('user-button');
  const dropdown = $('user-dropdown');
  menu.classList.remove('hidden');
  button.textContent = `${user.displayName} · ${ROLE_TEXT[user.role]}`;
  const toggle = (open) => {
    dropdown.classList.toggle('hidden', !open);
    button.setAttribute('aria-expanded', String(open));
    if (open) dropdown.querySelector('.menu-item:not(.role-hidden)')?.focus();
  };
  button.addEventListener('click', () => toggle(dropdown.classList.contains('hidden')));
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) toggle(false);
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      toggle(false);
      button.focus();
    }
  });

  dropdown.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    toggle(false);
    if (action === 'logout') {
      await store.logout().catch(() => {});
      location.reload();
    } else if (action === 'change-password') {
      const current = await promptText('Mevcut parolanız', { title: 'Parola değiştir', minLength: 1, confirm: 'İleri' });
      if (!current) return;
      const next = await promptText('Yeni parola (en az 10 karakter)', { title: 'Parola değiştir', minLength: 10, confirm: 'Değiştir' });
      if (!next) return;
      try {
        await store.changePassword(current, next);
        showToast('Parola değiştirildi', 'success');
      } catch (err) {
        showToast(err.message);
      }
    } else if (action === 'manage-users') {
      openUsers(store, user, showToast);
    } else if (action === 'backup') {
      store.backup();
    }
  });
}

async function openUsers(store, me, showToast) {
  const modal = $('users-modal');
  const close = openModal(modal);
  $('users-close').onclick = close;

  async function render() {
    let users;
    try {
      users = await store.listUsers();
    } catch (err) {
      $('users-error').textContent = err.message;
      return;
    }
    $('users-body').replaceChildren(
      ...users.map((u) => {
        const role = el('select', { className: 'select input-sm', ariaLabel: `${u.username} rolü` }, ...Object.entries(ROLE_TEXT).map(([v, t]) => new Option(t, v, false, v === u.role)));
        role.addEventListener('change', async () => {
          try {
            await store.updateUser(u.id, { role: role.value });
            showToast(`${u.username}: rol ${ROLE_TEXT[role.value]}`, 'success');
          } catch (err) {
            showToast(err.message);
            role.value = u.role;
          }
        });
        const toggleDisabled = el('button', { type: 'button', className: 'btn btn-sm', textContent: u.disabled ? 'Etkinleştir' : 'Devre dışı bırak' });
        toggleDisabled.addEventListener('click', async () => {
          try {
            await store.updateUser(u.id, { disabled: !u.disabled });
            render();
          } catch (err) {
            showToast(err.message);
          }
        });
        const reset = el('button', { type: 'button', className: 'btn btn-sm', textContent: 'Parola sıfırla' });
        reset.addEventListener('click', async () => {
          const password = await promptText(`${u.username} için yeni parola (en az 10 karakter)`, { title: 'Parola sıfırla', minLength: 10 });
          if (!password) return;
          try {
            await store.updateUser(u.id, { password });
            showToast('Parola sıfırlandı; kullanıcının oturumları kapatıldı', 'success');
          } catch (err) {
            showToast(err.message);
          }
        });
        return el(
          'tr',
          {},
          el('td', { className: 'mono', textContent: u.username }),
          el('td', { textContent: u.displayName }),
          el('td', {}, u.id === me.id ? ROLE_TEXT[u.role] : role),
          el('td', { textContent: u.disabled ? 'devre dışı' : `etkin · ${formatDateTime(u.createdAt)}` }),
          el('td', { className: 'row' }, u.id === me.id ? null : toggleDisabled, reset)
        );
      })
    );
  }

  $('users-form').onsubmit = async (e) => {
    e.preventDefault();
    $('users-error').textContent = '';
    try {
      await store.createUser({ username: $('nu-username').value.trim(), displayName: $('nu-display').value.trim(), role: $('nu-role').value, password: $('nu-password').value });
      e.target.reset();
      render();
    } catch (err) {
      $('users-error').textContent = err.message;
    }
  };
  render();
}
