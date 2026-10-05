// Tests for scripts/vercel-middleware.mjs (the password gate). Run: node --test test/vercel-middleware.test.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import middleware, { makeToken, verifyToken, safeNext } from '../scripts/vercel-middleware.mjs';

const PW = 'correct-horse';
const NOW = 1_800_000_000_000; // fixed clock (ms)
const NOW_S = NOW / 1000;
let saved;
beforeEach(() => { saved = process.env.SITE_PASSWORD; process.env.SITE_PASSWORD = PW; });
afterEach(() => { if (saved === undefined) delete process.env.SITE_PASSWORD; else process.env.SITE_PASSWORD = saved; });

const get = (path, cookie) => new Request('https://site.test' + path, { headers: cookie ? { cookie } : {} });
const post = (password, next) => {
  const body = new URLSearchParams();
  if (password !== undefined) body.set('password', password);
  if (next !== undefined) body.set('next', next);
  return new Request('https://site.test/__login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
};
const run = (req) => middleware(req, NOW);
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('G1 fails CLOSED when SITE_PASSWORD is missing or empty', async () => {
  delete process.env.SITE_PASSWORD;
  let res = await run(get('/afk'));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('x-middleware-next'), null);
  process.env.SITE_PASSWORD = '';
  res = await run(get('/afk'));
  assert.equal(res.status, 503);
});

test('G2 no cookie: 401 login page, never cached, not indexable, remembers where you were going', async () => {
  const res = await run(get('/StarCG_AfkTracker.html?x=1'));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('x-middleware-next'), null);
  const html = await res.text();
  assert.match(html, /method="POST" action="\/__login"/);
  assert.match(html, /name="next" value="\/StarCG_AfkTracker.html\?x=1"/);
  assert.match(html, /noindex/);
  assert.ok(!html.includes(PW));
});

