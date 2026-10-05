// Tests for starcg_afk_sync.js (code format, client protocol, conflict policy). Run: node --test test/afk-sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../starcg_afk_sync.js');

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
const CODE = 'ABCDEFGHIJKLMNOPQRSTUVWXY';

// ------------------------------------------------------------------ code format
test('S1 generateCode: 25 chars from A-Z2-7, uses (byte & 31) with no bias', () => {
  const fixed = (b) => { for (let i = 0; i < b.length; i++) b[i] = i; return b; };
  assert.equal(S.generateCode(fixed), 'ABCDEFGHIJKLMNOPQRSTUVWXY');
  const high = (b) => { for (let i = 0; i < b.length; i++) b[i] = 255; return b; };
  assert.equal(S.generateCode(high), '7'.repeat(25));
  const wrap = (b) => { for (let i = 0; i < b.length; i++) b[i] = 32 + i; return b; }; // 32 -> A again
  assert.equal(S.generateCode(wrap), 'ABCDEFGHIJKLMNOPQRSTUVWXY');
});

test('S2 generateCode with the real crypto: right shape, and 200 codes are all different', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = S.generateCode();
    assert.match(c, /^[A-Z2-7]{25}$/);
    seen.add(c);
  }
  assert.equal(seen.size, 200);
});

test('S3 generateCode without crypto throws a SyncError instead of weak randomness', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    assert.throws(() => S.generateCode(), (e) => e instanceof S.SyncError && e.kind === 'no-crypto');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'crypto', saved); else delete globalThis.crypto;
  }
});

test('S4 formatCode / normalizeCode round-trip, and normalizeCode is forgiving but strict about content', () => {
  assert.equal(S.formatCode(CODE), 'ABCDE-FGHIJ-KLMNO-PQRST-UVWXY');
  assert.equal(S.normalizeCode('ABCDE-FGHIJ-KLMNO-PQRST-UVWXY'), CODE);
  assert.equal(S.normalizeCode('  abcde fghij klmno pqrst uvwxy\n'), CODE);
  assert.equal(S.normalizeCode('abcde_fghij-klmno-pqrst-uvwxy'), CODE);
  for (const bad of ['', null, undefined, 'short', CODE + 'A', CODE.slice(1), 'ABCDE-FGHIJ-KLMNO-PQRST-UVWX1', 'ABCDE-FGHIJ-KLMNO-PQRST-UVWX0', 'ABCDE-FGHIJ-KLMNO-PQRST-UVWX!', 123, {}]) {
    assert.equal(S.normalizeCode(bad), null, String(bad));
  }
});

test('S5 maskCode hides all but the last 5 characters', () => {
  assert.equal(S.maskCode(CODE), '•••••-•••••-•••••-•••••-UVWXY');
  assert.equal(S.maskCode(''), '');
  assert.equal(S.maskCode('ab'), '');
  assert.ok(!S.maskCode(CODE).includes('ABCDE'));
});

// ------------------------------------------------------------------ client protocol
test('S6 pull: sends the code to afk_state_get with the project key, parses found and not-found', async () => {
  const calls = [];
  const c = S.createClient({ url: 'https://x.example/', key: 'KEY', fetchImpl: async (u, o) => { calls.push({ u, o }); return calls.length === 1 ? jsonRes(200, { found: false }) : jsonRes(200, { found: true, state: { a: 1 }, revision: 3, updatedAt: 'T' }); } });
  assert.deepEqual(await c.pull(CODE), { found: false });
  assert.deepEqual(await c.pull(CODE), { found: true, state: { a: 1 }, revision: 3, updatedAt: 'T' });
  assert.equal(calls[0].u, 'https://x.example/rest/v1/rpc/afk_state_get');
  assert.equal(calls[0].o.method, 'POST');
  assert.equal(calls[0].o.headers.apikey, 'KEY');
  assert.equal(calls[0].o.headers.Authorization, 'Bearer KEY');
  assert.deepEqual(JSON.parse(calls[0].o.body), { p_code: CODE });
});

