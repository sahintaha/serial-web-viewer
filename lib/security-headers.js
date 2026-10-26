// HTTP security headers for every response.
//
// The Content-Security-Policy allows scripts, styles, fonts and connections only from this
// server. index.html has two inline scripts (the theme applied before first paint and the
// import map); they are allowed by their SHA-256 hash, so no 'unsafe-inline' is needed and an
// injected script would not run. The hashes are computed from the file actually served.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const SAFE_HOST = /^[A-Za-z0-9.\-:[\]]{1,255}$/;

function inlineScriptHashes(indexHtml) {
  return [...indexHtml.matchAll(INLINE_SCRIPT)].map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
}

function securityHeaders(publicDir) {
  const hashes = inlineScriptHashes(fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'));
  return (req, res, next) => {
    // Socket.io upgrades to a WebSocket on the same host; older browsers need it spelled out
    const host = SAFE_HOST.test(req.headers.host ?? '') ? req.headers.host : null;
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        `script-src 'self' ${hashes.join(' ')}`,
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        `connect-src 'self'${host ? ` ws://${host} wss://${host}` : ''}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; ')
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'serial=(self), camera=(), microphone=(), geolocation=()');
    next();
  };
}

module.exports = { securityHeaders, inlineScriptHashes };