test('G3 correct password: 303 to the page you wanted with an HttpOnly Secure SameSite session cookie', async () => {
  const res = await run(post(PW, '/afk'));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/afk');
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /^starcg_auth=\d{10}\.[A-Za-z0-9_-]+;/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Path=\//);
  assert.match(sc, /Max-Age=2592000/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('G4 the cookie from a correct login lets the next request through', async () => {
  const login = await run(post(PW, '/'));
  const res = await run(get('/afk', cookieOf(login)));
  assert.equal(res.headers.get('x-middleware-next'), '1');
  assert.equal(res.status, 200);
});

test('G5 wrong, empty and missing password all get 401 and the error message, no cookie', async () => {
  for (const p of ['nope', '', undefined, PW + ' ', ' ' + PW, PW.toUpperCase(), PW.slice(1)]) {
    const res = await run(post(p, '/afk'));
    assert.equal(res.status, 401, JSON.stringify(p));
    assert.equal(res.headers.get('set-cookie'), null);
    assert.match(await res.text(), /密碼不正確/);
  }
});

test('G6 the OLD app hole is closed: a hand-made constant cookie does not work', async () => {
  for (const c of ['starcg_auth=authenticated', 'site-auth=authenticated', 'starcg_auth=1', 'starcg_auth=', 'starcg_auth=.', 'starcg_auth=9999999999.AAAA']) {
    const res = await run(get('/afk', c));
    assert.equal(res.status, 401, c);
    assert.equal(res.headers.get('x-middleware-next'), null);
  }
});

test('G7 tokens: valid, expired, tampered, signed with another password, malformed', async () => {
  const good = await makeToken(PW, NOW_S + 100);
  assert.equal(await verifyToken(PW, good, NOW_S), true);
  assert.equal(await verifyToken(PW, await makeToken(PW, NOW_S - 1), NOW_S), false); // expired
  assert.equal(await verifyToken(PW, await makeToken(PW, NOW_S), NOW_S), false); // expires exactly now
  assert.equal(await verifyToken('other-password', good, NOW_S), false);
  const [exp, sig] = good.split('.');
  assert.equal(await verifyToken(PW, (Number(exp) + 1000) + '.' + sig, NOW_S), false); // extended expiry, old signature
  assert.equal(await verifyToken(PW, exp + '.' + sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A'), NOW_S), false);
  for (const bad of [null, undefined, '', '.', 'abc', exp, exp + '.', '.' + sig, 'x'.repeat(500), 123, {}]) assert.equal(await verifyToken(PW, bad, NOW_S), false, String(bad));
});

test('G8 an expired cookie sends you back to the login page', async () => {
  const stale = await makeToken(PW, NOW_S - 5);
  const res = await run(get('/afk', 'starcg_auth=' + stale));
  assert.equal(res.status, 401);
});

test('G9 changing the password logs every existing cookie out', async () => {
  const cookie = 'starcg_auth=' + (await makeToken(PW, NOW_S + 1000));
  assert.equal((await run(get('/afk', cookie))).headers.get('x-middleware-next'), '1');
  process.env.SITE_PASSWORD = 'a-new-password';
  assert.equal((await run(get('/afk', cookie))).status, 401);
});

test('G10 cookie is found among other cookies', async () => {
  const t = await makeToken(PW, NOW_S + 1000);
  const res = await run(get('/afk', `a=1; starcg_auth=${t}; b=2`));
  assert.equal(res.headers.get('x-middleware-next'), '1');
  const res2 = await run(get('/afk', `xstarcg_auth=${t}`)); // different cookie name must not match
  assert.equal(res2.status, 401);
});

test('G11 safeNext: only same-site paths, no open redirect', () => {
  assert.equal(safeNext('/afk'), '/afk');
  assert.equal(safeNext('/a/b.html?x=1&y=2#z'), '/a/b.html?x=1&y=2#z');
  for (const bad of ['//evil.com', 'https://evil.com', 'http://x', '/\\evil.com', '\\\\evil', 'afk', '', null, undefined, 42, '/a\nb', '/__login', '/__logout', '/' + 'a'.repeat(600), 'javascript:alert(1)']) assert.equal(safeNext(bad), '/', String(bad));
});

test('G12 login honours safeNext: a hostile next goes to /', async () => {
  const res = await run(post(PW, 'https://evil.example/'));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});

test('G13 the next value is HTML-escaped in the login page (no injection), from a path and from a posted value', async () => {
  // a path is percent-encoded by the URL parser; raw quotes can only arrive through the form field
  const hostile = '/x"><script>alert(1)</script>&y=\'z';
  const res = await run(post('wrong', hostile));
  const html = await res.text();
  assert.ok(!html.includes('<script>alert(1)'), 'raw script tag reached the page');
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;y=&#39;z'), 'value was not escaped as expected');
  const viaPath = await (await run(get('/x?q=<b>&r=1'))).text();
  assert.ok(!viaPath.includes('<b>'));
  assert.ok(viaPath.includes('&amp;r=1'));
});

test('G14 logout clears the cookie and goes home', async () => {
  const res = await run(get('/__logout'));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  assert.match(res.headers.get('set-cookie'), /^starcg_auth=; .*Max-Age=0/);
});

test('G15 GET /__login and a POST elsewhere are not logins', async () => {
  assert.equal((await run(get('/__login'))).status, 401);
  const other = new Request('https://site.test/afk', { method: 'POST', body: 'password=' + PW, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const res = await run(other);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('G16 a malformed login body is just a wrong password', async () => {
  const req = new Request('https://site.test/__login', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=zzz' }, body: 'garbage' });
  const res = await run(req);
  assert.equal(res.status, 401);
});

test('G17 very long and unicode passwords do not crash it', async () => {
  assert.equal((await run(post('x'.repeat(5000)))).status, 401);
  assert.equal((await run(post('密碼🔒'))).status, 401);
  process.env.SITE_PASSWORD = '密碼🔒-ok';
  assert.equal((await run(post('密碼🔒-ok'))).status, 303);
});

test('G18 a failed login takes about 0.8 s (cheap brake on guessing)', async () => {
  const t0 = Date.now();
  await run(post('nope'));
  const ms = Date.now() - t0;
  assert.ok(ms >= 700 && ms < 3000, 'took ' + ms + ' ms');
});

test('G19 the gate covers every path including assets and the data files', async () => {
  for (const p of ['/', '/afk', '/StarCG_AfkTracker.html', '/starcg_afk_logic.js', '/pets.json', '/equipment_images/x.png', '/index.html']) {
    const res = await run(get(p));
    assert.equal(res.status, 401, p);
    assert.equal(res.headers.get('x-middleware-next'), null, p);
  }
});

test('G20 the gate source holds no hard-coded password and the matcher is catch-all', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../scripts/vercel-middleware.mjs', import.meta.url), 'utf8');
  assert.match(src, /matcher: '\/:path\*'/);
  assert.ok(!/SITE_PASSWORD\s*=\s*['"]/.test(src));
});