test('S7 push: success, and conflict returns the newer cloud copy', async () => {
  const bodies = [];
  const answers = [jsonRes(200, { ok: true, revision: 1, updatedAt: 'T1' }), jsonRes(200, { ok: false, conflict: true, state: { s: 2 }, revision: 5, updatedAt: 'T5' })];
  const c = S.createClient({ url: 'https://x.example', key: 'K', fetchImpl: async (u, o) => { bodies.push(JSON.parse(o.body)); return answers.shift(); } });
  assert.deepEqual(await c.push(CODE, { s: 1 }, 0), { ok: true, revision: 1, updatedAt: 'T1' });
  assert.deepEqual(await c.push(CODE, { s: 1 }, 1), { ok: false, conflict: true, state: { s: 2 }, revision: 5, updatedAt: 'T5' });
  assert.deepEqual(bodies[0], { p_code: CODE, p_state: { s: 1 }, p_base_revision: 0 });
  assert.equal(bodies[1].p_base_revision, 1);
});

test('S8 remove: parses deleted true/false', async () => {
  const answers = [jsonRes(200, { deleted: true }), jsonRes(200, { deleted: false })];
  const c = S.createClient({ fetchImpl: async () => answers.shift() });
  assert.deepEqual(await c.remove(CODE), { deleted: true });
  assert.deepEqual(await c.remove(CODE), { deleted: false });
});

test('S9 server errors are classified by the message the SQL raises', async () => {
  const kinds = [
    [400, { message: 'invalid_code' }, 'invalid-code'],
    [400, { message: 'state_too_large' }, 'too-large'],
    [400, { message: 'invalid_state' }, 'invalid-state'],
    [400, { message: 'capacity_reached' }, 'capacity'],
    [401, { message: 'permission denied' }, 'auth'],
    [403, null, 'auth'],
    [404, { message: 'function not found' }, 'server'],
    [429, null, 'rate-limit'],
    [500, null, 'server'],
    [503, { message: 'x' }, 'server'],
  ];
  for (const [status, body, kind] of kinds) {
    const c = S.createClient({ fetchImpl: async () => jsonRes(status, body) });
    await assert.rejects(() => c.pull(CODE), (e) => e instanceof S.SyncError && e.kind === kind && e.status === status, status + ' ' + kind);
  }
});

test('S10 network failure -> kind network; hanging request -> kind timeout and the request is aborted', async () => {
  const down = S.createClient({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(() => down.pull(CODE), (e) => e.kind === 'network');
  const syncThrow = S.createClient({ fetchImpl: () => { throw new Error('boom'); } });
  await assert.rejects(() => syncThrow.pull(CODE), (e) => e.kind === 'network');
  let aborted = false;
  const hang = S.createClient({ timeoutMs: 20, fetchImpl: (u, o) => new Promise((_, rej) => { o.signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }); }) });
  await assert.rejects(() => hang.pull(CODE), (e) => e.kind === 'timeout');
  assert.ok(aborted);
});

