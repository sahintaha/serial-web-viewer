// Users, sessions and roles for the Node server (REST and Socket.io).
//
// - Passwords: scrypt with a random salt, compared in constant time.
// - Sessions: random 32-byte token in an httpOnly, SameSite=Strict cookie; only its
//   SHA-256 is stored, so a leaked database does not leak live sessions.
// - First start: no default password. While no user exists, a one-time setup code is
//   printed to the server console and the first administrator is created with it.
// - State-changing requests must come from the same origin (CSRF defence on top of SameSite).

const crypto = require('crypto');

const ROLES = ['operator', 'engineer', 'admin'];
const RANK = { operator: 1, engineer: 2, admin: 3 };
const COOKIE = 'sv_session';
const SESSION_HOURS = 12;
const MIN_PASSWORD = 10;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 5;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(actual, expected);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function validateNewUser({ username, displayName, role, password }) {
  const errors = [];
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(String(username ?? ''))) errors.push('Kullanıcı adı 3–32 karakter olmalı (harf, rakam, . _ -)');
  if (!String(displayName ?? '').trim() || String(displayName).length > 64) errors.push('Görünen ad 1–64 karakter olmalı');
  if (!ROLES.includes(role)) errors.push(`Rol ${ROLES.join(', ')} olmalı`);
  errors.push(...passwordErrors(password));
  return errors;
}

function passwordErrors(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return [`Parola en az ${MIN_PASSWORD} karakter olmalı`];
  if (password.length > 200) return ['Parola çok uzun'];
  return [];
}

/**
 * @param {object} options
 * @param {object} options.db openResultsDb() instance
 * @param {object} [options.log]
 */
