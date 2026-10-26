// Shared helpers for server-side tests.

const PASSWORD = 'correct-horse-battery';
const admins = new WeakMap();

async function request(baseUrl, method, url, { body, cookie } = {}) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? null };
}

/** Creates the first administrator through the real setup flow (once per server). */
async function adminCookie(baseUrl, ctx) {
  if (admins.has(ctx)) return admins.get(ctx);
  const setup = await request(baseUrl, 'POST', '/api/auth/setup', {
    body: { setupToken: ctx.auth.getSetupToken(), username: 'admin', displayName: 'Yönetici', password: PASSWORD },
  });
  if (setup.status !== 201) throw new Error(`setup failed: ${JSON.stringify(setup.body)}`);
  admins.set(ctx, setup.cookie);
  return setup.cookie;
}

/**
 * Logs in as a user with the given role (created on first use).
 * @param {string} baseUrl
 * @param {object} ctx the object returned by createServer()
 * @param {'operator'|'engineer'|'admin'} role
 * @returns {Promise<{cookie: string, username: string}>}
 */
async function loginAs(baseUrl, ctx, role, username = role) {
  const admin = await adminCookie(baseUrl, ctx);
  if (role === 'admin' && username === 'admin') return { cookie: admin, username };
  await request(baseUrl, 'POST', '/api/users', { cookie: admin, body: { username, displayName: `${username} kullanıcı`, role, password: PASSWORD } });
  const login = await request(baseUrl, 'POST', '/api/auth/login', { body: { username, password: PASSWORD } });
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.body)}`);
  return { cookie: login.cookie, username };
}

module.exports = { loginAs, request, PASSWORD };
