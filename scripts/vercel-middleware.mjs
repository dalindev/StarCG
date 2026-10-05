// Password gate for the static site, run by Vercel Routing Middleware in front of EVERY request.
// The deploy script (scripts/deploy-vercel.sh) copies this file to the project root as middleware.js.
//
//  - Password: the SITE_PASSWORD environment variable of the Vercel project (same value as the Market Tracker app).
//    If it is missing the site FAILS CLOSED (503), it never silently opens up.
//  - Login is a POST form (the password never appears in a URL, history entry or log line).
//  - The session cookie is NOT a constant: it is "<expiry>.<HMAC-SHA256(SITE_PASSWORD, expiry)>", so it cannot be
//    forged without knowing the password, it expires (30 days), and changing SITE_PASSWORD logs everyone out.
//  - Password and signature comparisons are constant-time; a wrong password costs ~0.8 s.
//  - Nothing here is cached: every gate response is cache-control: no-store.

const COOKIE = 'starcg_auth';
const MAX_AGE_S = 60 * 60 * 24 * 30;
const TOKEN_CONTEXT = 'starcg-site-auth.v1.';
const LOGIN_CONTEXT = 'starcg-site-login.v1.';
const FAIL_DELAY_MS = 800;
const enc = new TextEncoder();

export const config = { matcher: '/:path*' };

function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** constant-time comparison of two equal-length strings; different lengths are simply unequal */
function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function makeToken(secret, expiresAtSec) {
  return expiresAtSec + '.' + b64url(await hmac(secret, TOKEN_CONTEXT + expiresAtSec));
}

export async function verifyToken(secret, token, nowSec) {
  if (typeof token !== 'string' || token.length > 200) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  if (!/^\d{9,12}$/.test(exp) || Number(exp) <= nowSec) return false;
  const expected = b64url(await hmac(secret, TOKEN_CONTEXT + exp));
  return sameString(token.slice(dot + 1), expected);
}

async function passwordMatches(secret, candidate) {
  // compare fixed-length digests, so the comparison time does not depend on how much of the password is right
  const a = b64url(await hmac(secret, LOGIN_CONTEXT + candidate));
  const b = b64url(await hmac(secret, LOGIN_CONTEXT + secret));
  return sameString(a, b);
}

/** only same-site absolute paths; anything else becomes '/' (no open redirect) */
export function safeNext(raw) {
  if (typeof raw !== 'string' || raw.length > 500) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return '/';
  if (raw.startsWith('/__')) return '/';
  return raw;
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loginPage(next, failed, status) {
  const html = `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>登入 - StarCG 工具</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Noto Sans TC', system-ui, -apple-system, 'PingFang TC', sans-serif; background: #f5f0e8; color: #4a3f35; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .card { background: #fffbf5; border: 1px solid #e0d5c5; border-radius: 12px; padding: 28px 24px; width: 100%; max-width: 380px; box-shadow: 0 4px 16px rgba(74,63,53,.12); }
  h1 { font-size: 1.35rem; margin-bottom: 4px; color: #8a5a00; }
  p { color: #6f5b43; font-size: .95rem; margin-bottom: 18px; }
  label { display: block; font-size: .9rem; margin-bottom: 6px; }
  input { width: 100%; font-size: 1rem; padding: 12px; border: 1px solid #d4c8b8; border-radius: 8px; background: #fff; color: #4a3f35; }
  input:focus-visible { outline: 3px solid #d4a024; outline-offset: 1px; }
  button { margin-top: 14px; width: 100%; min-height: 46px; font-size: 1rem; font-weight: 600; color: #fff; border: 0; border-radius: 8px; cursor: pointer; background: linear-gradient(135deg, #8b6b4a, #735338); }
  button:focus-visible { outline: 3px solid #d4a024; outline-offset: 2px; }
  .err { color: #a23a3a; font-weight: 600; font-size: .92rem; margin-top: 10px; }
</style>
</head>
<body>
<main class="card">
  <h1>StarCG 工具</h1>
  <p>請輸入密碼繼續。</p>
  <form method="POST" action="/__login">
    <input type="hidden" name="next" value="${esc(next)}">
    <label for="pw">密碼</label>
    <input id="pw" type="password" name="password" autocomplete="current-password" required autofocus${failed ? ' aria-invalid="true" aria-describedby="err"' : ''}>
    ${failed ? '<div class="err" id="err" role="alert">密碼不正確，請再試一次。</div>' : ''}
    <button type="submit">進入</button>
  </form>
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}

function setAuthCookie(token, maxAge) {
  return COOKIE + '=' + token + '; Path=/; Max-Age=' + maxAge + '; HttpOnly; Secure; SameSite=Lax';
}

function redirect(location, cookie) {
  const headers = { location, 'cache-control': 'no-store' };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(null, { status: 303, headers });
}

const pass = () => new Response(null, { headers: { 'x-middleware-next': '1' } });

export default async function middleware(request, nowMs) {
  const secret = typeof process !== 'undefined' && process.env ? process.env.SITE_PASSWORD : undefined;
  if (!secret) {
    return new Response('Site password is not configured.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const nowSec = Math.floor(now / 1000);
  const url = new URL(request.url);

  if (url.pathname === '/__logout') return redirect('/', setAuthCookie('', 0));

  if (url.pathname === '/__login' && request.method === 'POST') {
    let password = '';
    let next = '/';
    try {
      const form = await request.formData();
      password = String(form.get('password') || '').slice(0, 200);
      next = safeNext(form.get('next'));
    } catch (e) { /* malformed body: treated as a wrong password */ }
    if (await passwordMatches(secret, password)) {
      return redirect(next, setAuthCookie(await makeToken(secret, nowSec + MAX_AGE_S), MAX_AGE_S));
    }
    await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
    return loginPage(next, true, 401);
  }

  if (await verifyToken(secret, readCookie(request.headers.get('cookie'), COOKIE), nowSec)) return pass();

  const wantsPage = request.method === 'GET' || request.method === 'HEAD';
  return loginPage(wantsPage ? safeNext(url.pathname + url.search) : '/', false, 401);
}