function createAuth({ db, log = console }) {
  let setupToken = null;
  const loginAttempts = new Map(); // key → [timestamps]

  function ensureSetupToken() {
    if (db.countUsers() > 0) {
      setupToken = null;
      return null;
    }
    if (!setupToken) {
      setupToken = crypto.randomBytes(9).toString('base64url');
      log.warn?.(`\nİlk kurulum: henüz kullanıcı yok. Yönetici hesabı oluşturmak için kurulum kodu: ${setupToken}\n`);
    }
    return setupToken;
  }
  ensureSetupToken();

  function issueSession(res, user, req) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_HOURS * 3600_000);
    db.createSession(sha256(token), user.id, expires.toISOString());
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Expires=${expires.toUTCString()}${secure ? '; Secure' : ''}`
    );
  }

  function userFromCookieHeader(header) {
    const token = parseCookies(header)[COOKIE];
    return token ? db.getSessionUser(sha256(token)) : null;
  }

  /** Attaches req.user (or null) to every request. */
  function attachUser(req, res, next) {
    req.user = userFromCookieHeader(req.headers.cookie);
    next();
  }

  /** Same-origin check for state-changing requests (defence in depth next to SameSite=Strict). */
  function sameOrigin(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) {
      return res.status(403).json({ errors: ['Farklı kaynaktan istek reddedildi'] });
    }
    next();
  }

  const requireRole = (role) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ errors: ['Oturum açmanız gerekiyor'] });
    if (RANK[req.user.role] < RANK[role]) return res.status(403).json({ errors: [`Bu işlem için ${role} yetkisi gerekiyor`] });
    next();
  };

  function rateLimited(key) {
    const nowMs = Date.now();
    const recent = (loginAttempts.get(key) ?? []).filter((t) => nowMs - t < LOGIN_WINDOW_MS);
    loginAttempts.set(key, recent);
    return recent.length >= LOGIN_MAX_ATTEMPTS;
  }

  function noteFailure(key) {
    loginAttempts.set(key, [...(loginAttempts.get(key) ?? []), Date.now()]);
  }

  /** REST endpoints under /api/auth and /api/users. */
  function routes(app) {
    app.get('/api/auth/state', (req, res) => {
      res.json({ setupRequired: db.countUsers() === 0, user: req.user });
    });

    app.post('/api/auth/setup', (req, res) => {
      const token = ensureSetupToken();
      if (!token) return res.status(409).json({ errors: ['Kurulum zaten yapılmış'] });
      const { setupToken: given, username, displayName, password } = req.body ?? {};
      if (typeof given !== 'string' || given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
        return res.status(403).json({ errors: ['Kurulum kodu hatalı (sunucu konsoluna bakın)'] });
      }
      const errors = validateNewUser({ username, displayName, role: 'admin', password });
      if (errors.length) return res.status(400).json({ errors });
      const user = db.createUser({ username, displayName: displayName.trim(), role: 'admin', passwordHash: hashPassword(password) });
      setupToken = null;
      issueSession(res, user, req);
      res.status(201).json({ user });
    });

    app.post('/api/auth/login', (req, res) => {
      const { username, password } = req.body ?? {};
      const key = `${req.ip}|${String(username).toLowerCase()}`;
      if (rateLimited(key)) return res.status(429).json({ errors: ['Çok fazla başarısız deneme; bir dakika sonra tekrar deneyin'] });
      const found = typeof username === 'string' ? db.findUserForLogin(username) : null;
      // Verify even for unknown users so response time does not reveal which usernames exist
      const ok = verifyPassword(String(password ?? ''), found?.passwordHash ?? hashPassword('x'.repeat(MIN_PASSWORD))) && found && !found.disabled;
      if (!ok) {
        noteFailure(key);
        return res.status(401).json({ errors: ['Kullanıcı adı veya parola hatalı'] });
      }
      const { passwordHash, ...user } = found;
      void passwordHash;
      issueSession(res, user, req);
      db.audit(user.id, 'login', 'user', user.id);
      res.json({ user });
    });

    app.post('/api/auth/logout', (req, res) => {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) db.deleteSession(sha256(token));
      res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      res.status(204).end();
    });

    app.post('/api/auth/password', requireRole('operator'), (req, res) => {
      const { currentPassword, newPassword } = req.body ?? {};
      const found = db.findUserForLogin(req.user.username);
      if (!verifyPassword(String(currentPassword ?? ''), found.passwordHash)) return res.status(403).json({ errors: ['Mevcut parola hatalı'] });
      const errors = passwordErrors(newPassword);
      if (errors.length) return res.status(400).json({ errors });
      db.updateUser(req.user.id, { passwordHash: hashPassword(newPassword) }, req.user.id);
      issueSession(res, req.user, req);
      res.status(204).end();
    });

    app.get('/api/users', requireRole('admin'), (req, res) => res.json(db.listUsers()));

    app.post('/api/users', requireRole('admin'), (req, res) => {
      const { username, displayName, role, password } = req.body ?? {};
      const errors = validateNewUser({ username, displayName, role, password });
      if (errors.length) return res.status(400).json({ errors });
      if (db.findUserForLogin(username)) return res.status(409).json({ errors: ['Bu kullanıcı adı zaten var'] });
      res.status(201).json(db.createUser({ username, displayName: displayName.trim(), role, passwordHash: hashPassword(password) }, req.user.id));
    });

    app.patch('/api/users/:id', requireRole('admin'), (req, res) => {
      const id = Number(req.params.id);
      const target = db.getUser(id);
      if (!target) return res.status(404).json({ errors: ['Kullanıcı bulunamadı'] });
      const { role, disabled, password, displayName } = req.body ?? {};
      const errors = [];
      if (role !== undefined && !ROLES.includes(role)) errors.push('Geçersiz rol');
      if (disabled !== undefined && typeof disabled !== 'boolean') errors.push('disabled true / false olmalı');
      if (password !== undefined) errors.push(...passwordErrors(password));
      if (displayName !== undefined && (!String(displayName).trim() || String(displayName).length > 64)) errors.push('Görünen ad 1–64 karakter olmalı');
      // Never lock the installation out: the last active administrator stays an administrator
      const demotes = target.role === 'admin' && !target.disabled && ((role && role !== 'admin') || disabled === true);
      if (demotes && db.countAdmins() <= 1) errors.push('Son etkin yönetici kaldırılamaz');
      if (errors.length) return res.status(400).json({ errors });
      res.json(db.updateUser(id, { role, disabled, displayName: displayName?.trim(), passwordHash: password === undefined ? undefined : hashPassword(password) }, req.user.id));
    });
  }

  /** Socket.io: every connection must carry a valid session cookie. */
  function socketMiddleware(socket, next) {
    const user = userFromCookieHeader(socket.handshake.headers.cookie);
    if (!user) return next(new Error('Oturum açmanız gerekiyor'));
    socket.data.user = user;
    next();
  }

  /** The socket's user now: the session is checked on every call, so logout, expiry and disabling apply at once. */
  function socketUser(socket) {
    socket.data.user = userFromCookieHeader(socket.handshake.headers.cookie);
    return socket.data.user;
  }

  const hasRole = (user, role) => Boolean(user) && RANK[user.role] >= RANK[role];

  return { attachUser, sameOrigin, requireRole, routes, socketMiddleware, socketUser, hasRole, getSetupToken: ensureSetupToken, hashPassword };
}

module.exports = { createAuth, hashPassword, verifyPassword, ROLES, MIN_PASSWORD };
