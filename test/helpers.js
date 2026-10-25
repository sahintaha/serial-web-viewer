// Shared helpers for server-side tests.

/**
 * Returns credentials for requests made as a user with the given role.
 * (Authentication is added in a later change; until then every request is allowed.)
 */
async function loginAs() {
  return { cookie: '' };
}

module.exports = { loginAs };