test('S11 a 200 with nonsense is a bad-response, never a half-trusted object', async () => {
  const shapes = [null, {}, { found: true }, { found: true, state: 'x', revision: 1 }, { found: true, state: {}, revision: 'one' }, { found: 'yes', state: {}, revision: 1 }];
  for (const body of shapes) {
    const c = S.createClient({ fetchImpl: async () => jsonRes(200, body) });
    await assert.rejects(() => c.pull(CODE), (e) => e.kind === 'bad-response', JSON.stringify(body));
  }
  const pushShapes = [null, {}, { ok: true }, { ok: false }, { ok: false, conflict: true, state: [], revision: 1 }, { ok: true, revision: 'x' }];
  for (const body of pushShapes) {
    const c = S.createClient({ fetchImpl: async () => jsonRes(200, body) });
    await assert.rejects(() => c.push(CODE, {}, 0), (e) => e.kind === 'bad-response', JSON.stringify(body));
  }
  const c = S.createClient({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json' }) });
  await assert.rejects(() => c.remove(CODE), (e) => e.kind === 'bad-response');
});

test('S12 no fetch available -> network error, not a crash', async () => {
  const c = S.createClient({ fetchImpl: null });
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    const c2 = S.createClient({});
    await assert.rejects(() => c2.pull(CODE), (e) => e.kind === 'network');
  } finally { globalThis.fetch = saved; }
  assert.ok(c);
});

// ------------------------------------------------------------------ conflict policy
test('S13 planSync: the whole decision table', () => {
  const found = (revision) => ({ found: true, revision });
  assert.deepEqual(S.planSync({ found: false }, { revision: 0 }, true), { action: 'push', base: 0 });
  assert.deepEqual(S.planSync({ found: false }, { revision: 7 }, false), { action: 'push', base: 0 }); // deleted elsewhere: re-create from here
  assert.deepEqual(S.planSync(null, undefined, false), { action: 'push', base: 0 });
  assert.deepEqual(S.planSync(found(4), { revision: 4 }, false), { action: 'noop' });
  assert.deepEqual(S.planSync(found(4), { revision: 4 }, true), { action: 'push', base: 4 });
  assert.deepEqual(S.planSync(found(6), { revision: 4 }, false), { action: 'pull' });
  assert.deepEqual(S.planSync(found(6), { revision: 4 }, true), { action: 'conflict' });
  assert.deepEqual(S.planSync(found(3), { revision: 4 }, false), { action: 'conflict' }); // cloud went backwards
  assert.deepEqual(S.planSync(found(3), { revision: 4 }, true), { action: 'conflict' });
});

test('S14 planSync first link on a browser that never synced (revision 0)', () => {
  assert.deepEqual(S.planSync({ found: true, revision: 2 }, { revision: 0 }, false), { action: 'pull' }); // empty browser adopts the cloud
  assert.deepEqual(S.planSync({ found: true, revision: 2 }, { revision: 0 }, true), { action: 'conflict' }); // browser with data must ask
  assert.deepEqual(S.planSync({ found: true, revision: 2 }, null, true), { action: 'conflict' });
});

test('S15 planSync never overwrites silently: a push is only planned from the exact revision we last saw, or on an empty cloud', () => {
  for (const cr of [0, 1, 2, 3, 9]) for (const mr of [0, 1, 2, 3, 9]) for (const dirty of [true, false]) {
    const p = S.planSync({ found: true, revision: cr }, { revision: mr }, dirty);
    if (p.action === 'push') { assert.equal(cr, mr); assert.equal(p.base, cr); assert.equal(dirty, true); }
    if (p.action === 'pull') { assert.ok(cr > mr); assert.equal(dirty, false); }
  }
  assert.deepEqual(S.planSync({ found: true, revision: NaN }, { revision: 1 }, false), { action: 'conflict' });
});

test('S16 retryDelayMs: 15s, 30s, 60s ... capped at 5 minutes, tolerant of junk', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map(S.retryDelayMs), [15000, 30000, 60000, 120000, 240000, 300000, 300000]);
  assert.equal(S.retryDelayMs(0), 15000);
  assert.equal(S.retryDelayMs(NaN), 15000);
  assert.equal(S.retryDelayMs(-4), 15000);
});

test('S17 the module embeds a project URL and a publishable key, and no secret-looking service key', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../starcg_afk_sync.js', import.meta.url), 'utf8');
  assert.match(src, /SUPABASE_URL = 'https:\/\/[a-z0-9]+\.supabase\.co'/);
  assert.match(src, /SUPABASE_KEY = 'sb_publishable_/);
  assert.ok(!/sb_secret_|service_role/.test(src));
});
