// Tests for starcg_afk_logic.js (window.StarCG_Afk). node:test + assert/strict, zero deps.
// Run: cd /Users/dalinhuang/Desktop/DevDalin/StarCG && node --test test/*.test.mjs
// One test per golden vector V1..V72 (names start with the vector number), plus extra
// hardening / purity / hygiene tests. Time is always passed in; nothing here reads the clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOGIC_PATH = path.join(HERE, '..', 'starcg_afk_logic.js');
const DATA_PATH = path.join(HERE, '..', 'starcg_gather_data.js');
const A = require('../starcg_afk_logic.js');

const H = 3600000, M = 60000, D = 86400000;
const T = Date.UTC(2026, 9, 2, 4, 0, 0);
const at = (ms) => T + Math.round(ms); // integer-ms offset from T

// ---------- helpers ----------
function close(actual, expected, eps = 1e-6, msg) {
  assert.ok(Math.abs(actual - expected) <= eps, (msg || 'close') + ': expected ' + expected + ' got ' + actual);
}
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
function assertFiniteDeep(v, where = '$') {
  if (typeof v === 'number') {
    assert.ok(Number.isFinite(v), where + ' is not finite: ' + v);
  } else if (typeof v === 'string') {
    assert.ok(!/NaN|Infinity|undefined/.test(v), where + ' string contains NaN/Infinity/undefined: ' + v);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => assertFiniteDeep(x, where + '[' + i + ']'));
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) assertFiniteDeep(v[k], where + '.' + k);
  }
}

const DEF = () => clone(A.defaultState(T).settings);
const mkChars = () => [1, 2, 3, 4, 5].map((i) => ({ id: 'c_' + i, name: '角色' + i, level: 1, freeSlots: null, gather: null, gatherRun: null }));
const COPPER = () => ({ category: 'mine', itemKey: 'mine/銅', spotKey: 'p:x', itemName: '銅', placeLabel: 'x', baseMinutes: 135, slots: 5, speed: 1, bufferMin: null, workHoursAtStart: null });
const mkF = (over) => {
  const f = {
    id: 'a_1', label: '主帳', onlineSessions: [],
    stone: { spotId: 'kude', freeSlots: 34, rateOverride: null, dailyCap: null, droppedToday: 0 },
    stoneRun: null, characters: mkChars(),
  };
  f.characters[0].gather = COPPER();
  return Object.assign(f, over || {});
};
const SPOT_KUDE = () => ({ id: 'kude', name: '庫德', defaultRate: 10, manualRate: null });
const mkCtx = (extra) => Object.assign({ settings: DEF(), spots: [SPOT_KUDE()], observations: [] }, extra || {});
const stoneOnly = () => { const a = mkF(); a.characters[0].gather = null; return a; };
// the spec fixtures use ids like a_1 / c_1 which are shorter than the id regex allows; persisted
// states must use valid ids, so round-trip tests rename them
const withValidIds = (acc) => Object.assign({}, acc, { id: 'a_acc001', characters: acc.characters.map((c, i) => Object.assign({}, c, { id: 'c_char0' + (i + 1) })) });

const P = (extra) => Object.assign({ startedAt: T, freeSlots: 34, stonesPerSlot: 3, ratePerHour: 10 }, extra || {});
const RUN = (extra) => Object.assign({ baseMinutes: 135, startedAt: T, slots: 5, speed: 1 }, extra || {});
const obs = (h, s, ageDays, extra) => Object.assign({ spotId: 'kude', at: T - (ageDays || 0) * D, hours: h, stones: s }, extra || {});

// =====================================================================
// API surface, constants, hygiene (B3, A4)
// =====================================================================
const API_NAMES = [
  'SCHEMA', 'STORAGE_KEY', 'BACKUP_KEY', 'CORRUPT_KEY', 'MS', 'LIMITS', 'num', 'clamp',
  'stoneCapacity', 'hoursToFull', 'resolveRate', 'stoneRunStatus', 'estimatedStonesAt',
  'goldValue', 'accountGold', 'netGoldPerHour', 'consumptionPerHour', 'mpStats', 'mpForRun', 'mpGoldPerHour',
  'gatherFillMs', 'gatherRunStatus', 'restartGather', 'restartCharGather', 'makeGatherRun', 'bestSpot', 'spotMinutes', 'lookupGather',
  'calibrate', 'spotRate',
  'effectiveNow', 'pauseRun', 'resumeRun', 'isOnline', 'goOnline', 'goOffline', 'makeStoneRun', 'startAccount', 'restartStone', 'clearRuns',
  'onlineStats', 'recordPick', 'quickPicks', 'urgencySort',
  'accountView', 'attentionItems', 'summarize',
  'nextNotification',
  'formatDuration', 'formatCountdown', 'formatEta', 'detectClockJump',
  'sanitizeText', 'escapeHtml', 'newId', 'defaultState', 'sanitizeState', 'migrate', 'loadState', 'validateImport', 'exportState',
  // v2: manual MP rate, account-level gather groups
  'mpPerHourFrom12h', 'mpPer12hFromHour', 'resolveMpManual', 'mpEstimate', 'mpForAccount', 'mpPerCharFromEntry', 'mpEntryFromPerChar', 'mpSourceLabel',
  'gatherGroupKey', 'gatherGroupsOf', 'groupGathers', 'groupFiredFlags', 'nextGroupNotification', 'markGroupFired',
  'setAccountGather', 'clearAccountGather', 'restartGatherGroup', 'restoreGatherRuns', 'pendingGatherGroups',
];

test('B3 every name in spec section 6 is exported', () => {
  for (const n of API_NAMES) assert.ok(n in A, 'missing export ' + n);
  for (const n of API_NAMES.slice(8)) assert.equal(typeof A[n], 'function', n + ' is not a function');
});

test('B3 constants', () => {
  assert.equal(A.SCHEMA, 1);
  assert.equal(A.STORAGE_KEY, 'starcg_afk_v1');
  assert.equal(A.BACKUP_KEY, 'starcg_afk_v1_bak');
  assert.equal(A.CORRUPT_KEY, 'starcg_afk_corrupt');
  assert.deepEqual(A.MS, { MIN: 60000, HOUR: 3600000, DAY: 86400000 });
  assert.deepEqual(A.LIMITS, { accounts: 12, characters: 5, spots: 30, sessions: 500, observations: 500, usageRecent: 30, usageKeys: 200, overrides: 200, importBytes: 2097152 });
  assert.equal(A.num(5, 1), 5);
  assert.equal(A.num(NaN, 1), 1);
  assert.equal(A.num('5', 1), 1);
  assert.equal(A.num(Infinity, 1), 1);
  assert.equal(A.clamp(5, 0, 3), 3);
  assert.equal(A.clamp(-5, 0, 3), 0);
});

test('A4 logic file hygiene: no clock reads, no network, no DOM', () => {
  const src = readFileSync(LOGIC_PATH, 'utf8');
  assert.ok(!/Date\.now\(\)/.test(src), 'Date.now() found');
  assert.ok(!/new Date\(\)/.test(src), 'new Date() found');
  assert.ok(!/\bfetch\(/.test(src), 'fetch( found');
  assert.ok(!/XMLHttpRequest/.test(src), 'XMLHttpRequest found');
  assert.ok(!/WebSocket/.test(src), 'WebSocket found');
  assert.ok(!/serviceWorker/.test(src), 'serviceWorker found');
  assert.ok(!/\bdocument\./.test(src), 'document. found');
  assert.ok(!/\blocalStorage\b/.test(src), 'localStorage found');
  assert.ok(!/\bsetTimeout\b|\bsetInterval\b/.test(src), 'timers found');
  assert.ok(src.includes("'use strict'"), 'missing use strict');
});

test('UMD: window.StarCG_Afk is defined when loaded as a browser script', () => {
  const src = readFileSync(LOGIC_PATH, 'utf8');
  const fakeWindow = {};
  // Evaluate as a classic script with a window global and no module object.
  const fn = new Function('window', 'self', 'globalThis', 'module', 'exports', src + '\n;return window.StarCG_Afk;');
  const lib = fn(fakeWindow, fakeWindow, fakeWindow, undefined, undefined);
  assert.ok(lib && typeof lib.accountView === 'function');
  assert.deepEqual(Object.keys(lib).sort(), Object.keys(A).sort());
});

// =====================================================================
// 9.1 Mandatory (the user's own numbers)
// =====================================================================
test('V1 stoneCapacity(34,3)=102; hoursToFull(102,10)=10.2h=36,720,000ms=10小時12分', () => {
  assert.equal(A.stoneCapacity(34, 3), 102);
  const h = A.hoursToFull(102, 10);
  assert.equal(h, 10.2);
  assert.equal(Math.round(h * H), 36720000);
  assert.equal(A.formatDuration(36720000), '10小時12分');
});

test('V2 goldValue(102,532)=54,264; five characters = 271,320', () => {
  assert.equal(A.goldValue(102, 532), 54264);
  assert.equal(A.accountGold([102, 102, 102, 102, 102], 532, 0).total, 271320);
});

test('V3 goldValue(100,532)=53,200; five characters = 266,000', () => {
  assert.equal(A.goldValue(100, 532), 53200);
  assert.equal(A.accountGold([100, 100, 100, 100, 100], 532, 0).total, 266000);
});

test('V4 gather 135 min: fullAt T+135M, collectBy T+125M, bufferMarker 0.92593', () => {
  const s = A.gatherRunStatus({ baseMinutes: 135, startedAt: T }, T);
  assert.equal(s.fullAt, T + 135 * M);
  assert.equal(s.collectBy, T + 125 * M);
  close(s.bufferMarker, 0.92593, 1e-5);
  assert.equal(s.state, 'running');
});

test('V5 gather 120 min: collectBy T+110M (1h50m)', () => {
  const s = A.gatherRunStatus({ baseMinutes: 120, startedAt: T }, T);
  assert.equal(s.collectBy, T + 110 * M);
  assert.equal(A.formatDuration(s.collectBy - T), '1小時50分');
});

test('V6 hoursToFull invalid inputs are null', () => {
  assert.equal(A.hoursToFull(102, 0), null);
  assert.equal(A.hoursToFull(102, -1), null);
  assert.equal(A.hoursToFull(102, NaN), null);
  assert.equal(A.hoursToFull(102, Infinity), null);
  assert.equal(A.hoursToFull(0, 10), null);
});

test('V7 stoneRunStatus rate 0 -> invalid/no-rate; freeSlots 0 -> invalid/no-slots', () => {
  const a = A.stoneRunStatus(P({ ratePerHour: 0 }), T);
  assert.equal(a.state, 'invalid');
  assert.equal(a.reason, 'no-rate');
  const b = A.stoneRunStatus(P({ freeSlots: 0 }), T);
  assert.equal(b.state, 'invalid');
  assert.equal(b.reason, 'no-slots');
});

// =====================================================================
// 9.2 Stones
// =====================================================================
test('V8 T+5.1H: running, progress .5, est 51, remaining 18,360,000, calm', () => {
  const s = A.stoneRunStatus(P(), at(5.1 * H));
  assert.equal(s.state, 'running');
  close(s.progress, 0.5, 1e-9);
  assert.equal(s.estStones, 51);
  assert.equal(s.remainingMs, 18360000);
  assert.equal(s.urgency, 'calm');
  assert.equal(s.stopReason, 'bag');
  assert.equal(s.capacity, 102);
  assert.equal(s.effectiveCapacity, 102);
  assert.equal(s.durationMs, 36720000);
  assert.equal(s.fullAt, T + 36720000);
  assert.equal(s.nowAt, T + 36720000 - 15 * M);
  assert.equal(s.overdueAt, s.fullAt);
  assert.equal(s.startsInFuture, false);
});

test('V9 T+9.5H soon (42 min, est 95); T+10H now (12 min, est 100)', () => {
  const a = A.stoneRunStatus(P(), at(9.5 * H));
  assert.equal(a.urgency, 'soon');
  assert.equal(a.remainingMs, 42 * M);
  assert.equal(a.estStones, 95);
  const b = A.stoneRunStatus(P(), at(10 * H));
  assert.equal(b.urgency, 'now');
  assert.equal(b.remainingMs, 12 * M);
  assert.equal(b.estStones, 100);
});

test('V10 T+10.2H and +1ms: full, overdue, remaining 0, est 102', () => {
  for (const now of [at(10.2 * H), at(10.2 * H) + 1]) {
    const s = A.stoneRunStatus(P(), now);
    assert.equal(s.state, 'full');
    assert.equal(s.urgency, 'overdue');
    assert.equal(s.remainingMs, 0);
    assert.equal(s.estStones, 102);
    assert.equal(s.progress, 1);
  }
});

test('V11 dailyCap 100: effective 100, daily-cap, duration 36,000,000', () => {
  const s = A.stoneRunStatus(P({ dailyCap: 100 }), T);
  assert.equal(s.effectiveCapacity, 100);
  assert.equal(s.stopReason, 'daily-cap');
  assert.equal(s.durationMs, 36000000);
  assert.equal(s.capacity, 102);
});

test('V12 dailyCap 100 + dropped 40 -> effective 60 (21,600,000); dropped 100 -> invalid/cap-reached', () => {
  const a = A.stoneRunStatus(P({ dailyCap: 100, droppedAtStart: 40 }), T);
  assert.equal(a.effectiveCapacity, 60);
  assert.equal(a.durationMs, 21600000);
  const b = A.stoneRunStatus(P({ dailyCap: 100, droppedAtStart: 100 }), T);
  assert.equal(b.state, 'invalid');
  assert.equal(b.reason, 'cap-reached');
});

test('V13 startedAt in the future: startsInFuture, elapsed 0, progress 0, fullAt from startedAt', () => {
  const s = A.stoneRunStatus(P({ startedAt: T + 30 * M }), T);
  assert.equal(s.startsInFuture, true);
  assert.equal(s.elapsedMs, 0);
  assert.equal(s.progress, 0);
  assert.equal(s.fullAt, T + 30 * M + 36720000);
  assert.equal(s.state, 'running');
});

test('V14 estimatedStonesAt(p,T+3.55H)=35; (p,T-1H)=0', () => {
  assert.equal(A.estimatedStonesAt(P(), at(3.55 * H)), 35);
  assert.equal(A.estimatedStonesAt(P(), T - H), 0);
  assert.equal(A.estimatedStonesAt(P({ ratePerHour: 0 }), T + H), 0);
});

test('V15 stoneCapacity edge cases', () => {
  assert.equal(A.stoneCapacity(-5, 3), 0);
  assert.equal(A.stoneCapacity(NaN, 3), 0);
  assert.equal(A.stoneCapacity(34, 0), 0);
  assert.equal(A.stoneCapacity(34.9, 3), 102);
  assert.equal(A.stoneCapacity(1e9, 3), 2997);
  assert.equal(A.stoneCapacity(34, 1e6), 34 * 99);
});

test('V16 hoursToFull(1e12,1e-6)=null; resolveRate precedence', () => {
  assert.equal(A.hoursToFull(1e12, 1e-6), null);
  assert.equal(A.resolveRate(12, 8, 9, 10), 12);
  assert.equal(A.resolveRate(null, 8, 9, 10), 8);
  assert.equal(A.resolveRate(null, null, 9, 10), 9);
  assert.equal(A.resolveRate(null, null, null, 10), 10);
  assert.equal(A.resolveRate(0, -1, NaN, 10), 10);
  assert.equal(A.resolveRate(0, -1, NaN, 0), 10);
  assert.equal(A.resolveRate(undefined, undefined, undefined, undefined), 10);
});

// =====================================================================
// 9.3 Gold
// =====================================================================
test('V17 goldValue with fee uses basis points (no float drift)', () => {
  assert.equal(A.goldValue(102, 532, 20), 43411);
  assert.equal(A.goldValue(100, 532, 30), 37240);
});

test('V18 goldValue NaN / negative / huge', () => {
  assert.equal(A.goldValue(NaN, 532), 0);
  assert.equal(A.goldValue(-5, 532), 0);
  assert.equal(A.goldValue(1e12, 532), 53200000);
});

test('V19 accountGold with unequal characters', () => {
  const r = A.accountGold([102, 90, 0, 60, 33], 532, 0);
  assert.deepEqual(r.perChar, [54264, 47880, 0, 31920, 17556]);
  assert.equal(r.total, 151620);
});

test('V20 netGoldPerHour', () => {
  assert.deepEqual(A.netGoldPerHour(10, 532, 0, 200), { gross: 5320, consumptionGold: 200, net: 5120, complete: true });
  const b = A.netGoldPerHour(10, 532, 20, 200);
  assert.equal(b.gross, 4256);
  assert.equal(b.net, 4056);
  const c = A.netGoldPerHour(10, 532, 0, null);
  assert.equal(c.net, 5320);
  assert.equal(c.complete, false);
});

// =====================================================================
// 9.4 Gather
// =====================================================================
test('V21 gather urgency before collect-by: T+95M calm, +112M soon, +124.99M soon', () => {
  assert.equal(A.gatherRunStatus(RUN(), at(95 * M)).urgency, 'calm');
  assert.equal(A.gatherRunStatus(RUN(), at(112 * M)).urgency, 'soon');
  assert.equal(A.gatherRunStatus(RUN(), at(124.99 * M)).urgency, 'soon');
  assert.equal(A.gatherRunStatus(RUN(), T).urgency, 'calm');
});

test('V22 gather: +125M now, +134.999M now, +135M overdue', () => {
  assert.equal(A.gatherRunStatus(RUN(), at(125 * M)).urgency, 'now');
  assert.equal(A.gatherRunStatus(RUN(), at(134.999 * M)).urgency, 'now');
  const o = A.gatherRunStatus(RUN(), at(135 * M));
  assert.equal(o.urgency, 'overdue');
  assert.equal(o.state, 'running');
});

test('V23 gather T+67.5M: progress .5, toFull 67.5 min, toCollect 57.5 min', () => {
  const s = A.gatherRunStatus(RUN(), at(67.5 * M));
  close(s.progress, 0.5, 1e-9);
  assert.equal(s.remainingToFullMs, 67.5 * M);
  assert.equal(s.remainingToCollectMs, 57.5 * M);
});

test('V24 gatherFillMs with 6 slots / speed', () => {
  assert.equal(A.gatherFillMs(135, { slots: 6 }), 162 * M);
  assert.equal(A.gatherFillMs(135, { slots: 6, speed: 1.2 }), 135 * M);
  assert.equal(A.gatherFillMs(135, {}), 135 * M);
  assert.equal(A.gatherFillMs(135), 135 * M);
  assert.equal(A.gatherFillMs(135, { slots: 7 }), 135 * M);
  assert.equal(A.gatherFillMs(120, { speed: 100 }), 40 * M); // clamped to 3x
  assert.equal(A.gatherFillMs(120, { speed: 0.01 }), 240 * M); // clamped to 0.5x
  assert.equal(A.gatherFillMs(120, { speed: NaN }), 120 * M);
  assert.equal(A.gatherFillMs(RUN({ slots: 6 })[('baseMinutes')], RUN({ slots: 6 })), 162 * M);
});

test('V25 baseMinutes null/0/-5/NaN -> invalid/no-minutes', () => {
  for (const bm of [null, 0, -5, NaN, undefined]) {
    const s = A.gatherRunStatus({ baseMinutes: bm, startedAt: T }, T);
    assert.equal(s.state, 'invalid');
    assert.equal(s.reason, 'no-minutes');
    assert.equal(s.fullAt, null);
    assert.equal(s.urgency, null);
    assert.equal(s.progress, null);
  }
  assert.equal(A.gatherFillMs(null), null);
  assert.equal(A.gatherFillMs(NaN), null);
});

test('V26 base 20 + bufferMin 30 -> collectBy T+10M, bufferClamped', () => {
  const s = A.gatherRunStatus(RUN({ baseMinutes: 20, bufferMin: 30 }), T);
  assert.equal(s.collectBy, T + 10 * M);
  assert.equal(s.bufferClamped, true);
  assert.equal(s.bufferMs, 10 * M);
});

test('V27 workHoursAtStart 1.5 -> stopReason workhours, fullAt T+90M, collectBy T+80M', () => {
  const s = A.gatherRunStatus(RUN({ workHoursAtStart: 1.5 }), T);
  assert.equal(s.stopReason, 'workhours');
  assert.equal(s.fullAt, T + 90 * M);
  assert.equal(s.collectBy, T + 80 * M);
  // work-hour limit longer than the bag fill is ignored
  const t = A.gatherRunStatus(RUN({ workHoursAtStart: 99 }), T);
  assert.equal(t.stopReason, 'bag');
  assert.equal(t.fullAt, T + 135 * M);
});

test('V28 restartGather sets startedAt+lastDepositAt, resets fired, input unchanged; NaN -> same ref', () => {
  const run = deepFreeze(RUN({ fired: { now: true, overdue: true } }));
  const r = A.restartGather(run, at(2 * H));
  assert.equal(r.startedAt, T + 2 * H);
  assert.equal(r.lastDepositAt, T + 2 * H);
  assert.deepEqual(r.fired, { now: false, overdue: false });
  assert.equal(r.pausedAt, null);
  assert.equal(run.startedAt, T);
  assert.equal(A.restartGather(run, NaN), run);
  assert.equal(A.restartGather(null, T), null);
});

test('V29 bestSpot', () => {
  assert.equal(A.bestSpot({ spots: [{ kind: 'shed', minutes: 134 }, { kind: 'spot', minutes: 135 }] }), 1);
  assert.equal(A.bestSpot({ spots: [{ kind: 'shed', minutes: 134 }] }), 0);
  assert.equal(A.bestSpot({ spots: [{ kind: 'shed', minutes: null }, { kind: 'unique', minutes: null }] }), null);
  assert.equal(A.bestSpot({ spots: [{ kind: 'shed', minutes: null }, { kind: 'spot', minutes: 200 }, { kind: 'spot', minutes: 180 }] }), 2);
  assert.equal(A.bestSpot({ spots: [] }), null);
  assert.equal(A.bestSpot(null), null);
  assert.equal(A.bestSpot({}), null);
});

// =====================================================================
// 9.5 Calibration, consumption
// =====================================================================
test('V30 calibration of 10h/80, 9h/81, 11h/99 -> 9.00, conf .75 高, band 8.39-9.61', () => {
  const c = A.calibrate([obs(10, 80), obs(9, 81), obs(11, 99)], { ratePerHour: 10, strengthHours: 10 }, T);
  close(c.ratePerHour, 9.0, 1e-9);
  assert.equal(c.sampleCount, 3);
  assert.equal(c.usedCount, 3);
  close(c.effectiveHours, 30, 1e-9);
  close(c.confidence, 0.75, 1e-9);
  assert.equal(c.label, '高');
  close(c.low, 8.39, 0.005);
  close(c.high, 9.61, 0.005);
  assert.equal(c.method, 'gamma-poisson-recency');
  close(A.hoursToFull(102, c.ratePerHour), 11.333, 0.001);
  // prior omitted -> same defaults
  const d = A.calibrate([obs(10, 80), obs(9, 81), obs(11, 99)], null, T);
  close(d.ratePerHour, 9.0, 1e-9);
});

test('V31 one 10h/80 run aged 30 days -> 9.333, confidence .333 低', () => {
  const c = A.calibrate([obs(10, 80, 30)], { ratePerHour: 10, strengthHours: 10 }, T);
  close(c.ratePerHour, 9.333, 0.001);
  close(c.confidence, 0.333, 0.001);
  assert.equal(c.label, '低');
});

test('V32 outlier: five 10h runs 80,85,90,92,400 -> 8.94, sampleCount 5, usedCount 4', () => {
  const list = [80, 85, 90, 92, 400].map((s) => obs(10, s));
  const c = A.calibrate(list, null, T);
  close(c.ratePerHour, 8.94, 0.005);
  assert.equal(c.sampleCount, 5);
  assert.equal(c.usedCount, 4);
  // with fewer than 5 used the outlier is kept
  const d = A.calibrate([80, 85, 90, 400].map((s) => obs(10, s)), null, T);
  assert.equal(d.usedCount, 4);
});

test('V33 empty -> rate 10 conf 0 prior; one 0.25h/50 -> sample 1, used 0, rate 10', () => {
  const c = A.calibrate([], null, T);
  assert.equal(c.ratePerHour, 10);
  assert.equal(c.confidence, 0);
  assert.equal(c.method, 'prior');
  assert.equal(c.usedCount, 0);
  const d = A.calibrate([obs(0.25, 50)], null, T);
  assert.equal(d.sampleCount, 1);
  assert.equal(d.usedCount, 0);
  assert.equal(d.ratePerHour, 10);
  assert.equal(d.method, 'prior');
  assert.equal(A.calibrate([], { ratePerHour: 7, strengthHours: 10 }, T).ratePerHour, 7);
});

test('V34 stones:NaN not counted; strengthHours 0 -> 8.667', () => {
  const c = A.calibrate([obs(10, 80), obs(5, NaN)], null, T);
  assert.equal(c.sampleCount, 1);
  const d = A.calibrate([obs(10, 80), obs(9, 81), obs(11, 99)], { ratePerHour: 10, strengthHours: 0 }, T);
  close(d.ratePerHour, 8.667, 0.001);
  // strengthHours 0 and nothing used: still the prior rate, never NaN
  const e = A.calibrate([], { ratePerHour: 10, strengthHours: 0 }, T);
  assert.equal(e.ratePerHour, 10);
  assert.equal(e.confidence, 0);
  assertFiniteDeep(e);
});

test('V35 consumptionPerHour: 10h/50 魔法 (gold 2000) + 5h/40 魔法 -> 6.0/h, gold 200/h', () => {
  const list = [
    { at: T, hours: 10, stones: 0, consumption: { amount: 50, unitLabel: '魔法', goldValue: 2000 } },
    { at: T, hours: 5, stones: 0, consumption: { amount: 40, unitLabel: '魔法', goldValue: null } },
  ];
  const r = A.consumptionPerHour(list, T);
  close(r.perHour, 6.0, 1e-9);
  assert.equal(r.goldPerHour, 200);
  assert.equal(r.unitLabel, '魔法');
  assert.equal(r.mixedUnits, false);
  assert.equal(r.sampleCount, 2);
});

test('V36 consumptionPerHour: newest record unit wins (HP), mixedUnits, goldPerHour null', () => {
  const list = [
    { at: T - D, hours: 10, stones: 0, consumption: { amount: 50, unitLabel: '魔法', goldValue: 2000 } },
    { at: T, hours: 5, stones: 0, consumption: { amount: 40, unitLabel: 'HP', goldValue: null } },
  ];
  const r = A.consumptionPerHour(list, T);
  close(r.perHour, 8, 1e-9);
  assert.equal(r.unitLabel, 'HP');
  assert.equal(r.mixedUnits, true);
  assert.equal(r.goldPerHour, null);
  const none = A.consumptionPerHour([], T);
  assert.deepEqual(none, { perHour: null, unitLabel: null, goldPerHour: null, sampleCount: 0, mixedUnits: false });
});

// =====================================================================
// 9.6 Online, usage, sorting
// =====================================================================
test('V37 overlapping sessions are unioned: total 5h, longest 5h', () => {
  const r = A.onlineStats([{ start: T - 10 * H, end: T - 7 * H }, { start: T - 8 * H, end: T - 5 * H }], T, 7);
  assert.equal(r.totalMs, 5 * H);
  assert.equal(r.longestMs, 5 * H);
  assert.equal(r.currentSessionMs, null);
  assert.equal(r.staleOpen, false);
});

test('V38 open session: current 2h; older than 48h -> staleOpen', () => {
  const a = A.onlineStats([{ start: T - 2 * H, end: null }], T, 7);
  assert.equal(a.currentSessionMs, 2 * H);
  assert.equal(a.totalMs, 2 * H);
  assert.equal(a.staleOpen, false);
  const b = A.onlineStats([{ start: T - 50 * H, end: null }], T, 7);
  assert.equal(b.staleOpen, true);
  assert.equal(b.currentSessionMs, 50 * H);
});

test('V39 sessions are clipped to the window; bad sessions ignored', () => {
  const a = A.onlineStats([{ start: T - 8 * D, end: T - 6.5 * D }], T, 7);
  assert.equal(a.totalMs, 12 * H);
  const b = A.onlineStats([{ start: T - 5 * H, end: T - 6 * H }], T, 7);
  assert.equal(b.totalMs, 0);
  const c = A.onlineStats([{ start: T + H, end: T + 2 * H }], T, 7);
  assert.equal(c.totalMs, 0);
});

test('V40 buckets: session [now-30H, now-6H] -> [18h, 6h, 0, ...]', () => {
  const r = A.onlineStats([{ start: T - 30 * H, end: T - 6 * H }], T, 7);
  assert.equal(r.buckets.length, 7);
  assert.equal(r.buckets[0], 18 * H);
  assert.equal(r.buckets[1], 6 * H);
  assert.equal(r.buckets[2], 0);
});

test('V41 quickPicks: recent a,b then frequent d,e', () => {
  const usage = { recent: [{ key: 'a', at: 4 }, { key: 'b', at: 3 }, { key: 'c', at: 2 }, { key: 'd', at: 1 }], freq: { a: 1, b: 5, c: 2, d: 9, e: 7 } };
  const r = A.quickPicks(usage, 4);
  assert.deepEqual(r.map((x) => x.key), ['a', 'b', 'd', 'e']);
  assert.deepEqual(r.map((x) => x.src), ['recent', 'recent', 'frequent', 'frequent']);
});

test('V42 quickPicks: topN 0 / empty -> []; recent z + freq tie x,y', () => {
  assert.deepEqual(A.quickPicks({ recent: [{ key: 'a', at: 1 }], freq: { a: 1 } }, 0), []);
  assert.deepEqual(A.quickPicks({}, 5), []);
  assert.deepEqual(A.quickPicks(undefined, 5), []);
  const r = A.quickPicks({ recent: [{ key: 'z', at: 9 }], freq: { x: 3, y: 3 } }, 3);
  assert.deepEqual(r.map((x) => x.key), ['z', 'x', 'y']);
  const p = A.quickPicks({ recent: [{ key: 'g:a', at: 2 }, { key: 's:b', at: 1 }], freq: { 'g:a': 3, 's:b': 3, 'g:c': 2 } }, 6, { prefix: 'g:' });
  assert.deepEqual(p.map((x) => x.key), ['g:a', 'g:c']);
});

test('V43 urgencySort: 2,4,3,5,6,1,7', () => {
  const items = [
    { id: 1, urgency: 'calm', remainingMs: 5 * H },
    { id: 2, urgency: 'overdue', remainingMs: -10 * M },
    { id: 3, urgency: 'now', remainingMs: 1 * M },
    { id: 4, urgency: 'overdue', remainingMs: -1 * M },
    { id: 5, urgency: 'soon', remainingMs: 10 * M },
    { id: 6, urgency: 'calm', remainingMs: 2 * H },
    { id: 7 },
  ];
  const frozen = deepFreeze(items.slice().map((x) => Object.assign({}, x)));
  const out = A.urgencySort(frozen);
  assert.deepEqual(out.map((x) => x.id), [2, 4, 3, 5, 6, 1, 7]);
  assert.deepEqual(frozen.map((x) => x.id), [1, 2, 3, 4, 5, 6, 7]);
  // stable for ties
  const tie = A.urgencySort([{ id: 'a', urgency: 'calm', remainingMs: 5 }, { id: 'b', urgency: 'calm', remainingMs: 5 }, { id: 'c' }, { id: 'd', urgency: null }]);
  assert.deepEqual(tie.map((x) => x.id), ['a', 'b', 'c', 'd']);
});

// =====================================================================
// 9.7 Format, clock
// =====================================================================
test('V44 formatDuration', () => {
  assert.equal(A.formatDuration(36720000), '10小時12分');
  assert.equal(A.formatDuration(59999), '不到1分');
  assert.equal(A.formatDuration(NaN), '—');
  assert.equal(A.formatDuration(-5400000), '-1小時30分');
  assert.equal(A.formatDuration(Infinity), '—');
  assert.equal(A.formatDuration(7200000), '2小時0分');
  assert.equal(A.formatDuration(45 * M), '45分');
  assert.equal(A.formatDuration(1e12), '999+小時');
  assert.equal(A.formatDuration(undefined), '—');
  assert.equal(A.formatDuration('5'), '—');
});

test('V45 formatDuration hms and compact', () => {
  assert.equal(A.formatDuration(36725000, { style: 'hms' }), '10:12:05');
  assert.equal(A.formatDuration(36720000, { style: 'compact' }), '10h12m');
  assert.equal(A.formatDuration(30000, { style: 'compact' }), '<1m');
  assert.equal(A.formatDuration(45 * M, { style: 'compact' }), '45m');
  assert.equal(A.formatDuration(7200000, { style: 'compact' }), '2h0m');
});

test('V46 formatEta America/Los_Angeles, DST ends', () => {
  const tz = 'America/Los_Angeles';
  const now = Date.UTC(2026, 10, 1, 6, 0, 0);
  assert.equal(A.formatEta(now, now, { tz }), '今天 23:00');
  assert.equal(A.formatEta(now + 10 * H, now, { tz }), '明天 08:00');
});

test('V47 formatEta America/Los_Angeles, DST starts', () => {
  const tz = 'America/Los_Angeles';
  const now = Date.UTC(2027, 2, 14, 6, 0, 0);
  assert.equal(A.formatEta(now, now, { tz }), '今天 22:00');
  assert.equal(A.formatEta(now + 10 * H, now, { tz }), '明天 09:00');
});

test('V48 formatEta Asia/Taipei midnight boundary, minutes floored', () => {
  const tz = 'Asia/Taipei';
  const now = Date.UTC(2026, 9, 2, 15, 59, 30); // 23:59:30 Taipei
  assert.equal(A.formatEta(now + 29999, now, { tz }), '今天 23:59');
  assert.equal(A.formatEta(now + 30000, now, { tz }), '明天 00:00');
});

test('V49 formatEta weekday names, M/D, yesterday, NaN', () => {
  const tz = 'Asia/Taipei';
  const now = Date.UTC(2026, 9, 2, 4, 0, 0); // Fri 12:00 Taipei
  assert.equal(A.formatEta(now + 2 * D, now, { tz }), '週日 12:00');
  assert.equal(A.formatEta(now + 3 * D, now, { tz }), '週一 12:00');
  assert.equal(A.formatEta(now + 6 * D, now, { tz }), '週四 12:00');
  assert.equal(A.formatEta(now + 7 * D, now, { tz }), '10/9 12:00');
  assert.equal(A.formatEta(now - 25 * H, now, { tz }), '昨天 11:00');
  assert.equal(A.formatEta(NaN, now, { tz }), '—');
  assert.equal(A.formatEta(now, NaN, { tz }), '—');
  // an unknown time zone never throws
  assert.equal(typeof A.formatEta(now, now, { tz: 'Not/AZone' }), 'string');
  assert.equal(typeof A.formatEta(now, now), 'string');
});

test('V50 detectClockJump', () => {
  assert.equal(A.detectClockJump(T + 5 * M, T), 'back');
  assert.equal(A.detectClockJump(T - 8 * H, T), null);
  assert.equal(A.detectClockJump(T + 60000, T), null);
  assert.equal(A.detectClockJump(NaN, T), null);
  assert.equal(A.detectClockJump(T + 5 * M, T, 10 * M), null);
});

test('V51 formatCountdown', () => {
  assert.equal(A.formatCountdown(36720000), '10時12分');
  assert.equal(A.formatCountdown(3600000), '1時00分');
  assert.equal(A.formatCountdown(3599999), '59:59');
  assert.equal(A.formatCountdown(2825000), '47:05');
  assert.equal(A.formatCountdown(0), '00:00');
  assert.equal(A.formatCountdown(-192000), '+03:12');
  assert.equal(A.formatCountdown(-3900000), '+1時05分');
  assert.equal(A.formatCountdown(NaN), '—');
  assert.equal(A.formatCountdown(Infinity), '—');
  assert.equal(A.formatCountdown(1e12), '999+時');
  assert.equal(A.formatCountdown(-1e12), '+999+時');
  assert.equal(A.formatCountdown(undefined), '—');
});

// =====================================================================
// 9.8 Sanitize, import, schema
// =====================================================================
test('V52 sanitizeText', () => {
  assert.equal(A.sanitizeText(' a\u0000b\u202e ', 24), 'ab');
  const emoji = '😀'.repeat(30);
  const out = A.sanitizeText(emoji, 24);
  assert.equal(Array.from(out).length, 24);
  assert.equal(out, '😀'.repeat(24));
  assert.equal(A.sanitizeText(5, 24), '');
  assert.equal(A.sanitizeText(null, 24), '');
  assert.equal(A.sanitizeText(undefined, 24), '');
  assert.equal(A.sanitizeText('a\u200Bb\u200Dc\uFEFFd\u2066e\u2069', 24), 'abcde');
  assert.equal(A.sanitizeText('a\tb\nc', 24), 'abc');
  assert.equal(A.sanitizeText('e\u0301', 24), '\u00e9'); // NFC
});

test('V53 escapeHtml', () => {
  assert.equal(A.escapeHtml('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(A.escapeHtml(null), '');
  assert.equal(A.escapeHtml(5), '5');
});

test('V54 validateImport reject codes', () => {
  assert.deepEqual(A.validateImport('{bad', T), { ok: false, code: 'parse' });
  assert.equal(A.validateImport('x'.repeat(2 * 1024 * 1024 + 1), T).code, 'too-large');
  assert.equal(A.validateImport('{"schema":99}', T).code, 'schema-too-new');
  assert.equal(A.validateImport('{}', T).code, 'schema-missing');
  assert.equal(A.validateImport('{"schema":1}', T).code, 'empty');
  assert.equal(A.validateImport('[1,2]', T).code, 'not-object');
  assert.equal(A.validateImport('null', T).code, 'not-object');
  assert.equal(A.validateImport('5', T).code, 'not-object');
  assert.equal(A.validateImport({ schema: 1, accounts: [] }, T).code, 'empty');
  assert.equal(A.validateImport({ schema: 'abc', accounts: [{}] }, T).code, 'schema-missing');
  const ok = A.validateImport({ schema: 1, settings: {} }, T);
  assert.equal(ok.ok, true);
  const ok2 = A.validateImport(JSON.stringify({ schema: 1, accounts: [{ label: 'x' }] }), T);
  assert.equal(ok2.ok, true);
  assert.equal(ok2.state.accounts.length, 1);
});

test('V55 account with 6 characters keeps 5 + warning; names literal, cut at 24 code points', () => {
  const chars = [];
  for (let i = 0; i < 6; i++) chars.push({ id: 'c_x' + i + 'abc', name: 'n' + i, level: 5 });
  chars[0].name = '<img src=x onerror=1>';
  chars[1].name = 'x'.repeat(100);
  const r = A.sanitizeState({ schema: 1, accounts: [{ id: 'a_1abc', label: 'L', characters: chars }] }, T);
  const cs = r.state.accounts[0].characters;
  assert.equal(cs.length, 5);
  assert.ok(r.warnings.length >= 1);
  assert.ok(r.dropped >= 1);
  assert.equal(cs[0].name, '<img src=x onerror=1>');
  assert.equal(Array.from(cs[1].name).length, 24);
});

test('V56 usage.freq proto key dropped; future run -> null + warning; numeric strings; pausedAt raised', () => {
  const polluted = JSON.parse('{"schema":1,"usage":{"freq":{"__proto__":5,"constructor":3,"g:a/b":2},"recent":[],"lastSpot":{"__proto__":"shed"}},"accounts":[]}');
  const r = A.sanitizeState(polluted, T);
  assert.deepEqual(Object.keys(r.state.usage.freq), ['g:a/b']);
  assert.equal(r.state.usage.freq['g:a/b'], 2);
  assert.equal(Object.getPrototypeOf(r.state.usage.freq), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(r.state.usage.lastSpot), []);

  const chars = mkChars().map((c) => ({ id: c.id, name: c.name, level: 3 }));
  const run = { spotId: 'kude', startedAt: T + 5 * D, pausedAt: null, freeSlotsAtStart: [34, 34, 34, 34, 34], droppedAtStart: 0, fired: { now: false, overdue: false } };
  const acc = { id: 'a_1abc', label: 'L', stone: { spotId: 'kude', freeSlots: 34 }, stoneRun: run, characters: chars };
  const r2 = A.sanitizeState({ schema: 1, accounts: [acc] }, T);
  assert.equal(r2.state.accounts[0].stoneRun, null);
  assert.ok(r2.warnings.length >= 1);
  assert.ok(r2.dropped >= 1);

  const r3 = A.sanitizeState({ schema: 1, settings: { stonesPerSlot: '3' } }, T);
  assert.equal(r3.state.settings.stonesPerSlot, 3);
  const r4 = A.sanitizeState({ schema: 1, settings: { stonesPerSlot: 'abc' } }, T);
  assert.equal(r4.state.settings.stonesPerSlot, 3);
  const r5 = A.sanitizeState({ schema: 1, settings: { stonesPerSlot: '7.9' } }, T);
  assert.equal(r5.state.settings.stonesPerSlot, 7);

  // pausedAt < startedAt is raised to startedAt (stone run and gather run)
  const good = { spotId: 'kude', startedAt: T - H, pausedAt: T - 2 * H, freeSlotsAtStart: [34], droppedAtStart: 0, fired: { now: false, overdue: false } };
  const gr = Object.assign(COPPER(), { startedAt: T - H, pausedAt: T - 3 * H, lastDepositAt: null, fired: { now: false, overdue: false } });
  const chars2 = [{ id: 'c_aaa', name: 'x', level: 1, gather: COPPER(), gatherRun: gr }];
  const r6 = A.sanitizeState({ schema: 1, accounts: [{ id: 'a_1abc', label: 'L', stone: { spotId: 'kude', freeSlots: 34 }, stoneRun: good, characters: chars2 }] }, T);
  assert.equal(r6.state.accounts[0].stoneRun.pausedAt, T - H);
  assert.equal(r6.state.accounts[0].characters[0].gatherRun.pausedAt, T - H);
  // a garbage pausedAt becomes null + warning
  const bad = Object.assign({}, good, { pausedAt: 'abc' });
  const r7 = A.sanitizeState({ schema: 1, accounts: [{ id: 'a_1abc', label: 'L', stone: { spotId: 'kude', freeSlots: 34 }, stoneRun: bad, characters: [] }] }, T);
  assert.equal(r7.state.accounts[0].stoneRun.pausedAt, null);
  assert.ok(r7.warnings.length >= 1);
});

test('V57 migrate / loadState', () => {
  const m = A.migrate({ schema: 1, accounts: [] });
  assert.equal(m.ok, true);
  assert.equal(m.steps, 0);
  assert.equal(m.from, 1);
  assert.equal(m.to, 1);
  assert.deepEqual(A.migrate({ schema: 99 }), { ok: false, error: 'schema-too-new' });
  assert.equal(A.loadState(null, T).status, 'default');
  assert.equal(A.loadState(undefined, T).status, 'default');
  assert.equal(A.loadState('', T).status, 'default');
  const c = A.loadState('{bad', T);
  assert.equal(c.status, 'corrupt');
  assert.equal(c.readOnly, false);
  assert.equal(c.state.accounts.length, 0);
  const n = A.loadState('{"schema":99,"accounts":[]}', T);
  assert.equal(n.status, 'too-new');
  assert.equal(n.readOnly, true);
  assert.equal(A.loadState('[1]', T).status, 'corrupt');
  assert.equal(A.loadState('5', T).status, 'corrupt');
  const ok = A.loadState(JSON.stringify(A.defaultState(T)), T);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.readOnly, false);
  assert.equal(ok.dropped, 0);
});

const SEED = '{"schema":1,"accounts":[{"id":"a_demo01","label":"主帳","accountId":"demo-login","stone":{"spotId":"kude","freeSlots":34},"characters":[{"id":"c_demo01","name":"角色1","level":86,"gather":{"category":"mine","itemKey":"mine/銅","spotKey":"p:芙蕾雅法蘭城西門外國營第24坑道B1","itemName":"銅","placeLabel":"芙蕾雅 法蘭城西門外 國營第 24 坑道 B1","baseMinutes":135}},{"id":"c_demo02","name":"角色2","level":86},{"id":"c_demo03","name":"角色3","level":86},{"id":"c_demo04","name":"角色4","level":86},{"id":"c_demo05","name":"角色5","level":86}]}]}';

test('V58 the 8.11 seed passes validateImport with defaults filled', () => {
  const r = A.validateImport(SEED, T);
  assert.equal(r.ok, true);
  assert.equal(r.dropped, 0);
  assert.deepEqual(r.warnings, []);
  const s = r.state;
  assert.equal(s.schema, 1);
  assert.equal(s.accounts.length, 1);
  const a = s.accounts[0];
  assert.equal(a.id, 'a_demo01');
  assert.equal(a.label, '主帳');
  assert.equal(a.accountId, 'demo-login');
  assert.equal(a.characters.length, 5);
  assert.equal(a.characters[0].level, 86);
  const g = a.characters[0].gather;
  assert.equal(g.slots, 5);
  assert.equal(g.speed, 1);
  assert.equal(g.bufferMin, null);
  assert.equal(g.workHoursAtStart, null);
  assert.equal(g.baseMinutes, 135);
  assert.equal(g.itemKey, 'mine/銅');
  assert.equal(a.characters[1].gather, null);
  assert.equal(a.characters[1].gatherRun, null);
  assert.equal(a.stone.spotId, 'kude');
  assert.equal(a.stone.freeSlots, 34);
  assert.equal(a.stone.rateOverride, null);
  assert.equal(a.stoneRun, null);
  assert.deepEqual(a.onlineSessions, []);
  assert.deepEqual(s.spots.map((x) => x.id), ['kude', 'longshu']);
  assert.deepEqual(s.settings, A.defaultState(T).settings);
  // the seed renders a valid idle view
  const v = A.accountView(a, { settings: s.settings, spots: s.spots, observations: s.observations }, T);
  assert.equal(v.phase, 'idle');
  assert.equal(v.stone.plan.state, 'ok');
});

// =====================================================================
// 9.9 Pause, account operations, view model
// =====================================================================
test('V59 pauseRun / effectiveNow / resumeRun', () => {
  const run = RUN();
  const paused = A.pauseRun(run, T + H);
  assert.equal(paused.pausedAt, T + H);
  assert.equal(A.effectiveNow(paused, T + 3 * H), T + H);
  assert.equal(A.effectiveNow(paused, T), T);
  assert.equal(A.effectiveNow(run, T + 3 * H), T + 3 * H);
  const resumed = A.resumeRun(paused, T + 3 * H);
  assert.equal(resumed.startedAt, T + 2 * H);
  assert.equal(resumed.pausedAt, null);
  assert.equal(A.gatherRunStatus(resumed, A.effectiveNow(resumed, T + 4 * H)).elapsedMs, 2 * H);
  assert.equal(A.resumeRun(paused, T + 30 * M).startedAt, T);
  assert.equal(A.resumeRun(paused, T + 30 * M).pausedAt, null);
  assert.equal(run.pausedAt, undefined);
});

test('V60 identity on no-ops', () => {
  const run = RUN();
  const paused = A.pauseRun(run, T + H);
  assert.equal(A.pauseRun(paused, T + 2 * H), paused);
  assert.equal(A.resumeRun(run, T + 5), run);
  assert.equal(A.pauseRun(null, T), null);
  assert.equal(A.pauseRun(run, NaN), run);
  assert.equal(A.resumeRun(paused, NaN), paused);
  const st = DEF();
  const offline = mkF();
  assert.equal(A.goOffline(offline, T, st), offline);
  const online = A.goOnline(offline, T, st);
  assert.notEqual(online, offline);
  assert.equal(A.goOnline(online, T + 5, st), online);
  assert.equal(A.isOnline(online), true);
  assert.equal(A.isOnline(offline), false);
});

test('V61 accountView idle plan', () => {
  const v = A.accountView(mkF(), mkCtx(), T);
  assert.equal(v.id, 'a_1');
  assert.equal(v.label, '主帳');
  assert.equal(v.phase, 'idle');
  assert.equal(v.online, false);
  assert.deepEqual(v.stone.capacities, [102, 102, 102, 102, 102]);
  assert.deepEqual(v.stone.plan, { state: 'ok', firstFullHours: 10.2, lastFullHours: 10.2, capacity: 102, goldAtFull: { perChar: [54264, 54264, 54264, 54264, 54264], total: 271320 } });
  assert.equal(v.stone.configured, true);
  assert.equal(v.stone.spotId, 'kude');
  assert.equal(v.stone.spotName, '庫德');
  assert.equal(v.stone.ratePerHour, 10);
  assert.equal(v.stone.rateSource, 'default');
  assert.equal(v.stone.run, null);
  assert.equal(v.urgency, null);
  assert.equal(v.actAt, null);
  assert.equal(v.gathers.length, 1);
  assert.equal(v.gathers[0].charId, 'c_1');
  assert.equal(v.gathers[0].itemName, '銅');
  assert.equal(v.gathers[0].run, null);
  assert.equal(v.gathers[0].planStatus.fullAt, 8100000);
  assert.equal(v.gathers[0].planStatus.collectBy, 7500000);
  assert.equal(v.session.currentMs, null);
  assert.equal(v.session.ms24h, 0);
});

test('V62 startAccount', () => {
  const ctx = mkCtx();
  const S = A.startAccount(mkF(), ctx, T);
  assert.equal(A.isOnline(S), true);
  assert.equal(S.stoneRun.startedAt, T);
  assert.equal(S.stoneRun.pausedAt, null);
  assert.deepEqual(S.stoneRun.freeSlotsAtStart, [34, 34, 34, 34, 34]);
  assert.equal(S.stoneRun.spotId, 'kude');
  assert.equal(S.stoneRun.droppedAtStart, 0);
  assert.deepEqual(S.stoneRun.fired, { now: false, overdue: false });
  assert.equal(S.characters[0].gatherRun.startedAt, T);
  assert.equal(S.characters[0].gatherRun.baseMinutes, 135);
  assert.equal(S.characters[0].gatherRun.itemKey, 'mine/銅');
  assert.equal(S.characters[1].gatherRun, null);
  assert.deepEqual(S.onlineSessions, [{ start: T, end: null }]);
  const S2 = A.startAccount(S, ctx, T + M);
  assert.equal(S2.stoneRun, S.stoneRun);
  assert.equal(S2.characters[0].gatherRun, S.characters[0].gatherRun);
  assert.equal(S2.stoneRun.startedAt, T);
  assert.equal(S2.characters[0].gatherRun.startedAt, T);
});

test('V63 accountView(S): urgency by time', () => {
  const ctx = mkCtx();
  const S = A.startAccount(mkF(), ctx, T);
  let v = A.accountView(S, ctx, at(95 * M));
  assert.equal(v.phase, 'running');
  assert.equal(v.gathers[0].run.urgency, 'calm');
  assert.equal(v.gathers[0].run.actRemainingMs, 30 * M);
  assert.equal(v.stone.run.urgency, 'calm');
  assert.equal(v.urgency, 'calm');
  assert.equal(v.actAt, T + 125 * M);
  v = A.accountView(S, ctx, at(112 * M));
  assert.equal(v.gathers[0].run.urgency, 'soon');
  assert.equal(v.urgency, 'soon');
  v = A.accountView(S, ctx, at(125 * M));
  assert.equal(v.gathers[0].run.urgency, 'now');
  assert.equal(v.gathers[0].run.actRemainingMs, 0);
  assert.equal(A.formatCountdown(v.gathers[0].run.actRemainingMs), '00:00');
  assert.equal(v.urgency, 'now');
  v = A.accountView(S, ctx, at(136 * M));
  assert.equal(v.gathers[0].run.urgency, 'overdue');
  assert.equal(v.gathers[0].run.actRemainingMs, -11 * M);
  assert.equal(A.formatCountdown(v.gathers[0].run.actRemainingMs), '+11:00');
  assert.equal(v.urgency, 'overdue');
  assert.equal(v.gathers[0].run.paused, false);
  assert.equal(v.gathers[0].run.state, 'running');
});

test('V64 stone-only account: progress, est, gold, urgency over time', () => {
  const ctx = mkCtx();
  const S = A.startAccount(stoneOnly(), ctx, T);
  assert.equal(S.characters[0].gatherRun, null);
  let v = A.accountView(S, ctx, at(5.1 * H));
  let r = v.stone.run;
  close(r.status.progress, 0.5, 1e-9);
  assert.deepEqual(r.estStones, [51, 51, 51, 51, 51]);
  assert.equal(r.goldNow.total, 135660);
  assert.equal(r.goldAtFull.total, 271320);
  assert.equal(r.urgency, 'calm');
  assert.equal(r.actAt, T + 36720000);
  assert.equal(r.actRemainingMs, 5.1 * H);
  assert.equal(v.gathers.length, 0);
  v = A.accountView(S, ctx, at(9.5 * H));
  assert.equal(v.stone.run.urgency, 'soon');
  assert.equal(v.stone.run.estStones[0], 95);
  assert.equal(v.stone.run.goldNow.total, 252700);
  v = A.accountView(S, ctx, at(10 * H));
  assert.equal(v.stone.run.urgency, 'now');
  assert.equal(v.stone.run.estStones[0], 100);
  assert.equal(v.stone.run.goldNow.total, 266000);
  v = A.accountView(S, ctx, at(10.2 * H));
  assert.equal(v.stone.run.state, 'full');
  assert.equal(v.stone.run.urgency, 'overdue');
  assert.equal(v.stone.run.estStones[0], 102);
  assert.equal(v.urgency, 'overdue');
  v = A.accountView(S, ctx, at(11 * H));
  assert.equal(v.stone.run.actRemainingMs, -48 * M);
});

test('V65 account.stone.dailyCap=100: plan capacity 100, gold 266,000, 10h', () => {
  const a = mkF();
  a.stone.dailyCap = 100;
  const v = A.accountView(a, mkCtx(), T);
  assert.equal(v.stone.plan.capacity, 100);
  assert.equal(v.stone.plan.goldAtFull.total, 266000);
  assert.equal(v.stone.plan.firstFullHours, 10);
  // settings.dailyCap works too, account value overrides it
  const ctx = mkCtx();
  ctx.settings.dailyCap = 50;
  assert.equal(A.accountView(mkF(), ctx, T).stone.plan.capacity, 50);
  assert.equal(A.accountView(a, ctx, T).stone.plan.capacity, 100);
});

test('V66 mixed bags: capacities, plan, run ordering', () => {
  const a = mkF();
  a.characters[1].freeSlots = 17;
  a.characters[2].freeSlots = 0;
  const ctx = mkCtx();
  const v = A.accountView(a, ctx, T);
  assert.deepEqual(v.stone.capacities, [102, 51, 0, 102, 102]);
  close(v.stone.plan.firstFullHours, 5.1, 1e-9);
  close(v.stone.plan.lastFullHours, 10.2, 1e-9);
  assert.deepEqual(v.stone.plan.goldAtFull.perChar, [54264, 27132, 0, 54264, 54264]);
  assert.equal(v.stone.plan.goldAtFull.total, 189924);
  const S = A.startAccount(a, ctx, T);
  assert.deepEqual(S.stoneRun.freeSlotsAtStart, [34, 17, 0, 34, 34]);
  const v2 = A.accountView(S, ctx, at(2 * H));
  assert.equal(v2.stone.run.fullCharIndex, 1);
  assert.equal(v2.stone.run.actRemainingMs, 3.1 * H);
  assert.equal(v2.stone.run.perChar[2].reason, 'no-slots');
  assert.equal(v2.stone.run.perChar[2].state, 'invalid');
  assert.equal(v2.stone.run.state, 'running');
});

test('V67 never an invalid run', () => {
  const ctx = mkCtx();
  const noSpot = stoneOnly();
  noSpot.stone.spotId = null;
  const v = A.accountView(noSpot, ctx, T);
  assert.equal(v.stone.configured, false);
  assert.equal(v.stone.plan.state, 'invalid');
  assert.equal(v.stone.plan.reason, 'no-spot');
  assert.equal(v.stone.ratePerHour, 0);
  assert.equal(A.startAccount(noSpot, ctx, T).stoneRun, null);
  const noSlots = stoneOnly();
  noSlots.stone.freeSlots = 0;
  const v2 = A.accountView(noSlots, ctx, T);
  assert.equal(v2.stone.plan.reason, 'no-slots');
  assert.equal(v2.stone.configured, false);
  assert.equal(A.startAccount(noSlots, ctx, T).stoneRun, null);
  const noMin = mkF();
  noMin.characters[0].gather = Object.assign(COPPER(), { baseMinutes: null });
  const S = A.startAccount(noMin, ctx, T);
  assert.equal(S.characters[0].gatherRun, null);
  assert.ok(S.stoneRun);
  // unknown spot id in ctx.spots -> no stone run
  const ghost = stoneOnly();
  ghost.stone.spotId = 'nope';
  assert.equal(A.startAccount(ghost, ctx, T).stoneRun, null);
  // daily cap already reached -> no run
  const capped = stoneOnly();
  capped.stone.dailyCap = 100;
  capped.stone.droppedToday = 100;
  assert.equal(A.accountView(capped, ctx, T).stone.plan.reason, 'cap-reached');
  assert.equal(A.startAccount(capped, ctx, T).stoneRun, null);
  // no characters
  const nobody = stoneOnly();
  nobody.characters = [];
  assert.equal(A.accountView(nobody, ctx, T).stone.plan.reason, 'no-characters');
  assert.equal(A.startAccount(nobody, ctx, T).stoneRun, null);
});

test('V68 goOffline / goOnline pause and resume', () => {
  const ctx = mkCtx();
  const settings = ctx.settings;
  const S = A.startAccount(mkF(), ctx, T);
  const off = A.goOffline(S, T + H, settings);
  assert.deepEqual(off.onlineSessions, [{ start: T, end: T + H }]);
  assert.equal(off.stoneRun.pausedAt, T + H);
  assert.equal(off.characters[0].gatherRun.pausedAt, T + H);
  let v = A.accountView(off, ctx, at(3 * H));
  assert.equal(v.phase, 'paused');
  assert.equal(v.online, false);
  assert.equal(v.stone.run.paused, true);
  assert.equal(v.stone.run.status.elapsedMs, H);
  assert.equal(v.stone.run.status.remainingMs, Math.round(9.2 * H));
  assert.equal(v.urgency, null);
  assert.equal(v.session.currentMs, null);
  const on = A.goOnline(off, T + 3 * H, settings);
  assert.equal(on.onlineSessions.length, 2);
  assert.deepEqual(on.onlineSessions[1], { start: T + 3 * H, end: null });
  assert.equal(on.stoneRun.startedAt, T + 2 * H);
  assert.equal(on.stoneRun.pausedAt, null);
  assert.equal(on.characters[0].gatherRun.startedAt, T + 2 * H);
  v = A.accountView(on, ctx, at(4 * H));
  assert.equal(v.phase, 'running');
  assert.equal(v.stone.run.status.elapsedMs, 2 * H);
  assert.equal(v.gathers[0].run.status.elapsedMs, 2 * H);
  assert.equal(v.session.currentMs, H);
  assert.equal(v.session.ms24h, 2 * H);
  // pauseRunsOnOffline false: nothing is paused
  const s2 = Object.assign({}, settings, { pauseRunsOnOffline: false });
  const off2 = A.goOffline(S, T + H, s2);
  assert.equal(off2.stoneRun.pausedAt, null);
  assert.equal(off2.characters[0].gatherRun.pausedAt, null);
  const v3 = A.accountView(off2, ctx, at(3 * H));
  assert.equal(v3.phase, 'paused');
  assert.equal(v3.stone.run.paused, false);
  assert.equal(v3.stone.run.status.elapsedMs, 3 * H);
  // paused runs never raise attention items
  assert.deepEqual(A.attentionItems([A.accountView(off, ctx, at(30 * H))]), []);
});

test('V69 two accounts: attentionItems order and summarize', () => {
  const ctx = mkCtx();
  const S1 = A.startAccount(mkF(), ctx, T);
  const f2 = mkF({ id: 'a_2', label: '副帳' });
  const S2 = A.startAccount(f2, ctx, T + 60 * M);
  const now = at(125 * M);
  const views = [A.accountView(S1, ctx, now), A.accountView(S2, ctx, now)];
  const items = A.attentionItems(views);
  // v2: a gather item is keyed by its GROUP (account + plan + start), not by a character id
  assert.deepEqual(items.map((i) => i.key), [views[0].gatherGroups[0].key, views[1].gatherGroups[0].key, 'a_1:stone', 'a_2:stone']);
  assert.deepEqual(items.map((i) => i.urgency), ['now', 'calm', 'calm', 'calm']);
  assert.deepEqual(items.map((i) => Math.round(i.remainingMs / M)), [0, 60, 487, 547]);
  assert.deepEqual(items.map((i) => i.kind), ['gather', 'gather', 'stone', 'stone']);
  assert.deepEqual(items.map((i) => i.charIndex), [0, 0, null, null]);
  assert.equal(items[0].accountId, 'a_1');
  assert.equal(items[0].label, '主帳');
  assert.equal(items[0].actAt, T + 125 * M);
  assert.equal(items[0].fullAt, T + 135 * M);
  assert.equal(typeof items[0].progress, 'number');
  assert.equal(items[0].title, '銅');
  assert.equal(items[2].title, '庫德');
  const s = A.summarize(views, now);
  assert.equal(s.accountsOnline, 2);
  assert.equal(s.accountsTotal, 2);
  assert.equal(s.ms24h, 11400000);
  assert.equal(s.ms7d, 11400000);
  assert.equal(s.goldThisRound, 542640);
  const idle = A.summarize([A.accountView(mkF(), ctx, T)], T);
  assert.equal(idle.goldThisRound, 0);
  assert.equal(idle.accountsOnline, 0);
  assert.equal(idle.accountsTotal, 1);
});

test('V70 spotRate', () => {
  const spot = SPOT_KUDE();
  const list = [obs(10, 80), obs(9, 81), obs(11, 99)];
  const a = A.spotRate(spot, list, T, null);
  close(a.ratePerHour, 9, 1e-9);
  assert.equal(a.source, 'calibrated');
  close(a.calibration.confidence, 0.75, 1e-9);
  assert.equal(a.calibration.label, '高');
  assert.equal(a.calibration.suggestAdopt, false);
  assert.equal(a.calibration.usedCount, 3);
  const b = A.spotRate(Object.assign({}, spot, { manualRate: 12 }), list, T, null);
  assert.equal(b.ratePerHour, 12);
  assert.equal(b.source, 'manual');
  assert.equal(b.calibration.suggestAdopt, true);
  const c = A.spotRate(Object.assign({}, spot, { manualRate: 12 }), list, T, 11);
  assert.equal(c.ratePerHour, 11);
  assert.equal(c.source, 'account');
  const d = A.spotRate(spot, list.map((o) => Object.assign({}, o, { excluded: true })), T, null);
  assert.equal(d.ratePerHour, 10);
  assert.equal(d.source, 'default');
  assert.equal(d.calibration, null);
  const e = A.spotRate({ id: 'longshu', name: '龍樹', defaultRate: 10, manualRate: null }, list, T, null);
  assert.equal(e.source, 'default');
  assert.equal(e.calibration, null);
  // manual close to calibrated: no suggestion; low confidence: no suggestion
  assert.equal(A.spotRate(Object.assign({}, spot, { manualRate: 9.5 }), list, T, null).calibration.suggestAdopt, false);
  assert.equal(A.spotRate(Object.assign({}, spot, { manualRate: 20 }), [obs(10, 80, 30)], T, null).calibration.suggestAdopt, false);
  // spot default rate is the prior
  const f = A.spotRate({ id: 'kude', defaultRate: 20, manualRate: null }, [], T, null);
  assert.equal(f.ratePerHour, 20);
});

test('V71 nextNotification', () => {
  const N = T;
  const st = (urgency, nowAt, overdueAt) => ({ state: 'running', urgency, nowAt, overdueAt });
  const F0 = () => ({ now: false, overdue: false });
  let r = A.nextNotification(st('calm', N + M, N + 10 * M), F0(), N);
  assert.equal(r.fire, null);
  assert.equal(r.missed, false);
  r = A.nextNotification(st('now', N - M, N + 9 * M), F0(), N);
  assert.equal(r.fire, 'now');
  assert.deepEqual(r.fired, { now: true, overdue: false });
  assert.equal(r.missed, false);
  r = A.nextNotification(st('now', N - M, N + 9 * M), { now: true, overdue: false }, N);
  assert.equal(r.fire, null);
  assert.deepEqual(r.fired, { now: true, overdue: false });
  r = A.nextNotification(st('overdue', N - 11 * M, N - M), { now: true, overdue: false }, N);
  assert.equal(r.fire, 'overdue');
  assert.deepEqual(r.fired, { now: true, overdue: true });
  r = A.nextNotification(st('overdue', N - 11 * M, N - M), F0(), N);
  assert.equal(r.fire, 'overdue');
  assert.deepEqual(r.fired, { now: true, overdue: true });
  r = A.nextNotification(st('overdue', N - 40 * M, N - 20 * M), F0(), N);
  assert.equal(r.fire, null);
  assert.deepEqual(r.fired, { now: true, overdue: true });
  assert.equal(r.missed, true);
  r = A.nextNotification(st('now', N - 6 * M, N + 4 * M), F0(), N);
  assert.equal(r.fire, null);
  assert.deepEqual(r.fired, { now: true, overdue: false });
  assert.equal(r.missed, true);
  r = A.nextNotification(st('now', N - 5 * M, N + 5 * M), F0(), N);
  assert.equal(r.fire, 'now');
  assert.equal(r.missed, false);
  r = A.nextNotification({ state: 'invalid' }, F0(), N);
  assert.equal(r.fire, null);
  r = A.nextNotification(st('now', N - M, N + 9 * M), undefined, N);
  assert.equal(r.fire, 'now');
  assert.deepEqual(r.fired, { now: true, overdue: false });
  // a 'full' stone status is evaluated too
  r = A.nextNotification({ state: 'full', urgency: 'overdue', nowAt: N - 20 * M, overdueAt: N - M }, F0(), N);
  assert.equal(r.fire, 'overdue');
  // returned fired is always a new object
  const fired = { now: true, overdue: true };
  assert.notEqual(A.nextNotification(st('now', N - M, N), fired, N).fired, fired);
  assert.equal(A.nextNotification(null, F0(), N).fire, null);
  // custom staleMs
  assert.equal(A.nextNotification(st('now', N - 6 * M, N + 4 * M), F0(), N, { staleMs: 10 * M }).fire, 'now');
});

// =====================================================================
// 9.10 Dataset block (skipped when the generated data file is absent)
// =====================================================================
test('V72 dataset facts (skipped when starcg_gather_data.js is absent)', { skip: !existsSync(DATA_PATH) && 'starcg_gather_data.js not generated yet' }, () => {
  const data = require('../starcg_gather_data.js');
  assert.deepEqual(data.categories.map((c) => c.key), ['hunt', 'mine', 'wood', 'herb']);
  assert.deepEqual(data.categories.map((c) => c.items.length), [32, 17, 12, 12]);
  const items = data.categories.flatMap((c) => c.items);
  assert.equal(items.length, 73);
  const spots = items.flatMap((i) => i.spots);
  assert.equal(spots.length, 151);
  const byKind = (k) => spots.filter((s) => s.kind === k).length;
  assert.equal(byKind('shed'), 67);
  assert.equal(byKind('spot'), 76);
  assert.equal(byKind('unique'), 6);
  assert.equal(byKind('mixed'), 2);
  const noData = items.filter((i) => !i.spots.some((s) => s.minutes > 0));
  assert.equal(noData.length, 6);
  assert.deepEqual(noData.map((i) => i.name).sort(), ['阿巴尼斯哈蜜瓜', '溼地毒蛇', '鋼騎之礦', '藍龍之鱗', '永久冰石', '魔法紅蘿卜'].sort());
  for (const it of noData) assert.equal(A.bestSpot(it), null, it.name);
  assert.equal(items.filter((i) => i.hint).length, 2);
  const mins = spots.map((s) => s.minutes).filter((m) => m > 0);
  assert.equal(Math.min(...mins), 133);
  assert.equal(Math.max(...mins), 2814);
  const copper = data.categories[1].items.find((i) => i.key === 'mine/銅');
  assert.ok(copper);
  assert.equal(copper.level, 1);
  assert.equal(copper.fee4000, 1320);
  assert.equal(copper.spots.length, 2);
  assert.deepEqual([copper.spots[0].key, copper.spots[0].place, copper.spots[0].kind, copper.spots[0].minutes], ['shed', '素材屋', 'shed', 134]);
  const s1 = copper.spots[1];
  assert.equal(s1.key, 'p:芙蕾雅法蘭城西門外國營第24坑道B1');
  assert.equal(s1.place.replace(/\s+/g, ''), '芙蕾雅法蘭城西門外國營第24坑道B1');
  assert.equal(s1.kind, 'spot');
  assert.equal(s1.minutes, 135);
  assert.deepEqual(s1.coords, [12, 29]);
  assert.equal(s1.nav, true);
  assert.equal(A.bestSpot(copper), 1);
  const keyRe = /^[a-z]+\/\S{1,40}$/;
  const spotRe = /^(shed|p:\S{1,80})$/;
  for (const it of items) {
    assert.match(it.key, keyRe);
    for (const s of it.spots) assert.match(s.key, spotRe);
  }
  const hit = A.lookupGather(data, 'mine/銅', 'p:芙蕾雅法蘭城西門外國營第24坑道B1');
  assert.equal(hit.matched, 'exact');
  assert.equal(hit.spot.minutes, 135);
  assert.equal(hit.item.key, 'mine/銅');
  const miss = A.lookupGather(data, 'mine/不存在', 'shed');
  assert.equal(miss.item, null);
  assert.equal(miss.matched, null);
  const shed = copper.spots[0];
  assert.equal(A.spotMinutes('mine/銅', shed, {}), 134);
  assert.equal(A.spotMinutes('mine/銅', shed, { 'mine/銅|shed': 140 }), 140);
});

// =====================================================================
// Extra hardening tests (every spec rule not covered by a numbered vector)
// =====================================================================
test('X stoneRunStatus check order: bad-time, no-slots, no-rate, cap-reached', () => {
  assert.equal(A.stoneRunStatus(P({ startedAt: NaN, freeSlots: 0, ratePerHour: 0 }), T).reason, 'bad-time');
  assert.equal(A.stoneRunStatus(P({ startedAt: undefined }), T).reason, 'bad-time');
  assert.equal(A.stoneRunStatus(P(), NaN).reason, 'bad-time');
  assert.equal(A.stoneRunStatus(P({ freeSlots: 0, ratePerHour: 0 }), T).reason, 'no-slots');
  assert.equal(A.stoneRunStatus(P({ ratePerHour: 0, dailyCap: 100, droppedAtStart: 100 }), T).reason, 'no-rate');
  assert.equal(A.stoneRunStatus(P({ ratePerHour: NaN }), T).reason, 'no-rate');
  const inv = A.stoneRunStatus(P({ ratePerHour: 0 }), T);
  assert.equal(inv.capacity, 102);
  assert.equal(inv.effectiveCapacity, 0);
  assert.equal(inv.stopReason, null);
  assert.equal(inv.durationMs, null);
  assert.equal(inv.fullAt, null);
  assert.equal(inv.nowAt, null);
  assert.equal(inv.overdueAt, null);
  assert.equal(inv.elapsedMs, null);
  assert.equal(inv.remainingMs, null);
  assert.equal(inv.progress, null);
  assert.equal(inv.estStones, 0);
  assert.equal(inv.startsInFuture, false);
  assert.equal(inv.urgency, null);
  // warn/now thresholds are configurable
  const s = A.stoneRunStatus(P({ warnMin: 30, nowMin: 5 }), at(10.2 * H - 20 * M));
  assert.equal(s.urgency, 'soon');
  assert.equal(A.stoneRunStatus(P({ warnMin: 30, nowMin: 5 }), at(10.2 * H - 4 * M)).urgency, 'now');
  assert.equal(A.stoneRunStatus(P({ warnMin: 30, nowMin: 5 }), at(10.2 * H - 40 * M)).urgency, 'calm');
  // 0 daily cap value means "no cap"
  assert.equal(A.stoneRunStatus(P({ dailyCap: 0 }), T).effectiveCapacity, 102);
  assert.equal(A.stoneRunStatus(P({ dailyCap: 500 }), T).stopReason, 'bag');
  // absurd rate never gives NaN
  assertFiniteDeep(A.stoneRunStatus(P({ ratePerHour: 1e12 }), T));
  assertFiniteDeep(A.stoneRunStatus(P({ ratePerHour: 1e-9 }), T));
});

test('X goldValue clamps fee and price; netGoldPerHour edge cases', () => {
  assert.equal(A.goldValue(100, 532, 100), 0);
  assert.equal(A.goldValue(100, 532, 150), 0);
  assert.equal(A.goldValue(100, 532, -10), 53200);
  assert.equal(A.goldValue(100, -5, 0), 0);
  assert.equal(A.goldValue(100.9, 532, 0), 53200);
  assert.equal(A.goldValue(100, 532, NaN), 53200);
  // fractional fee: 0.07 * 100 is 7.000000000000001 in floats; basis points must be rounded first
  assert.equal(A.goldValue(10000, 1, 0.07), 9993);
  assert.equal(A.goldValue(10000, 1, 0.29), 9971);
  assert.equal(A.netGoldPerHour(10000, 1, 0.07, null).gross, 9993);
  // cases where an unrounded fee*100 really changes the floored result (found by brute force)
  assert.equal(A.goldValue(100, 100, 64.01), 3599);
  assert.equal(A.goldValue(25, 100, 64.04), 899);
  assert.equal(A.goldValue(625, 532, 64.04), 119567);
  assert.deepEqual(A.accountGold([], 532, 0), { perChar: [], total: 0 });
  assert.deepEqual(A.accountGold(null, 532, 0), { perChar: [], total: 0 });
  const n = A.netGoldPerHour(NaN, 532, 0, null);
  assert.equal(n.gross, 0);
  assert.equal(n.complete, false);
  const m = A.netGoldPerHour(10, 532, 0, 9999);
  assert.equal(m.net, 5320 - 9999);
  assertFiniteDeep(A.netGoldPerHour(10, 532, 0, NaN));
});

test('X gather: custom buffer options, soonMs, invalid time, paused semantics', () => {
  assert.equal(A.gatherRunStatus(RUN(), T, { bufferMin: 20 }).collectBy, T + 115 * M);
  assert.equal(A.gatherRunStatus(RUN({ bufferMin: 0 }), T, { bufferMin: 20 }).collectBy, T + 135 * M);
  assert.equal(A.gatherRunStatus(RUN({ bufferMin: 5 }), T, { bufferMin: 20 }).collectBy, T + 130 * M);
  assert.equal(A.gatherRunStatus(RUN({ bufferMin: -5 }), T).collectBy, T + 135 * M);
  assert.equal(A.gatherRunStatus(RUN(), at(100 * M), { soonMs: 30 * M }).urgency, 'soon');
  assert.equal(A.gatherRunStatus(RUN(), at(90 * M), { soonMs: 30 * M }).urgency, 'calm');
  const bt = A.gatherRunStatus(RUN({ startedAt: NaN }), T);
  assert.equal(bt.state, 'invalid');
  assert.equal(bt.reason, 'bad-time');
  assert.equal(A.gatherRunStatus(RUN(), NaN).reason, 'bad-time');
  assert.equal(A.gatherRunStatus(null, T).state, 'invalid');
  assert.equal(A.gatherRunStatus(RUN({ baseMinutes: 120 }), T).bufferClamped, false);
  // 6 slots stretches the fill
  assert.equal(A.gatherRunStatus(RUN({ slots: 6 }), T).fillMs, 162 * M);
  // soon window is proportional: 20h fill -> capped at 30 min
  const long = A.gatherRunStatus(RUN({ baseMinutes: 1200 }), T + 1200 * M - 10 * M - 31 * M);
  assert.equal(long.urgency, 'calm');
  assert.equal(A.gatherRunStatus(RUN({ baseMinutes: 1200 }), T + 1200 * M - 10 * M - 29 * M).urgency, 'soon');
  // startedAt in the future: elapsed 0
  const fut = A.gatherRunStatus(RUN({ startedAt: T + H }), T);
  assert.equal(fut.elapsedMs, 0);
  assert.equal(fut.progress, 0);
  // never NaN with tiny work hours
  assertFiniteDeep(A.gatherRunStatus(RUN({ workHoursAtStart: 1e-12 }), T));
  assertFiniteDeep(A.gatherRunStatus(RUN({ baseMinutes: 1e-12 }), T));
  assertFiniteDeep(A.gatherRunStatus(RUN({ baseMinutes: 0.0000001 }), T));
});

test('X makeGatherRun / restartCharGather / restartStone / clearRuns', () => {
  const plan = COPPER();
  const run = A.makeGatherRun(plan, T);
  assert.equal(run.startedAt, T);
  assert.equal(run.pausedAt, null);
  assert.equal(run.lastDepositAt, null);
  assert.deepEqual(run.fired, { now: false, overdue: false });
  assert.equal(run.itemKey, 'mine/銅');
  assert.equal(plan.startedAt, undefined);

  // restartCharGather with a plan: a fresh run from the plan (new settings apply)
  const ch = deepFreeze({ id: 'c_1', name: 'x', level: 1, freeSlots: null, gather: COPPER(), gatherRun: Object.assign(A.makeGatherRun(COPPER(), T), { fired: { now: true, overdue: false } }) });
  const ch2 = A.restartCharGather(ch, T + 2 * H);
  assert.equal(ch2.gatherRun.startedAt, T + 2 * H);
  assert.equal(ch2.gatherRun.lastDepositAt, T + 2 * H);
  assert.deepEqual(ch2.gatherRun.fired, { now: false, overdue: false });
  assert.equal(ch2.gatherRun.pausedAt, null);
  assert.equal(ch.gatherRun.startedAt, T);
  // plan changed after start -> the restart picks the new plan
  const ch3 = Object.assign({}, ch, { gather: Object.assign(COPPER(), { itemName: '鐵', baseMinutes: 200, itemKey: 'mine/鐵' }) });
  assert.equal(A.restartCharGather(ch3, T + H).gatherRun.itemKey, 'mine/鐵');
  assert.equal(A.restartCharGather(ch3, T + H).gatherRun.baseMinutes, 200);
  // paused run stays paused (frozen at the restart time)
  const chp = Object.assign({}, ch, { gatherRun: A.pauseRun(ch.gatherRun, T + H) });
  const chp2 = A.restartCharGather(chp, T + 2 * H);
  assert.equal(chp2.gatherRun.pausedAt, T + 2 * H);
  assert.equal(chp2.gatherRun.startedAt, T + 2 * H);
  // only a run (plan cleared): the restart APPLIES the clear, so the run is dropped (this used to restart the stale
  // run, which made a cleared plan impossible to apply: 待套用 never went away). The input is not mutated.
  const only = deepFreeze({ id: 'c_1', gather: null, gatherRun: A.makeGatherRun(COPPER(), T) });
  const only2 = A.restartCharGather(only, T + H);
  assert.equal(only2.gatherRun, null);
  assert.equal(only2.gather, null);
  assert.ok(only.gatherRun, 'input untouched');
  assert.deepEqual(A.pendingChanges({ id: 'a_1', stone: {}, characters: [only] }).gather, ['c_1'], 'a cleared plan with a live run is pending');
  assert.deepEqual(A.pendingChanges({ id: 'a_1', stone: {}, characters: [only2] }), { stone: false, gather: [], any: false }, 'and no longer after the restart');
  // neither / bad time -> same ref
  const none = { id: 'c_1', gather: null, gatherRun: null };
  assert.equal(A.restartCharGather(none, T), none);
  assert.equal(A.restartCharGather(ch, NaN), ch);
  assert.equal(A.restartCharGather(null, T), null);

  const ctx = mkCtx();
  const S = deepFreeze(A.startAccount(mkF(), ctx, T));
  const R = A.restartStone(S, T + 3 * H);
  assert.equal(R.stoneRun.startedAt, T + 3 * H);
  assert.deepEqual(R.stoneRun.fired, { now: false, overdue: false });
  assert.equal(R.stoneRun.pausedAt, null);
  assert.equal(S.stoneRun.startedAt, T);
  const noRun = mkF();
  assert.equal(A.restartStone(noRun, T), noRun);
  const pausedS = A.goOffline(S, T + H, ctx.settings);
  assert.equal(A.restartStone(pausedS, T + 2 * H).stoneRun.pausedAt, T + 2 * H);
  assert.equal(A.restartStone(S, NaN), S);

  const cleared = A.clearRuns(S);
  assert.equal(cleared.stoneRun, null);
  assert.ok(cleared.characters.every((c) => c.gatherRun === null));
  assert.deepEqual(cleared.onlineSessions, S.onlineSessions);
  assert.equal(cleared.characters[0].gather.itemKey, 'mine/銅');
  assert.notEqual(cleared, S);
  const empty = mkF();
  assert.equal(A.clearRuns(empty), empty);
});

test('X goOnline/goOffline details', () => {
  const st = DEF();
  const acc = A.goOnline(mkF(), T, st);
  const off = A.goOffline(acc, T - H, st); // clock went back: end = max(at, start)
  assert.equal(off.onlineSessions[0].end, T);
  assert.equal(A.goOffline(acc, NaN, st), acc);
  assert.equal(A.goOnline(mkF(), NaN, st).onlineSessions.length, 0);
  // settings may be omitted
  assert.equal(A.goOffline(A.startAccount(mkF(), mkCtx(), T), T + H).stoneRun.pausedAt, T + H);
  // old sessions are kept; the session list never grows beyond the limit
  const many = [];
  for (let i = 0; i < 500; i++) many.push({ start: T - (1000 - i) * 2 * H, end: T - (1000 - i) * 2 * H + H });
  const big = A.goOnline(mkF({ onlineSessions: many }), T, st);
  assert.equal(big.onlineSessions.length, 500);
  assert.deepEqual(big.onlineSessions[499], { start: T, end: null });
  assert.equal(big.onlineSessions[0].start, many[1].start);
});

test('X onlineStats extras', () => {
  const r = A.onlineStats([{ start: T - 2 * H, end: null }, { start: NaN, end: T }, { start: T - H, end: NaN }], T, 3);
  assert.equal(r.buckets.length, 3);
  assert.equal(r.totalMs, 2 * H);
  assert.deepEqual(A.onlineStats(undefined, T).buckets.length, 7);
  assert.equal(A.onlineStats([], T, 7).totalMs, 0);
  assert.equal(A.onlineStats([], T, 7).currentSessionMs, null);
  const stale = A.onlineStats([{ start: T - 10 * H, end: null }], T, 7, { maxOpenMs: 5 * H });
  assert.equal(stale.staleOpen, true);
  assertFiniteDeep(A.onlineStats([{ start: 'x', end: 5 }, null, {}], T, 7));
});

test('X recordPick', () => {
  const frozen = deepFreeze({ recent: [{ key: 'g:a/b', at: 1 }], freq: { 'g:a/b': 1 }, lastSpot: { 'a/b': 'shed' } });
  const u1 = A.recordPick(frozen, 'g:c/d', T);
  assert.deepEqual(u1.recent.map((x) => x.key), ['g:c/d', 'g:a/b']);
  assert.equal(u1.recent[0].at, T);
  assert.equal(u1.freq['g:c/d'], 1);
  assert.equal(u1.freq['g:a/b'], 1);
  assert.deepEqual(u1.lastSpot, { 'a/b': 'shed' });
  const u2 = A.recordPick(u1, 'g:a/b', T + 1);
  assert.deepEqual(u2.recent.map((x) => x.key), ['g:a/b', 'g:c/d']);
  assert.equal(u2.freq['g:a/b'], 2);
  // from nothing
  const u0 = A.recordPick(undefined, 'g:x/y', T);
  assert.equal(u0.freq['g:x/y'], 1);
  // proto keys are ignored
  const u3 = A.recordPick(u2, '__proto__', T);
  assert.deepEqual(Object.keys(u3.freq).sort(), ['g:a/b', 'g:c/d']);
  assert.equal(Object.getPrototypeOf(u3.freq), Object.prototype);
  for (const k of ['constructor', 'prototype']) {
    assert.ok(!(Object.prototype.hasOwnProperty.call(A.recordPick(u2, k, T).freq, k)));
  }
  assert.equal(A.recordPick(u2, 5, T).recent.length, u2.recent.length);
  // caps
  let u = { recent: [], freq: {} };
  for (let i = 0; i < 40; i++) u = A.recordPick(u, 'g:i/' + i, T + i);
  assert.equal(u.recent.length, 30);
  assert.equal(u.recent[0].key, 'g:i/39');
  assert.equal(Object.keys(u.freq).length, 40);
  let w = { recent: [], freq: {} };
  for (let i = 0; i < 210; i++) w = A.recordPick(w, 'g:k/' + i, T + i);
  assert.equal(Object.keys(w.freq).length, 200);
  assert.ok(w.freq['g:k/209'] >= 1, 'the newest key survives');
  // frequent keys survive the cap
  let z = { recent: [], freq: { 'g:fav/1': 50 } };
  for (let i = 0; i < 210; i++) z = A.recordPick(z, 'g:k/' + i, T + i);
  assert.equal(z.freq['g:fav/1'], 50);
  assert.equal(Object.keys(z.freq).length, 200);
});

test('X lookupGather / spotMinutes / bestSpot with synthetic data', () => {
  const data = {
    aliases: { 'mine/舊銅': 'mine/銅', 'hunt/__proto__': 'x' },
    categories: [
      { key: 'mine', label: '挖掘', items: [{ key: 'mine/銅', name: '銅', spots: [{ key: 'shed', minutes: 134, kind: 'shed' }, { key: 'p:x', minutes: 135, kind: 'spot' }] }] },
      { key: 'wood', label: '木材', items: [{ key: 'wood/木', name: '木', spots: [{ key: 'shed', minutes: 100, kind: 'shed' }] }] },
    ],
  };
  const exact = A.lookupGather(data, 'mine/銅', 'p:x');
  assert.equal(exact.matched, 'exact');
  assert.equal(exact.spot.minutes, 135);
  const noSpot = A.lookupGather(data, 'mine/銅', 'p:nope');
  assert.equal(noSpot.matched, 'exact');
  assert.equal(noSpot.spot, null);
  const alias = A.lookupGather(data, 'mine/舊銅', 'shed');
  assert.equal(alias.matched, 'alias');
  assert.equal(alias.item.key, 'mine/銅');
  assert.equal(alias.spot.minutes, 134);
  const byName = A.lookupGather(data, 'mine/其他', 'shed', { category: 'mine', name: '銅' });
  assert.equal(byName.matched, 'name');
  assert.equal(byName.item.key, 'mine/銅');
  assert.equal(A.lookupGather(data, 'mine/其他', 'shed', { category: 'wood', name: '銅' }).matched, null);
  assert.deepEqual(A.lookupGather(null, 'mine/銅', 'shed'), { item: null, spot: null, matched: null });
  assert.deepEqual(A.lookupGather({}, 'mine/銅', 'shed'), { item: null, spot: null, matched: null });
  assert.deepEqual(A.lookupGather({ categories: [null, { items: null }] }, 'a/b', 's'), { item: null, spot: null, matched: null });
  assert.equal(A.lookupGather(data, 'hunt/__proto__', 'shed').matched, null);
  assert.equal(A.spotMinutes('mine/銅', { key: 'shed', minutes: 134 }, undefined), 134);
  assert.equal(A.spotMinutes('mine/銅', { key: 'shed', minutes: null }, {}), null);
  assert.equal(A.spotMinutes('mine/銅', { key: 'shed', minutes: 134 }, { 'mine/銅|shed': 0 }), 134);
  assert.equal(A.spotMinutes('mine/銅', { key: 'shed', minutes: null }, { 'mine/銅|shed': 50 }), 50);
  assert.equal(A.spotMinutes('mine/銅', null, {}), null);
});

test('X calibrate options and robustness', () => {
  // recency: an old record counts for less
  const fresh = A.calibrate([obs(10, 200)], null, T);
  const old = A.calibrate([obs(10, 200, 60)], null, T);
  assert.ok(fresh.confidence > old.confidence);
  assert.ok(fresh.ratePerHour > old.ratePerHour);
  // a future-dated observation is not given extra weight
  const future = A.calibrate([Object.assign(obs(10, 100), { at: T + 5 * D })], null, T);
  close(future.effectiveHours, 10, 1e-9);
  // garbage entries are ignored
  const g = A.calibrate([null, undefined, {}, { hours: 'x', stones: 5, at: T }, obs(10, 80)], null, T);
  assert.equal(g.sampleCount, 1);
  assert.equal(A.calibrate(undefined, null, T).method, 'prior');
  // zero stones are legitimate
  const z = A.calibrate([obs(10, 0)], null, T);
  assert.equal(z.usedCount, 1);
  close(z.ratePerHour, 5, 1e-9);
  assert.ok(z.low >= 0);
  // bounds of the label
  assert.equal(A.calibrate([obs(10, 100)], null, T).label, '中'); // conf 0.5
  assert.equal(A.calibrate([obs(30, 300)], null, T).label, '高'); // conf 0.75
  // custom prior + custom options
  const c = A.calibrate([obs(10, 200)], { ratePerHour: 20, strengthHours: 10 }, T, { minHours: 20 });
  assert.equal(c.usedCount, 0);
  assert.equal(c.ratePerHour, 20);
  assertFiniteDeep(A.calibrate([obs(1e-9, 5), obs(500, 20000)], { ratePerHour: NaN, strengthHours: NaN }, NaN));
});

test('X consumptionPerHour robustness and recency', () => {
  const list = [
    { at: T, hours: 10, consumption: { amount: 100, unitLabel: '魔法', goldValue: null } },
    { at: T - 60 * D, hours: 10, consumption: { amount: 400, unitLabel: '魔法', goldValue: null } },
    { at: T, hours: 0, consumption: { amount: 5, unitLabel: '魔法' } },
    { at: T, hours: 5, consumption: null },
    null,
    { at: T, hours: 5, consumption: { amount: 'x', unitLabel: '魔法' } },
  ];
  const r = A.consumptionPerHour(list, T);
  assert.ok(r.perHour > 10 && r.perHour < 25, 'recent record dominates: ' + r.perHour);
  assert.equal(r.sampleCount, 2);
  assert.equal(r.goldPerHour, null);
  assertFiniteDeep(A.consumptionPerHour(list, NaN));
  assert.equal(A.consumptionPerHour(undefined, T).perHour, null);
});

test('X formatting extras', () => {
  assert.equal(A.formatDuration(0), '不到1分');
  assert.equal(A.formatDuration(60 * M), '1小時0分');
  assert.equal(A.formatDuration(61 * M + 59999), '1小時1分');
  assert.equal(A.formatCountdown(59 * M + 59999), '59:59');
  assert.equal(A.formatCountdown(-1), '+00:00');
  assert.equal(A.formatCountdown(-3599999), '+59:59');
  assert.equal(A.formatCountdown(-3600000), '+1時00分');
  assert.equal(A.formatCountdown(-0), '00:00');
  assert.equal(A.formatCountdown(100 * H + 5 * M), '100時05分');
  assert.equal(A.formatEta(T, T, { tz: 'UTC' }), '今天 04:00');
  assert.equal(A.formatEta(T + D, T, { tz: 'UTC' }), '明天 04:00');
  assert.equal(A.formatEta(T + 3 * D, T, { tz: 'UTC' }), '週一 04:00');
  assert.equal(A.formatEta(T - 2 * D, T, { tz: 'UTC' }), '9/30 04:00');
  assert.equal(A.formatEta(T + 4.5 * H * 100, T, { tz: 'UTC' }).length > 0, true);
  assert.equal(A.formatEta(8.64e15 + 1, T, { tz: 'UTC' }), '—');
});

test('X sanitizeText extras', () => {
  assert.equal(A.sanitizeText('  hello  ', 24), 'hello');
  assert.equal(A.sanitizeText('abc', 0), '');
  assert.equal(A.sanitizeText('abc', -3), '');
  assert.equal(A.sanitizeText('abcdef', 3), 'abc');
  assert.equal(A.sanitizeText('abcdef'), 'abcdef');
  assert.equal(A.sanitizeText('abc', NaN), 'abc');
  assert.equal(A.sanitizeText('\u007f\u0085x', 24), 'x');
  assert.equal(A.sanitizeText('主帳🙂', 3), '主帳🙂');
  assert.equal(A.sanitizeText('主帳🙂🙂', 3), '主帳🙂');
  assert.equal(A.sanitizeText('a\u2028b\u2029c', 24), 'abc');
  assert.equal(A.sanitizeText('\u202aab\u202c', 24), 'ab');
});

test('X newId', () => {
  const re = /^[a-z]_[a-z0-9]{6}$/;
  assert.match(A.newId('a', new Set()), re);
  assert.match(A.newId('c', new Set(['c_aaaaaa'])), re);
  assert.match(A.newId('zzz', []), re);
  assert.match(A.newId('', []), re);
  assert.match(A.newId('A', []), re);
  const ids = new Set();
  for (let i = 0; i < 300; i++) {
    const id = A.newId('o', ids);
    assert.ok(!ids.has(id));
    ids.add(id);
  }
  // constant rand: collision loop terminates and the result is still unique and well-formed
  const taken = new Set(['a_aaaaaa']);
  const id = A.newId('a', taken, () => 0);
  assert.match(id, re);
  assert.notEqual(id, 'a_aaaaaa');
  // injected rand is used
  assert.equal(A.newId('a', [], () => 0), 'a_aaaaaa');
  // set is not mutated
  const s2 = new Set();
  A.newId('a', s2);
  assert.equal(s2.size, 0);
  // array and Set both accepted
  assert.match(A.newId('a', ['a_aaaaaa'], () => 0), re);
});

test('X defaultState', () => {
  const s = A.defaultState(T);
  assert.equal(s.schema, 1);
  assert.equal(s.rev, 0);
  assert.deepEqual(s.accounts, []);
  assert.deepEqual(s.observations, []);
  assert.deepEqual(s.usage, { recent: [], freq: {}, lastSpot: {} });
  assert.equal(s.meta.lastSeenAt, T);
  assert.deepEqual(s.spots.map((x) => [x.id, x.name, x.preset, x.defaultRate, x.manualRate, x.note]), [['kude', '庫德', true, 10, null, ''], ['longshu', '龍樹', true, 10, null, '']]);
  assert.deepEqual(s.settings, {
    stonesPerSlot: 3, stoneUnitPrice: 532, stoneFeePct: 0, dailyCap: null, gatherBufferMin: 10,
    stoneWarnMin: 60, stoneNowMin: 15, gatherSlots: 5, gatherSpeed: 1, workHourBurn: 1, pauseRunsOnOffline: true,
    notifications: false, sound: false, keepAwake: false, gatherMinuteOverrides: {}, mpGoldValue: null, mpPer12h: 17500,
  });
  // fresh objects every call
  s.settings.stonesPerSlot = 9;
  s.spots[0].name = 'x';
  assert.equal(A.defaultState(T).settings.stonesPerSlot, 3);
  assert.equal(A.defaultState(T).spots[0].name, '庫德');
  // a default state is a fixed point of sanitizeState
  const r = A.sanitizeState(A.defaultState(T), T);
  assert.deepEqual(r.state, A.defaultState(T));
  assert.equal(r.dropped, 0);
});

test('X sanitizeState: settings ranges', () => {
  const dirty = {
    stonesPerSlot: 500, stoneUnitPrice: -3, stoneFeePct: 250, dailyCap: 0, gatherBufferMin: 9999,
    stoneWarnMin: 5, stoneNowMin: 30, gatherSlots: '6', gatherSpeed: 9, workHourBurn: 0, pauseRunsOnOffline: 'yes',
    notifications: true, sound: 1, keepAwake: true, gatherMinuteOverrides: { 'mine/銅|shed': 140, 'bad key': 5, 'mine/銅|p:x': 'abc', 'mine/鐵|shed': 99999, '__proto__': 5 },
    extra: 'dropped',
  };
  const s = A.sanitizeState({ schema: 1, settings: dirty }, T).state.settings;
  assert.equal(s.stonesPerSlot, 99);
  assert.equal(s.stoneUnitPrice, 0);
  assert.equal(s.stoneFeePct, 100);
  assert.equal(s.dailyCap, null);
  assert.equal(s.gatherBufferMin, 240);
  assert.equal(s.stoneWarnMin, 5);
  assert.equal(s.stoneNowMin, 5); // clamped to warn
  assert.equal(s.gatherSlots, 6);
  assert.equal(s.gatherSpeed, 3);
  assert.equal(s.workHourBurn, 0.1);
  assert.equal(s.pauseRunsOnOffline, true);
  assert.equal(s.notifications, true);
  assert.equal(s.sound, false);
  assert.equal(s.keepAwake, true);
  assert.deepEqual(s.gatherMinuteOverrides, { 'mine/銅|shed': 140, 'mine/鐵|shed': 6000 });
  assert.ok(!('extra' in s));
  const t = A.sanitizeState({ schema: 1, settings: { dailyCap: '100', pauseRunsOnOffline: false, gatherSlots: 9, stoneFeePct: '20', gatherSpeed: 'abc' } }, T).state.settings;
  assert.equal(t.dailyCap, 100);
  assert.equal(t.pauseRunsOnOffline, false);
  assert.equal(t.gatherSlots, 5);
  assert.equal(t.stoneFeePct, 20);
  assert.equal(t.gatherSpeed, 1);
  assert.equal(A.sanitizeState({ schema: 1, settings: { dailyCap: 99999 } }, T).state.settings.dailyCap, 9999);
  // override cap of 200
  const many = {};
  for (let i = 0; i < 230; i++) many['mine/x' + i + '|shed'] = 10;
  const big = A.sanitizeState({ schema: 1, settings: { gatherMinuteOverrides: many } }, T);
  assert.equal(Object.keys(big.state.settings.gatherMinuteOverrides).length, 200);
  assert.ok(big.dropped >= 30);
});

test('X sanitizeState: spots', () => {
  const r = A.sanitizeState({ schema: 1, spots: [
    { id: 'longshu', name: '龍樹X', defaultRate: 12, manualRate: '15', note: 'n', preset: false },
    { id: 's_abc123', name: 'Custom', defaultRate: 0, manualRate: -5, preset: true },
    { id: 's_abc123', name: 'Dup id', defaultRate: 8 },
    { id: 'BAD ID!', name: '  ', defaultRate: 'x' },
    null,
    'string',
  ] }, T);
  const sp = r.state.spots;
  assert.deepEqual(sp.slice(0, 2).map((x) => x.id), ['kude', 'longshu']);
  assert.equal(sp[0].preset, true);
  assert.equal(sp[0].name, '庫德');
  assert.equal(sp[1].name, '龍樹X');
  assert.equal(sp[1].preset, true);
  assert.equal(sp[1].defaultRate, 12);
  assert.equal(sp[1].manualRate, 15);
  const customs = sp.slice(2);
  assert.equal(customs.length, 3);
  assert.ok(customs.every((c) => c.preset === false));
  assert.equal(customs[0].id, 's_abc123');
  assert.equal(customs[0].defaultRate, 10);
  assert.equal(customs[0].manualRate, null);
  assert.equal(new Set(sp.map((x) => x.id)).size, sp.length);
  assert.ok(customs.every((c) => c.name.length > 0));
  // spot limit 30
  const lots = [];
  for (let i = 0; i < 40; i++) lots.push({ id: 's_x' + String(i).padStart(3, '0'), name: 'S' + i });
  const big = A.sanitizeState({ schema: 1, spots: lots }, T);
  assert.equal(big.state.spots.length, 30);
  assert.ok(big.dropped >= 12);
  // observations / accounts follow a regenerated spot id
  const rr = A.sanitizeState({ schema: 1,
    spots: [{ id: 'Bad Id', name: 'Weird' }],
    observations: [{ id: 'o_aaa111', spotId: 'Bad Id', at: T, hours: 5, stones: 40 }],
    accounts: [{ id: 'a_aaa111', label: 'x', stone: { spotId: 'Bad Id', freeSlots: 5 } }] }, T);
  const newId = rr.state.spots[2].id;
  assert.match(newId, /^[a-z][a-z0-9_]{1,15}$/);
  assert.equal(rr.state.observations[0].spotId, newId);
  assert.equal(rr.state.accounts[0].stone.spotId, newId);
});

test('X sanitizeState: accounts, ids, labels, sessions', () => {
  const sessions = [
    { start: T - 5 * H, end: T - 4 * H },
    { start: 'abc', end: T },
    { start: T - 3 * H, end: T - 4 * H },
    { start: T - 2 * H, end: null },
    { start: T - H, end: null },
    { start: 5, end: 10 },
    { start: T + 10 * D, end: null },
    null,
  ];
  const raw = { schema: 1, accounts: [
    { id: 'a_one111', label: '主帳', accountId: '  login  ', note: 'n', onlineSessions: sessions, characters: [{ id: 'c_aaa', name: 'A' }, { id: 'c_aaa', name: 'B' }] },
    { id: 'a_one111', label: '主帳', characters: [] },
    { id: 'bad id', label: '', characters: [] },
    { label: '主帳 2' },
    'junk',
  ] };
  const r = A.sanitizeState(raw, T);
  const a = r.state.accounts;
  assert.equal(a.length, 4);
  assert.equal(new Set(a.map((x) => x.id)).size, 4);
  assert.ok(a.every((x) => /^[a-z]_[a-z0-9]{3,12}$/.test(x.id)));
  assert.equal(new Set(a.map((x) => x.label)).size, 4);
  assert.equal(a[0].label, '主帳');
  assert.equal(a[0].accountId, 'login');
  assert.ok(a.every((x) => x.label.length > 0));
  assert.equal(a[1].label, '主帳 2');
  assert.equal(a[2].label, '帳號3');
  assert.equal(a[3].label, '主帳 2 2');
  assert.ok(r.warnings.length >= 3);
  // sessions: bad ones gone, one open session (the newest), sorted ascending
  assert.deepEqual(a[0].onlineSessions, [{ start: T - 5 * H, end: T - 4 * H }, { start: T - H, end: null }]);
  // duplicate character ids are regenerated
  const ids = a[0].characters.map((c) => c.id);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.every((x) => /^[a-z]_[a-z0-9]{3,12}$/.test(x)));
  // 12 account cap
  const accs = [];
  for (let i = 0; i < 15; i++) accs.push({ id: 'a_acc' + String(i).padStart(3, '0'), label: 'L' + i });
  const big = A.sanitizeState({ schema: 1, accounts: accs }, T);
  assert.equal(big.state.accounts.length, 12);
  assert.ok(big.dropped >= 3);
  // 500 session cap keeps the newest
  const many = [];
  for (let i = 0; i < 520; i++) many.push({ start: T - (600 - i) * H, end: T - (600 - i) * H + 1000 });
  const s2 = A.sanitizeState({ schema: 1, accounts: [{ id: 'a_abcdef', label: 'x', onlineSessions: many }] }, T);
  assert.equal(s2.state.accounts[0].onlineSessions.length, 500);
  assert.equal(s2.state.accounts[0].onlineSessions[499].start, many[519].start);
  assert.equal(s2.state.accounts[0].onlineSessions[0].start, many[20].start);
  // long label cut at 40, accountId at 64, note at 120
  const t = A.sanitizeState({ schema: 1, accounts: [{ id: 'a_abcdef', label: 'x'.repeat(100), accountId: 'y'.repeat(100), note: 'z'.repeat(300) }] }, T).state.accounts[0];
  assert.equal(Array.from(t.label).length, 40);
  assert.equal(Array.from(t.accountId).length, 64);
  assert.equal(Array.from(t.note).length, 120);
  // proto keys on the account are dropped, the object is whitelisted
  const poisoned = JSON.parse('{"schema":1,"accounts":[{"id":"a_abcdef","label":"x","__proto__":{"evil":1},"constructor":{"x":1},"junk":5}]}');
  const p = A.sanitizeState(poisoned, T).state.accounts[0];
  assert.ok(!('junk' in p));
  assert.equal(p.evil, undefined);
});

test('X sanitizeState: stone plan, runs, characters', () => {
  const spots = [{ id: 'kude' }];
  const ch = (extra) => Object.assign({ id: 'c_abc', name: 'n', level: 5 }, extra || {});
  const acc = (extra) => Object.assign({ id: 'a_abcdef', label: 'x', stone: { spotId: 'kude', freeSlots: 34 }, characters: [ch()] }, extra || {});
  const go = (a) => A.sanitizeState({ schema: 1, accounts: [a] }, T);
  // stone fields
  const s = go(acc({ stone: { spotId: 'nope', freeSlots: '40.7', rateOverride: '0', dailyCap: -4, droppedToday: 99999 } }));
  const st = s.state.accounts[0].stone;
  assert.equal(st.spotId, null);
  assert.equal(st.freeSlots, 40);
  assert.equal(st.rateOverride, null);
  assert.equal(st.dailyCap, null);
  assert.equal(st.droppedToday, 9999);
  assert.ok(s.warnings.length >= 1);
  assert.deepEqual(go({ id: 'a_abcdef', label: 'x' }).state.accounts[0].stone, { spotId: null, freeSlots: 0, rateOverride: null, dailyCap: null, droppedToday: 0, mpPer12hOverride: null });
  assert.equal(go(acc({ stone: { rateOverride: 9.5, dailyCap: 100 } })).state.accounts[0].stone.rateOverride, 9.5);
  // character fields
  const c = go(acc({ characters: [ch({ level: 5000, freeSlots: '12', name: 55 }), ch({ id: 'x', level: 'abc', freeSlots: -3 }), ch({ level: 0, freeSlots: null })] })).state.accounts[0].characters;
  assert.equal(c[0].level, 999);
  assert.equal(c[0].freeSlots, 12);
  assert.equal(c[0].name, '');
  assert.equal(c[1].level, 1);
  assert.equal(c[1].freeSlots, 0);
  assert.equal(c[2].level, 1);
  assert.equal(c[2].freeSlots, null);
  assert.equal(c[0].gather, null);
  assert.equal(c[0].gatherRun, null);
  // stone run: valid run survives, fired/freeSlots sanitized
  const run = { spotId: 'kude', startedAt: T - H, pausedAt: null, freeSlotsAtStart: [34, '17', 'x', 500, null], droppedAtStart: '5', fired: { now: 'yes', overdue: true } };
  const r = go(acc({ stoneRun: run, stone: { spotId: 'kude', freeSlots: 20 } })).state.accounts[0].stoneRun;
  assert.equal(r.startedAt, T - H);
  assert.deepEqual(r.freeSlotsAtStart, [34, 17, 20, 500, 20]);
  assert.equal(r.droppedAtStart, 5);
  assert.deepEqual(r.fired, { now: false, overdue: true });
  assert.equal(r.spotId, 'kude');
  // timestamps: before 2000, string, float
  for (const bad of [5, 'abc', null, undefined, -1, 946684799999, T + 2 * D, NaN]) {
    const x = go(acc({ stoneRun: Object.assign({}, run, { startedAt: bad }) }));
    assert.equal(x.state.accounts[0].stoneRun, null, 'startedAt=' + String(bad));
  }
  assert.equal(go(acc({ stoneRun: Object.assign({}, run, { startedAt: T + 3 * H }) })).state.accounts[0].stoneRun.startedAt, T + 3 * H);
  assert.equal(go(acc({ stoneRun: Object.assign({}, run, { startedAt: String(T - H) }) })).state.accounts[0].stoneRun.startedAt, T - H);
  // run with unknown spot keeps the run but nulls the spot
  const u = go(acc({ stoneRun: Object.assign({}, run, { spotId: 'ghost' }) })).state.accounts[0].stoneRun;
  assert.equal(u.spotId, null);
  // gather plan sanitize
  const plan = { category: 'mine', itemKey: 'mine/銅', spotKey: 'shed', itemName: '銅'.repeat(40), placeLabel: 'p'.repeat(100), baseMinutes: '134', slots: 6, speed: 0.1, bufferMin: '500', workHoursAtStart: 200 };
  const g = go(acc({ characters: [ch({ gather: plan })] })).state.accounts[0].characters[0].gather;
  assert.equal(Array.from(g.itemName).length, 24);
  assert.equal(Array.from(g.placeLabel).length, 60);
  assert.equal(g.baseMinutes, 134);
  assert.equal(g.slots, 6);
  assert.equal(g.speed, 0.5);
  assert.equal(g.bufferMin, 240);
  assert.equal(g.workHoursAtStart, 99);
  // bad category / keys drop the plan
  for (const bad of [{ category: 'fish' }, { itemKey: 'no slash' }, { spotKey: 'x:y' }, { itemKey: 5 }]) {
    const x = go(acc({ characters: [ch({ gather: Object.assign({}, plan, bad) })] }));
    assert.equal(x.state.accounts[0].characters[0].gather, null, JSON.stringify(bad));
  }
  // baseMinutes out of range
  assert.equal(go(acc({ characters: [ch({ gather: Object.assign({}, plan, { baseMinutes: 0 }) })] })).state.accounts[0].characters[0].gather.baseMinutes, null);
  assert.equal(go(acc({ characters: [ch({ gather: Object.assign({}, plan, { baseMinutes: 'x' }) })] })).state.accounts[0].characters[0].gather.baseMinutes, null);
  assert.equal(go(acc({ characters: [ch({ gather: Object.assign({}, plan, { baseMinutes: 99999 }) })] })).state.accounts[0].characters[0].gather.baseMinutes, 6000);
  // gather run
  const grun = Object.assign({}, plan, { startedAt: T - H, pausedAt: null, lastDepositAt: T - 30 * M, fired: { now: true, overdue: false } });
  const gr = go(acc({ characters: [ch({ gatherRun: grun })] })).state.accounts[0].characters[0].gatherRun;
  assert.equal(gr.startedAt, T - H);
  assert.equal(gr.lastDepositAt, T - 30 * M);
  assert.deepEqual(gr.fired, { now: true, overdue: false });
  assert.equal(gr.itemKey, 'mine/銅');
  const grBad = go(acc({ characters: [ch({ gatherRun: Object.assign({}, grun, { startedAt: T + 9 * D }) })] }));
  assert.equal(grBad.state.accounts[0].characters[0].gatherRun, null);
  assert.equal(go(acc({ characters: [ch({ gatherRun: Object.assign({}, grun, { lastDepositAt: 'x' }) })] })).state.accounts[0].characters[0].gatherRun.lastDepositAt, null);
});

test('X sanitizeState: observations, usage, meta, root', () => {
  const o = (extra) => Object.assign({ id: 'o_abc123', spotId: 'kude', at: T, hours: 10, stones: 85 }, extra || {});
  const go = (list, extra) => A.sanitizeState(Object.assign({ schema: 1, accounts: [{ id: 'a_abcdef', label: 'x' }], observations: list }, extra || {}), T);
  const r = go([
    o(),
    o({ id: 'o_abc123', hours: 9, stones: 81 }),
    o({ spotId: 'ghost' }),
    o({ at: 'x' }),
    o({ hours: 0 }),
    o({ hours: 'abc' }),
    o({ stones: -1 }),
    o({ hours: 9999, stones: 99999 }),
    o({ stones: '12.3456', excluded: true, accountId: 'a_abcdef', consumption: { amount: '50', unitLabel: '', goldValue: '2000' } }),
    o({ accountId: 'a_missing', consumption: { amount: 'x' } }),
    o({ consumption: { amount: 5, unitLabel: 'x'.repeat(30), goldValue: -5 } }),
    null,
  ]).state.observations;
  assert.equal(r.length, 6);
  assert.equal(new Set(r.map((x) => x.id)).size, r.length);
  assert.equal(r[0].excluded, false);
  assert.equal(r[0].accountId, null);
  assert.equal(r[0].consumption, null);
  assert.equal(r[2].hours, 500);
  assert.equal(r[2].stones, 20000);
  assert.equal(r[3].stones, 12.35);
  assert.equal(r[3].excluded, true);
  assert.equal(r[3].accountId, 'a_abcdef');
  assert.deepEqual(r[3].consumption, { amount: 50, unitLabel: '魔法', goldValue: 2000 });
  assert.equal(r[4].accountId, null);
  assert.equal(r[4].consumption, null);
  assert.equal(Array.from(r[5].consumption.unitLabel).length, 12);
  assert.equal(r[5].consumption.goldValue, null);
  // cap 500, keep newest
  const lots = [];
  for (let i = 0; i < 520; i++) lots.push(o({ id: 'o_n' + String(i).padStart(4, '0'), at: T - (600 - i) * H }));
  const big = go(lots).state.observations;
  assert.equal(big.length, 500);
  assert.equal(big[499].at, T - 81 * H);
  assert.equal(big[0].at, T - 580 * H);
  // usage
  const u = A.sanitizeState({ schema: 1, usage: {
    recent: [{ key: 'g:a/b', at: T - 3 }, { key: 'g:c/d', at: T - 1 }, { key: 'g:a/b', at: T - 9 }, { key: 'bad', at: T }, { key: 'g:e/f', at: 'x' }, { key: '__proto__', at: T }, { key: 'g:x/y' + 'z'.repeat(80), at: T }],
    freq: { 'g:a/b': 3, 'g:c/d': '2', 'g:z/z': 0, 'g:n/n': 'abc', 'bad': 5, 's:k': 1.9 },
    lastSpot: { 'mine/銅': 'shed', 'mine/鐵': 'p:abc', 'bad': 'shed', 'mine/x': 'weird', '__proto__': 'shed' },
  } }, T).state.usage;
  assert.deepEqual(u.recent.map((x) => x.key), ['g:c/d', 'g:a/b']);
  assert.deepEqual(u.freq, { 'g:a/b': 3, 'g:c/d': 2, 's:k': 1 });
  assert.deepEqual(u.lastSpot, { 'mine/銅': 'shed', 'mine/鐵': 'p:abc' });
  const rec = [];
  for (let i = 0; i < 50; i++) rec.push({ key: 'g:k/' + i, at: T - i });
  assert.equal(A.sanitizeState({ schema: 1, usage: { recent: rec } }, T).state.usage.recent.length, 30);
  const fq = {};
  for (let i = 0; i < 260; i++) fq['g:k/' + i] = i + 1;
  const fqo = A.sanitizeState({ schema: 1, usage: { freq: fq } }, T).state.usage.freq;
  assert.equal(Object.keys(fqo).length, 200);
  assert.ok(fqo['g:k/259'] === 260 && !('g:k/0' in fqo));
  // meta / rev / savedAt
  const m = A.sanitizeState({ schema: 1, rev: '7', savedAt: 123, meta: { lastSeenAt: 'x' } }, T).state;
  assert.equal(m.rev, 7);
  assert.equal(m.savedAt, 0);
  assert.equal(m.meta.lastSeenAt, T);
  const m2 = A.sanitizeState({ schema: 1, rev: -3, savedAt: T - H, meta: { lastSeenAt: T - 5 * H } }, T).state;
  assert.equal(m2.rev, 0);
  assert.equal(m2.savedAt, T - H);
  assert.equal(m2.meta.lastSeenAt, T - 5 * H);
  assert.equal(A.sanitizeState({ schema: 1, rev: 99, savedAt: T - H }, T).state.schema, 1);
  // root garbage never throws
  for (const bad of [null, undefined, 5, 'x', [], [1, 2]]) {
    const x = A.sanitizeState(bad, T);
    assert.equal(x.state.schema, 1);
    assert.deepEqual(x.state.accounts, []);
  }
});

test('X sanitizeState is idempotent and tolerates a populated state', () => {
  const ctx = mkCtx();
  const S = A.startAccount(mkF(), ctx, T - 3 * H);
  const state = A.defaultState(T);
  state.accounts = [withValidIds(A.goOffline(S, T - H, ctx.settings))];
  state.accounts[0].characters[0].gather.spotKey = 'p:abc';
  state.observations = [{ id: 'o_aaa111', spotId: 'kude', at: T - D, hours: 10, stones: 85, accountId: 'a_acc001', excluded: false, consumption: { amount: 50, unitLabel: '魔法', goldValue: 2000 } }];
  state.usage = A.recordPick(state.usage, 'g:mine/銅', T);
  state.settings.gatherMinuteOverrides = { 'mine/銅|shed': 140 };
  const once = A.sanitizeState(state, T);
  assert.equal(once.dropped, 0, once.warnings.join('; '));
  assert.deepEqual(once.warnings, []);
  const twice = A.sanitizeState(once.state, T);
  assert.deepEqual(twice.state, once.state);
  // sanitize of the exported text equals the original state
  assert.equal(once.state.accounts[0].stoneRun.pausedAt, T - H);
  assert.equal(once.state.accounts[0].characters[0].gatherRun.pausedAt, T - H);
  assert.equal(once.state.observations[0].accountId, 'a_acc001');
});

test('X exportState / import round trip', () => {
  const ctx = mkCtx();
  const state = A.defaultState(T);
  state.accounts = [withValidIds(A.startAccount(mkF({ accountId: 'secret-login' }), ctx, T - 2 * H))];
  state.observations = [{ id: 'o_aaa111', spotId: 'kude', at: T - D, hours: 10, stones: 85, accountId: 'a_acc001', excluded: false, consumption: null }];
  const frozen = deepFreeze(JSON.parse(JSON.stringify(state)));
  const text = A.exportState(frozen, T + 5);
  assert.equal(typeof text, 'string');
  assert.ok(text.includes('\n  '), 'pretty printed');
  const parsed = JSON.parse(text);
  assert.equal(parsed.savedAt, T + 5);
  assert.equal(parsed.accounts[0].accountId, 'secret-login');
  const back = A.validateImport(text, T + 10);
  assert.equal(back.ok, true);
  assert.equal(back.dropped, 0);
  assert.deepEqual(back.state.accounts[0].stoneRun, state.accounts[0].stoneRun);
  assert.deepEqual(back.state.accounts[0].characters, state.accounts[0].characters);
  assert.deepEqual(back.state.observations, state.observations);
  // omit login id: accounts lose the label, observations keep their account reference
  const stripped = JSON.parse(A.exportState(frozen, T, { omitAccountId: true }));
  assert.equal(stripped.accounts[0].accountId, '');
  assert.equal(stripped.observations[0].accountId, 'a_acc001');
  assert.equal(stripped.accounts[0].label, '主帳');
  assert.equal(frozen.accounts[0].accountId, 'secret-login');
  assert.equal(A.validateImport(JSON.stringify(stripped), T).ok, true);
  assert.equal(JSON.parse(A.exportState(null, T)).schema, 1);
});

test('X migrate / loadState details', () => {
  assert.equal(A.migrate(null).ok, false);
  assert.equal(A.migrate({}).ok, false);
  assert.equal(A.migrate({ schema: 0 }).ok, false);
  assert.equal(A.migrate({ schema: 1.5 }).ok, false);
  const raw = { schema: 1, accounts: [] };
  assert.equal(A.migrate(raw).data, raw);
  const loaded = A.loadState(JSON.stringify({ accounts: [{ label: 'x' }] }), T);
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.state.accounts.length, 1);
  assert.ok(loaded.warnings.length >= 1);
  const tooNew = A.loadState('{"schema":2,"accounts":[{"label":"x","stone":{"freeSlots":3}}]}', T);
  assert.equal(tooNew.status, 'too-new');
  assert.equal(tooNew.readOnly, true);
  assert.ok(Array.isArray(tooNew.warnings));
  assert.equal(typeof tooNew.dropped, 'number');
  const frozen = deepFreeze(JSON.parse('{"schema":1,"accounts":[{"label":"x"}]}'));
  assert.equal(A.sanitizeState(frozen, T).state.accounts.length, 1);
});

test('X validateImport accepts objects and does not mutate them', () => {
  const obj = deepFreeze(JSON.parse(SEED));
  const r = A.validateImport(obj, T);
  assert.equal(r.ok, true);
  assert.equal(r.state.accounts[0].id, 'a_demo01');
  // 2 MB limit is measured in UTF-8 bytes
  const cjk = '{"schema":1,"x":"' + '字'.repeat(750000) + '"}'; // ~2.25 MB bytes but ~750k chars
  assert.equal(A.validateImport(cjk, T).code, 'too-large');
  const justOk = '{"schema":1,"accounts":[{"label":"x"}],"x":"' + 'a'.repeat(1000000) + '"}';
  assert.equal(A.validateImport(justOk, T).ok, true);
});

test('X accountView robustness (garbage and partial inputs never throw or produce NaN)', () => {
  const ctx = mkCtx();
  const weird = [
    {},
    { id: 'a_x', label: 'x' },
    { id: 'a_x', label: 'x', characters: null, stone: null },
    { id: 'a_x', label: 'x', characters: [null, {}, { id: 'c_1' }], stone: { spotId: 'kude', freeSlots: 'abc' }, onlineSessions: [null, { start: 'x' }] },
    mkF({ stoneRun: { spotId: 'kude', startedAt: NaN, pausedAt: null } }),
    mkF({ stoneRun: { spotId: 'kude', startedAt: T, pausedAt: NaN, freeSlotsAtStart: 'x', fired: null } }),
  ];
  for (const w of weird) {
    const v = A.accountView(w, ctx, T + H);
    assertFiniteDeep(v);
    assert.ok(['idle', 'running', 'paused'].includes(v.phase));
    A.attentionItems([v]);
    A.summarize([v], T);
  }
  // partial settings and missing ctx parts
  const partial = A.accountView(mkF(), { settings: { stonesPerSlot: 3 } }, T);
  assert.deepEqual(partial.stone.capacities, [102, 102, 102, 102, 102]);
  assert.equal(partial.stone.plan.reason, 'no-spot'); // no spots given
  assert.equal(partial.stone.plan.capacity, 0);
  assert.equal(partial.stone.configured, false);
  const bare = A.accountView(mkF(), undefined, T);
  assert.equal(bare.stone.plan.reason, 'no-spot');
  // a gather run with null minutes is invalid and not an attention item
  const bad = mkF();
  bad.characters[0].gatherRun = Object.assign(COPPER(), { baseMinutes: null, startedAt: T, pausedAt: null, lastDepositAt: null, fired: { now: false, overdue: false } });
  const v = A.accountView(bad, ctx, T + H);
  assert.equal(v.gathers[0].run.state, 'invalid');
  assert.equal(v.gathers[0].run.reason, 'no-minutes');
  assert.equal(v.gathers[0].run.status, null);
  assert.equal(v.gathers[0].run.urgency, null);
  assert.equal(v.gathers[0].run.actAt, null);
  assert.equal(v.gathers[0].run.actRemainingMs, null);
  assert.deepEqual(A.attentionItems([v]), []);
  // a stone run in which every character is invalid
  const inv = stoneOnly();
  inv.stone.freeSlots = 0;
  inv.stoneRun = { spotId: 'kude', startedAt: T, pausedAt: null, freeSlotsAtStart: [0, 0, 0, 0, 0], droppedAtStart: 0, fired: { now: false, overdue: false } };
  const iv = A.accountView(inv, ctx, T + H);
  assert.equal(iv.stone.run.state, 'invalid');
  assert.equal(iv.stone.run.reason, 'no-slots');
  assert.equal(iv.stone.run.status, null);
  assert.equal(iv.stone.run.urgency, null);
  assert.equal(iv.stone.run.actAt, null);
  assert.equal(iv.stone.run.fullCharIndex, null);
  assert.equal(iv.urgency, null);
  assert.deepEqual(iv.stone.run.estStones, [0, 0, 0, 0, 0]);
  assert.equal(iv.stone.run.goldNow.total, 0);
  assert.deepEqual(A.attentionItems([iv]), []);
  // calibrated rate flows into the view and the run
  const calCtx = mkCtx({ observations: [obs(10, 80), obs(9, 81), obs(11, 99)] });
  const cv = A.accountView(A.startAccount(stoneOnly(), calCtx, T), calCtx, T);
  assert.equal(cv.stone.rateSource, 'calibrated');
  close(cv.stone.ratePerHour, 9, 1e-9);
  assert.equal(cv.stone.calibration.label, '高');
  close(cv.stone.run.status.durationMs / H, 102 / 9, 1e-6);
  // account rateOverride beats calibration
  const ov = stoneOnly();
  ov.stone.rateOverride = 20;
  const ovv = A.accountView(ov, calCtx, T);
  assert.equal(ovv.stone.ratePerHour, 20);
  assert.equal(ovv.stone.rateSource, 'account');
  // gold uses price and fee from settings
  const feeCtx = mkCtx();
  feeCtx.settings.stoneFeePct = 20;
  assert.equal(A.accountView(mkF(), feeCtx, T).stone.plan.goldAtFull.total, 43411 * 5);
});

test('X accountView: run snapshot and plan are independent', () => {
  const ctx = mkCtx();
  const S = A.startAccount(mkF(), ctx, T);
  // editing the plan after start does not change the running gather timer
  const edited = Object.assign({}, S, { characters: S.characters.map((c, i) => (i === 0 ? Object.assign({}, c, { gather: Object.assign({}, c.gather, { baseMinutes: 600, itemName: '鐵' }) }) : c)) });
  const v = A.accountView(edited, ctx, at(60 * M));
  assert.equal(v.gathers[0].itemName, '銅'); // the run snapshot wins while running
  assert.equal(v.gathers[0].run.status.fullAt, T + 135 * M);
  assert.equal(v.gathers[0].planStatus.fullAt, 600 * M); // the plan preview shows the new plan
  assert.equal(v.gathers[0].plan.itemName, '鐵');
  // a stone run uses its own freeSlotsAtStart snapshot
  const changed = Object.assign({}, S, { stone: Object.assign({}, S.stone, { freeSlots: 10 }) });
  const v2 = A.accountView(changed, ctx, at(60 * M));
  assert.equal(v2.stone.run.status.capacity, 102);
  assert.deepEqual(v2.stone.capacities, [30, 30, 30, 30, 30]);
  // a run exists but the plan was cleared: still listed as a timer
  const noPlan = Object.assign({}, S, { characters: S.characters.map((c, i) => (i === 0 ? Object.assign({}, c, { gather: null }) : c)) });
  const v3 = A.accountView(noPlan, ctx, at(60 * M));
  assert.equal(v3.gathers.length, 1);
  assert.equal(v3.gathers[0].plan, null);
  assert.equal(v3.gathers[0].planStatus, null);
  assert.equal(v3.gathers[0].run.state, 'running');
});

test('X purity: nothing mutates frozen inputs (B4)', () => {
  const ctx = deepFreeze(mkCtx({ observations: [obs(10, 80)] }));
  const F = deepFreeze(mkF());
  const S = deepFreeze(A.startAccount(F, ctx, T));
  const v = A.accountView(S, ctx, at(3 * H));
  A.attentionItems(deepFreeze([v]));
  A.summarize(deepFreeze([v]), T);
  const off = A.goOffline(S, T + H, ctx.settings);
  A.goOnline(deepFreeze(off), T + 3 * H, ctx.settings);
  A.restartStone(S, T + H);
  A.restartCharGather(S.characters[0], T + H);
  A.clearRuns(S);
  A.pauseRun(S.stoneRun, T + H);
  A.resumeRun(deepFreeze(off).stoneRun, T + 3 * H);
  A.sanitizeState(deepFreeze(JSON.parse(SEED)), T);
  A.validateImport(deepFreeze(JSON.parse(SEED)), T);
  A.exportState(deepFreeze(A.defaultState(T)), T);
  A.spotRate(ctx.spots[0], ctx.observations, T, null);
  A.recordPick(deepFreeze({ recent: [], freq: {} }), 'g:a/b', T);
  A.quickPicks(deepFreeze({ recent: [{ key: 'a', at: 1 }], freq: { a: 1 } }), 3);
  A.calibrate(deepFreeze([obs(10, 80)]), deepFreeze({ ratePerHour: 10, strengthHours: 10 }), T);
  A.consumptionPerHour(deepFreeze([obs(10, 80, 0, { consumption: { amount: 1, unitLabel: 'x', goldValue: null } })]), T);
  A.onlineStats(deepFreeze([{ start: T - H, end: null }]), T);
  A.makeGatherRun(deepFreeze(COPPER()), T);
  A.makeStoneRun(F, T);
  A.lookupGather(deepFreeze({ aliases: {}, categories: [] }), 'a/b', 's');
  A.bestSpot(deepFreeze({ spots: [{ kind: 'shed', minutes: 1 }] }));
  assert.ok(true);
});

test('B5 fuzz: no status ever contains NaN/Infinity or throws', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const weirdNums = [0, 1, -1, 0.5, 34, 102, 1e-9, 1e9, 1e15, NaN, Infinity, -Infinity, null, undefined, '5', 'x', 3.7];
  const times = [T, T - H, T + H, T + 10 * H, T - 100 * D, T + 100 * D, NaN, undefined];
  for (let i = 0; i < 4000; i++) {
    const p = { startedAt: pick(times), freeSlots: pick(weirdNums), stonesPerSlot: pick(weirdNums), ratePerHour: pick(weirdNums), dailyCap: pick(weirdNums), droppedAtStart: pick(weirdNums), warnMin: pick(weirdNums), nowMin: pick(weirdNums) };
    assertFiniteDeep(A.stoneRunStatus(p, pick(times)));
    assertFiniteDeep(A.estimatedStonesAt(p, pick(times)));
    const run = { baseMinutes: pick(weirdNums), startedAt: pick(times), slots: pick(weirdNums), speed: pick(weirdNums), bufferMin: pick(weirdNums), workHoursAtStart: pick(weirdNums), pausedAt: pick([null, undefined, T, NaN]) };
    assertFiniteDeep(A.gatherRunStatus(run, pick(times), { bufferMin: pick(weirdNums), burn: pick(weirdNums), soonMs: pick(weirdNums) }));
    assertFiniteDeep(A.gatherFillMs(pick(weirdNums), { slots: pick(weirdNums), speed: pick(weirdNums) }) || 0);
    assertFiniteDeep(A.goldValue(pick(weirdNums), pick(weirdNums), pick(weirdNums)));
    assertFiniteDeep(A.netGoldPerHour(pick(weirdNums), pick(weirdNums), pick(weirdNums), pick(weirdNums)));
    assertFiniteDeep(A.calibrate([{ hours: pick(weirdNums), stones: pick(weirdNums), at: pick(times) }], { ratePerHour: pick(weirdNums), strengthHours: pick(weirdNums) }, pick(times)));
    A.formatDuration(pick(weirdNums));
    A.formatCountdown(pick(weirdNums));
    A.formatEta(pick(times), pick(times), { tz: 'UTC' });
    A.hoursToFull(pick(weirdNums), pick(weirdNums));
    A.stoneCapacity(pick(weirdNums), pick(weirdNums));
  }
  // every vector-sized status from the fixtures is finite (JSON round-trip with finite check)
  const ctx = mkCtx();
  const S = A.startAccount(mkF(), ctx, T);
  for (const k of [0, 5 * M, 95 * M, 125 * M, 140 * M, 5 * H, 10.2 * H, 30 * H]) assertFiniteDeep(A.accountView(S, ctx, at(k)));
});

// =====================================================================
// Scenario tests derived from the acceptance checklist (D4-D14): the exact strings and numbers
// the page will show are produced by these functions, so lock them here.
// =====================================================================
test('S1 acceptance D4/D6: a new 34-slot account shows 102 / 10小時12分 / 271,320 and counts down', () => {
  const ctx = mkCtx();
  const idle = A.accountView(stoneOnly(), ctx, T);
  const plan = idle.stone.plan;
  assert.equal(plan.capacity, 102);
  assert.equal(A.formatDuration(Math.round(plan.firstFullHours * H)), '10小時12分');
  assert.equal(plan.goldAtFull.total.toLocaleString('en-US'), '271,320');
  const S = A.startAccount(stoneOnly(), ctx, T);
  const v0 = A.accountView(S, ctx, T);
  assert.equal(A.formatCountdown(v0.stone.run.actRemainingMs), '10時12分');
  assert.equal(Math.round(v0.stone.run.status.progress * 100), 0);
  const v1 = A.accountView(S, ctx, at(5.1 * H));
  assert.equal(Math.round(v1.stone.run.status.progress * 100), 50);
  assert.equal(A.formatCountdown(v1.stone.run.actRemainingMs), '5時06分');
  assert.equal(v1.stone.run.status.estStones, 51);
  // daily cap 100 from settings
  const capCtx = mkCtx();
  capCtx.settings.dailyCap = 100;
  assert.equal(A.accountView(stoneOnly(), capCtx, T).stone.plan.goldAtFull.total, 266000);
  assert.equal(A.accountView(stoneOnly(), capCtx, T).stone.plan.capacity, 100);
});

test('S2 acceptance D7: gather preview strings and hero', () => {
  const copper = A.gatherRunStatus(Object.assign(COPPER(), { startedAt: 0 }), 0, { bufferMin: 10 });
  assert.equal(A.formatDuration(copper.fillMs), '2小時15分');
  assert.equal(A.formatDuration(copper.collectBy), '2小時5分');
  const two = A.gatherRunStatus(Object.assign(COPPER(), { baseMinutes: 120, startedAt: 0 }), 0, { bufferMin: 10 });
  assert.equal(A.formatDuration(two.collectBy), '1小時50分');
  const ctx = mkCtx();
  const S = A.startAccount(mkF(), ctx, T);
  const v = A.accountView(S, ctx, T);
  assert.equal(A.formatCountdown(v.gathers[0].run.actRemainingMs), '2時05分');
  // the collect-by clock time is the start plus 125 minutes
  assert.equal(A.formatEta(v.gathers[0].run.actAt, T, { tz: 'Asia/Taipei' }), '今天 14:05'); // T = 12:00 Taipei
  assert.equal(A.formatEta(v.stone.run.actAt, T, { tz: 'Asia/Taipei' }), '今天 22:12');
});

test('S3 acceptance D14: calibration then plan, consumption per hour and net line', () => {
  const list = [obs(10, 80), obs(9, 81), obs(11, 99)];
  const ctx = mkCtx({ observations: list });
  const v = A.accountView(stoneOnly(), ctx, T);
  assert.equal(v.stone.rateSource, 'calibrated');
  assert.equal(v.stone.ratePerHour.toFixed(1), '9.0');
  assert.equal(A.formatDuration(Math.round(v.stone.plan.firstFullHours * H)), '11小時20分');
  // excluded records no longer count (納入校準 off)
  const ctx2 = mkCtx({ observations: list.map((o, i) => (i === 0 ? Object.assign({}, o, { excluded: true }) : o)) });
  assert.notEqual(A.accountView(stoneOnly(), ctx2, T).stone.ratePerHour, v.stone.ratePerHour);
  // 94 stones by five characters together = 18.8 each
  assert.equal(94 / 5, 18.8);
  // consumption: 50 魔法 over 10 h with gold 2000 -> 5 魔法/時 and 200 金/時
  const c = A.consumptionPerHour([{ at: T, hours: 10, stones: 85, consumption: { amount: 50, unitLabel: '魔法', goldValue: 2000 } }], T);
  assert.equal(c.perHour, 5);
  assert.equal(c.goldPerHour, 200);
  const net = A.netGoldPerHour(10, 532, 0, c.goldPerHour);
  assert.deepEqual(net, { gross: 5320, consumptionGold: 200, net: 5120, complete: true });
});

test('S4 acceptance D8/D9: notification lifecycle with persisted flags (once per level, stale jump silent)', () => {
  const ctx = mkCtx();
  const base = A.startAccount(mkF(), ctx, T);
  // drive the gather timer second by second, persisting `fired` like the page does
  let run = base.characters[0].gatherRun;
  const fires = [];
  for (let t = 0; t <= 140 * M; t += 1000) {
    const now = T + t;
    const status = A.gatherRunStatus(run, A.effectiveNow(run, now), { bufferMin: 10 });
    const r = A.nextNotification(status, run.fired, A.effectiveNow(run, now));
    if (r.fire) fires.push([r.fire, t / M]);
    if (r.fired.now !== run.fired.now || r.fired.overdue !== run.fired.overdue) run = Object.assign({}, run, { fired: r.fired });
  }
  assert.deepEqual(fires, [['now', 125], ['overdue', 135]]);
  assert.deepEqual(run.fired, { now: true, overdue: true });

  // "reload": the persisted flags prevent duplicates
  const reloaded = A.nextNotification(A.gatherRunStatus(run, T + 136 * M, { bufferMin: 10 }), run.fired, T + 136 * M);
  assert.equal(reloaded.fire, null);

  // one 8-hour jump over both thresholds: nothing fires, one "missed", flags set
  const fresh = base.characters[0].gatherRun;
  const jump = A.nextNotification(A.gatherRunStatus(fresh, T + 8 * H, { bufferMin: 10 }), fresh.fired, T + 8 * H);
  assert.equal(jump.fire, null);
  assert.equal(jump.missed, true);
  assert.deepEqual(jump.fired, { now: true, overdue: true });

  // a restart resets the flags and the cycle repeats
  const restarted = A.restartCharGather(base.characters[0], T + 3 * H).gatherRun;
  assert.deepEqual(restarted.fired, { now: false, overdue: false });
  const again = A.nextNotification(A.gatherRunStatus(restarted, T + 3 * H + 125 * M, { bufferMin: 10 }), restarted.fired, T + 3 * H + 125 * M);
  assert.equal(again.fire, 'now');

  // stone timer: now fires 15 minutes before full, overdue at full
  const stoneS = A.startAccount(stoneOnly(), ctx, T);
  const sv = (k) => A.accountView(stoneS, ctx, k).stone.run.status;
  const f1 = A.nextNotification(sv(at(10.2 * H - 15 * M)), stoneS.stoneRun.fired, at(10.2 * H - 15 * M));
  assert.equal(f1.fire, 'now');
  const f2 = A.nextNotification(sv(at(10.2 * H)), f1.fired, at(10.2 * H));
  assert.equal(f2.fire, 'overdue');
  // paused runs are never evaluated by the page; effectiveNow keeps their urgency frozen anyway
  const off = A.goOffline(stoneS, at(10 * H), ctx.settings);
  const pv = A.accountView(off, ctx, at(30 * H));
  assert.equal(pv.stone.run.paused, true);
  assert.equal(pv.urgency, null);
  assert.equal(pv.stone.run.status.urgency, 'now'); // frozen at the pause instant
});

test('S5 startAccount on an offline account resumes paused runs and adds nothing twice', () => {
  const ctx = mkCtx();
  const S = A.startAccount(mkF(), ctx, T);
  const off = A.goOffline(S, T + H, ctx.settings);
  const back = A.startAccount(off, ctx, T + 4 * H);
  assert.equal(A.isOnline(back), true);
  assert.equal(back.stoneRun.pausedAt, null);
  assert.equal(back.stoneRun.startedAt, T + 3 * H); // shifted by the 3 h offline period
  assert.equal(back.characters[0].gatherRun.startedAt, T + 3 * H);
  assert.equal(back.characters[1].gatherRun, null);
  assert.equal(back.onlineSessions.length, 2);
  // an account that was online with no runs and gets a plan later: startAccount adds the runs
  const idleOnline = A.goOnline(mkF(), T, ctx.settings);
  const started = A.startAccount(idleOnline, ctx, T + M);
  assert.equal(started.stoneRun.startedAt, T + M);
  assert.equal(started.characters[0].gatherRun.startedAt, T + M);
  assert.equal(started.onlineSessions.length, 1);
});

test('S6 attentionItems / summarize ignore invalid and paused timers and tolerate junk', () => {
  assert.deepEqual(A.attentionItems(undefined), []);
  assert.deepEqual(A.attentionItems([null, {}, { id: 'x', stone: { run: null }, gathers: [null] }]), []);
  const s = A.summarize([null, { online: true, session: { ms24h: 5, ms7d: 7 }, stone: {} }], T);
  const noTimers = { timers: 0, stoneTimers: 0, gatherTimers: 0, pausedTimers: 0, byUrgency: { overdue: 0, now: 0, soon: 0, calm: 0 } };
  assert.deepEqual(s, Object.assign({ accountsOnline: 1, accountsTotal: 2, ms24h: 5, ms7d: 7, goldThisRound: 0 }, noTimers));
  assert.deepEqual(A.summarize(undefined, T), Object.assign({ accountsOnline: 0, accountsTotal: 0, ms24h: 0, ms7d: 0, goldThisRound: 0 }, noTimers));
});

// =====================================================================
// MP economics: 消耗 = MP spent (user decision 2026-10-03)
// =====================================================================
const mpObs = (h, stones, mp, ageDays, extra) => Object.assign({ spotId: 'kude', at: T - (ageDays || 0) * D, hours: h, stones, consumption: { amount: mp, unitLabel: 'MP', goldValue: null } }, extra || {});

test('MP1 mpStats worked example: 10h/85 stones/500 MP + 5h/40 stones/200 MP', () => {
  const r = A.mpStats([mpObs(10, 85, 500), mpObs(5, 40, 200)], T);
  assert.equal(r.sampleCount, 2);
  assert.ok(Math.abs(r.mpPerHour - 700 / 15) < 1e-9);
  assert.ok(Math.abs(r.mpPerStone - 700 / 125) < 1e-9);
  assert.ok(Math.abs(r.stonesPerKMp - 1000 / 5.6) < 1e-9);
});

test('MP2 mpStats: no data -> all null, sampleCount 0', () => {
  assert.deepEqual(A.mpStats([], T), { mpPerHour: null, mpPerStone: null, stonesPerKMp: null, sampleCount: 0 });
  assert.deepEqual(A.mpStats(undefined, T), { mpPerHour: null, mpPerStone: null, stonesPerKMp: null, sampleCount: 0 });
  assert.equal(A.mpStats([obs(10, 80, 0)], T).sampleCount, 0); // no consumption on the record
});

test('MP3 mpStats ignores the unit label (legacy 魔法 / HP records still count) and skips excluded records', () => {
  const list = [
    mpObs(10, 50, 100, 0, { consumption: { amount: 100, unitLabel: '魔法', goldValue: null } }),
    mpObs(10, 50, 100, 0, { consumption: { amount: 100, unitLabel: 'HP', goldValue: 5 } }),
    mpObs(10, 50, 9999, 0, { excluded: true }),
  ];
  const r = A.mpStats(list, T);
  assert.equal(r.sampleCount, 2);
  assert.equal(r.mpPerHour, 10);
  assert.equal(r.mpPerStone, 2);
});

test('MP4 a record with 0 stones still counts for MP/hour but not for MP/stone', () => {
  const r = A.mpStats([mpObs(10, 0, 100), mpObs(10, 50, 100)], T);
  assert.equal(r.mpPerHour, 10);
  assert.equal(r.mpPerStone, 2);
  const onlyZero = A.mpStats([mpObs(10, 0, 100)], T);
  assert.equal(onlyZero.mpPerHour, 10);
  assert.equal(onlyZero.mpPerStone, null);
  assert.equal(onlyZero.stonesPerKMp, null);
});

test('MP5 mpStats age weighting uses the 30-day half-life; 0 MP is a real value', () => {
  const r = A.mpStats([mpObs(10, 50, 100, 0), mpObs(10, 50, 400, 30)], T);
  assert.ok(Math.abs(r.mpPerHour - (100 + 0.5 * 400) / (10 + 0.5 * 10)) < 1e-9);
  const zero = A.mpStats([mpObs(10, 50, 0)], T);
  assert.equal(zero.mpPerHour, 0);
  assert.equal(zero.mpPerStone, 0);
  assert.equal(zero.stonesPerKMp, null); // 1000 / 0 must not become Infinity
});

test('MP6 mpStats skips malformed records and never returns NaN/Infinity', () => {
  const bad = [
    mpObs(0, 5, 100), mpObs(-3, 5, 100), mpObs(NaN, 5, 100), mpObs(5, 5, -1),
    { at: T, hours: 5, stones: 5, consumption: { amount: 'x' } }, null, undefined, 7,
  ];
  assert.deepEqual(A.mpStats(bad, T), { mpPerHour: null, mpPerStone: null, stonesPerKMp: null, sampleCount: 0 });
  assertFiniteDeep(A.mpStats([mpObs(10, 50, 100)], NaN));
  assertFiniteDeep(A.mpStats([mpObs(10, 50, 100)], Infinity));
});

test('MP7 mpForRun: MP still needed by one character', () => {
  const stats = { mpPerHour: 10, mpPerStone: 2 };
  assert.deepEqual(A.mpForRun(stats, { hoursRemaining: 3.5, stonesRemaining: 17 }), { forTime: 35, forStones: 34 });
  assert.deepEqual(A.mpForRun(stats, { hoursRemaining: 0, stonesRemaining: 0 }), { forTime: 0, forStones: 0 });
  assert.deepEqual(A.mpForRun(stats, { hoursRemaining: -1, stonesRemaining: NaN }), { forTime: null, forStones: null });
  assert.deepEqual(A.mpForRun({ mpPerHour: null, mpPerStone: null }, { hoursRemaining: 3 }), { forTime: null, forStones: null });
  assert.deepEqual(A.mpForRun(undefined, undefined), { forTime: null, forStones: null });
  assert.deepEqual(A.mpForRun(stats, { hoursRemaining: Infinity }), { forTime: null, forStones: null });
});

test('MP8 golden: 34 slots at 10 stones/h is 10.2 h; at 50 MP/h a character needs 510 MP to fill', () => {
  const hours = A.hoursToFull(A.stoneCapacity(34, 3), 10);
  assert.ok(Math.abs(hours - 10.2) < 1e-9);
  const r = A.mpForRun({ mpPerHour: 50, mpPerStone: 5 }, { hoursRemaining: hours, stonesRemaining: 102 });
  assert.ok(Math.abs(r.forTime - 510) < 1e-9);
  assert.ok(Math.abs(r.forStones - 510) < 1e-9);
});

// =====================================================================
// Fixer round (2026-10-03): defects found by review, each pinned by a test
// =====================================================================
const cal3 = (extra) => [0, 1, 2].map(() => Object.assign({ hours: 12, stones: 102, at: T }, extra || {}));

test('F1 a full-bag record is right-censored: it can raise the rate, never lower it', () => {
  const prior = { ratePerHour: 10, strengthHours: 10 };
  // the reported defect: a 102-stone bag settled after 12 h read as an exact 8.5/h and dragged the rate down
  const asExact = A.calibrate(cal3(), prior, T);
  close(asExact.ratePerHour, 8.826, 0.001);
  assert.equal(asExact.label, '高');
  // flagged as full it only says "at least 8.5/h": below the current estimate, so it changes nothing
  const asFull = A.calibrate(cal3({ full: true }), prior, T);
  assert.equal(asFull.ratePerHour, 10);
  assert.equal(asFull.usedCount, 0);
  assert.equal(asFull.censoredCount, 3);
  assert.equal(asFull.censoredIgnored, 3);
  assert.equal(asFull.confidence, 0);
  assert.equal(asFull.method, 'prior');
  // a 102-stone bag is then predicted full in 10.2 h (not 11.56 h)
  close(A.hoursToFull(102, asFull.ratePerHour), 10.2, 1e-9);
  // a lower bound ABOVE the estimate counts, as an exact record would: (100 + 102) / (10 + 5)
  const fast = A.calibrate([{ hours: 5, stones: 102, at: T, full: true }], prior, T);
  close(fast.ratePerHour, 202 / 15, 1e-9);
  assert.equal(fast.usedCount, 1);
  assert.equal(fast.censoredIgnored, 0);
});

test('F1 censored records mixed with exact ones: measured against the exact-only estimate', () => {
  const prior = { ratePerHour: 10, strengthHours: 10 };
  const exact = [0, 1, 2].map(() => ({ hours: 10, stones: 80, at: T }));
  close(A.calibrate(exact, prior, T).ratePerHour, 8.5, 1e-9);                       // (100 + 240) / 40
  // 10.2/h lower bound > 8.5 -> lifted: (100 + 240 + 102) / (10 + 30 + 10)
  const lifted = A.calibrate(exact.concat([{ hours: 10, stones: 102, at: T, full: true }]), prior, T);
  close(lifted.ratePerHour, 442 / 50, 1e-9);
  assert.equal(lifted.usedCount, 4);
  // exactly equal to the estimate is not "above": ignored
  const same = A.calibrate(exact.concat([{ hours: 12, stones: 102, at: T, full: true }]), prior, T);
  close(same.ratePerHour, 8.5, 1e-9);
  assert.equal(same.censoredIgnored, 1);
  // the outlier filter only looks at exact records (a wild censored lower bound cannot become the median)
  const five = [0, 1, 2, 3, 4].map(() => ({ hours: 10, stones: 90, at: T }));
  close(A.calibrate(five.concat([{ hours: 1, stones: 300, at: T, full: true }]), prior, T).ratePerHour, (100 + 450 + 300) / (10 + 50 + 1), 1e-9);
});

test('F1 spotRate and sanitizeState carry the full flag', () => {
  const spot = SPOT_KUDE();
  const r = A.spotRate(spot, cal3({ full: true }), T, null);
  assert.equal(r.source, 'default');
  assert.equal(r.calibration, null);
  assert.equal(r.ratePerHour, 10);
  const st = A.defaultState(T);
  const o = (extra) => Object.assign({ id: 'o_aaa111', spotId: 'kude', at: T, hours: 12, stones: 102, accountId: null, excluded: false, consumption: null }, extra || {});
  const withFull = A.sanitizeState({ schema: 1, observations: [o({ full: true }), o({ id: 'o_aaa222' }), o({ id: 'o_aaa333', full: 'yes' })] }, T).state;
  assert.equal(withFull.observations[0].full, true);
  assert.ok(!('full' in withFull.observations[1]), 'no flag is added to ordinary records');
  assert.ok(!('full' in withFull.observations[2]), 'only a real boolean true counts');
  const round = A.validateImport(A.exportState(withFull, T, {}), T);
  assert.equal(round.state.observations[0].full, true);
  assert.ok(st.observations.length === 0);
});

test('F2 assessObservation: time bounds, size bounds, full and odd detection', () => {
  const ok = { hours: 10, stonesPerChar: 85, capacityPerChar: 102, currentRate: 10 };
  let a = A.assessObservation(ok, T);
  assert.deepEqual(a.errors, {});
  close(a.impliedRate, 8.5, 1e-9);
  assert.equal(a.full, false); assert.equal(a.odd, false);
  // time: a far-future record was accepted in-session and then dropped by sanitizeState on reload
  assert.equal(A.assessObservation(Object.assign({}, ok, { at: T + 2 * D }), T).errors.at, 'future');
  assert.equal(A.assessObservation(Object.assign({}, ok, { at: T + 2 * M }), T).errors.at, undefined);   // slack for the minute-resolution input
  assert.equal(A.assessObservation(Object.assign({}, ok, { at: T + 2 * M + 1 }), T).errors.at, 'future');
  assert.equal(A.assessObservation(Object.assign({}, ok, { at: 946684799999 }), T).errors.at, 'too-old');
  assert.equal(A.assessObservation(Object.assign({}, ok, { at: T - 365 * D }), T).errors.at, undefined);
  assert.equal(A.sanitizeState({ schema: 1, observations: [{ id: 'o_aaa111', spotId: 'kude', at: T + 2 * D, hours: 5, stones: 40 }] }, T).dropped, 1);
  // hours
  assert.equal(A.assessObservation({ hours: 0, stonesPerChar: 5 }, T).errors.hours, 'missing');
  assert.equal(A.assessObservation({ hours: NaN, stonesPerChar: 5 }, T).errors.hours, 'missing');
  assert.equal(A.assessObservation({ hours: 0.0099, stonesPerChar: 5 }, T).errors.hours, 'too-short');
  assert.equal(A.assessObservation({ hours: 0.01, stonesPerChar: 5 }, T).errors.hours, undefined);
  assert.equal(A.assessObservation({ hours: 500, stonesPerChar: 5 }, T).errors.hours, undefined);
  assert.equal(A.assessObservation({ hours: 500.01, stonesPerChar: 5 }, T).errors.hours, 'too-long');
  // stones: the page used to clamp 99999999 to 20000 silently, so preview and stored value disagreed
  a = A.assessObservation({ hours: 5, stonesPerChar: 99999999, capacityPerChar: 102, currentRate: 9 }, T);
  assert.equal(a.errors.stones, 'too-many');
  assert.equal(a.impliedRate, null);
  assert.equal(A.assessObservation({ hours: 5, stonesPerChar: 20000 }, T).errors.stones, undefined);
  assert.equal(A.assessObservation({ hours: 5, stonesPerChar: -1 }, T).errors.stones, 'missing');
  assert.equal(A.assessObservation({ hours: 5, stonesPerChar: NaN }, T).errors.stones, 'missing');
  assert.equal(A.assessObservation({ hours: 5, stonesPerChar: 5, amountPerChar: 2e9 }, T).errors.amount, 'too-big');
  // full / over capacity / fast
  const cap = { hours: 12, capacityPerChar: 102, currentRate: 10 };
  assert.equal(A.assessObservation(Object.assign({ stonesPerChar: 101 }, cap), T).full, false);
  assert.equal(A.assessObservation(Object.assign({ stonesPerChar: 101.5 }, cap), T).full, true);
  a = A.assessObservation(Object.assign({ stonesPerChar: 102 }, cap), T);
  assert.equal(a.full, true); assert.equal(a.overCapacity, false); assert.equal(a.odd, false);
  a = A.assessObservation(Object.assign({ stonesPerChar: 103 }, cap), T);
  assert.equal(a.overCapacity, true); assert.equal(a.odd, true);
  a = A.assessObservation({ hours: 12, stonesPerChar: 500, capacityPerChar: 102, currentRate: 10 }, T);
  assert.equal(a.overCapacity, true); assert.equal(a.full, true); assert.equal(a.odd, true);
  assert.equal(A.assessObservation({ hours: 5, stonesPerChar: 100, capacityPerChar: 0, currentRate: 10 }, T).full, false);   // unknown capacity
  assert.equal(A.assessObservation({ hours: 5, stonesPerChar: 50, currentRate: 10 }, T).fastRate, false);                       // 10/h vs 10/h
  assert.equal(A.assessObservation({ hours: 1, stonesPerChar: 50, currentRate: 10 }, T).fastRate, false);                       // exactly 5x is not "more than 5x"
  assert.equal(A.assessObservation({ hours: 1, stonesPerChar: 51, currentRate: 10 }, T).fastRate, true);
  assert.equal(A.assessObservation({ hours: 1, stonesPerChar: 51, currentRate: 10 }, T).odd, true);
  assert.deepEqual(A.assessObservation(null, T).errors, { hours: 'missing', stones: 'missing' });
});

test('F3 a rate so slow that the bag takes > 9999 h is invalid everywhere, never a wrong time or Infinity', () => {
  // the plan and the timer share one bound (hoursToFull returned null, stoneRunStatus used to run on)
  assert.equal(A.MAX_FILL_HOURS, 9999);
  for (const rate of [1e-300, 1e-9, 1e-4, 0.0101]) {
    const s = A.stoneRunStatus(P({ ratePerHour: rate }), T + H);
    assert.equal(s.state, 'invalid', 'rate ' + rate);
    assert.equal(s.reason, 'too-slow');
    assert.equal(s.fullAt, null); assert.equal(s.remainingMs, null); assert.equal(s.urgency, null);
    assert.equal(s.estStones, 0);
    assertFiniteDeep(s);
  }
  assert.equal(A.stoneRunStatus(P({ ratePerHour: 0.0103 }), T).state, 'running');           // 102 / 0.0103 = 9902 h
  // order: no-rate still wins over too-slow, cap-reached over too-slow
  assert.equal(A.stoneRunStatus(P({ ratePerHour: 0 }), T).reason, 'no-rate');
  assert.equal(A.stoneRunStatus(P({ ratePerHour: 0.001, dailyCap: 10, droppedAtStart: 10 }), T).reason, 'cap-reached');
  // consistency with hoursToFull over a grid
  for (const [slots, per] of [[1, 1], [1, 3], [34, 3], [999, 3], [999, 99]]) {
    for (const rate of [1e-6, 0.001, 0.01, 0.0103, 0.1, 0.3, 1, 10, 9999, 1e5]) {
      const s = A.stoneRunStatus({ startedAt: T, freeSlots: slots, stonesPerSlot: per, ratePerHour: rate }, T);
      const hrs = A.hoursToFull(A.stoneCapacity(slots, per), rate);
      assert.equal(hrs === null, s.state === 'invalid', 'slots ' + slots + ' x ' + per + ' rate ' + rate);
      if (s.state === 'invalid') assert.equal(s.reason, 'too-slow');
    }
  }
  // the account view: plan invalid with a reason (it was plan.state "ok" with firstFullHours null)
  const acc = stoneOnly();
  acc.stone = Object.assign({}, acc.stone, { freeSlots: 400, rateOverride: 0.1 });
  const v0 = A.accountView(acc, mkCtx(), T);                  // the reported case: 1200 stones at 0.1/h = 12,000 h
  assert.equal(v0.stone.plan.state, 'invalid');
  assert.equal(v0.stone.plan.reason, 'too-slow');
  assert.equal(v0.stone.plan.firstFullHours, null);
  assertFiniteDeep(v0);
  const okView = A.accountView(Object.assign({}, acc, { stone: Object.assign({}, acc.stone, { rateOverride: 0.2 }) }), mkCtx(), T);
  assert.equal(okView.stone.plan.state, 'ok');                // 1200 / 0.2 = 6000 h is slow but real
  close(okView.stone.plan.firstFullHours, 6000, 1e-9);
  const slow = Object.assign({}, acc, { stone: Object.assign({}, acc.stone, { rateOverride: 0.1, freeSlots: 999 }) });
  const ctx = mkCtx(); ctx.settings.stonesPerSlot = 99;      // 98,901 stones at 0.1/h = 989,010 h
  const v1 = A.accountView(slow, ctx, T);
  assert.equal(v1.stone.plan.state, 'invalid');
  assert.equal(v1.stone.plan.reason, 'too-slow');
  assert.equal(v1.stone.plan.firstFullHours, null);
  assertFiniteDeep(v1);
  const started = A.startAccount(slow, ctx, T);
  assert.equal(started.stoneRun, null, 'never an invalid run');
  const forced = Object.assign({}, slow, { stoneRun: A.makeStoneRun(slow, T) });
  const v2 = A.accountView(forced, ctx, T + H);
  assert.equal(v2.stone.run.state, 'invalid');
  assert.equal(v2.stone.run.reason, 'too-slow');
  assert.equal(v2.urgency, null);
  assertFiniteDeep(v2);
});

test('F4 trimForQuota is pure: drops the oldest half of records and closed sessions, never runs or open sessions', () => {
  const sessions = [1, 2, 3, 4, 5].map((i) => ({ start: T - i * D, end: T - i * D + H }));
  const open = { start: T - H, end: null };
  const acc = Object.assign(mkF(), { id: 'a_1', onlineSessions: sessions.concat([open]), stoneRun: A.makeStoneRun(mkF(), T) });
  const observations = [4, 1, 3, 2, 5].map((d, i) => ({ id: 'o_' + i, spotId: 'kude', at: T - d * D, hours: 10, stones: 80 }));
  const state = deepFreeze({ schema: 1, rev: 7, accounts: [acc], observations, settings: DEF() });
  const r = A.trimForQuota(state);
  assert.equal(r.droppedObservations, 2);
  assert.equal(r.droppedSessions, 2);
  assert.deepEqual(r.state.observations.map((o) => (T - o.at) / D), [3, 2, 1]);          // the 3 newest, oldest first
  assert.equal(r.state.accounts[0].onlineSessions.length, 3 + 1);
  assert.deepEqual(r.state.accounts[0].onlineSessions.slice(-1), [open]);
  assert.equal(r.state.accounts[0].stoneRun, acc.stoneRun);
  assert.equal(r.state.rev, 7);
  assert.equal(state.observations.length, 5, 'the input is untouched');
  assert.equal(state.accounts[0].onlineSessions.length, 6);
  // 1 record or none: nothing to drop; odd counts floor
  assert.equal(A.trimForQuota({ observations: [{ at: 1 }] }).droppedObservations, 0);
  assert.equal(A.trimForQuota({ observations: [{ at: 1 }, { at: 2 }, { at: 3 }] }).droppedObservations, 1);
  assert.equal(A.trimForQuota({}).droppedObservations, 0);
  assert.equal(A.trimForQuota(null).state, null);
});

test('F5 storedRev reads the rev of a stored state without trusting it', () => {
  assert.equal(A.storedRev('{"schema":1,"rev":5,"accounts":[]}'), 5);
  assert.equal(A.storedRev('{"schema":1}'), 0);
  assert.equal(A.storedRev('{"rev":-3}'), 0);
  assert.equal(A.storedRev('{"rev":"9"}'), 0);
  assert.equal(A.storedRev('{"rev":4.9}'), 4);
  assert.equal(A.storedRev('{"rev":NaN'), null);
  assert.equal(A.storedRev('[1]'), null);
  assert.equal(A.storedRev(''), null);
  assert.equal(A.storedRev(null), null);
  assert.equal(A.storedRev(42), null);
  // a stale tab compares this with its own rev before writing: stored 6 > memory 1 means "do not overwrite"
  assert.ok(A.storedRev(A.exportState(Object.assign(A.defaultState(T), { rev: 6 }), T, {})) > 1);
});

test('F6 undo of a restart touches only that character (no duplicate alert, no lost second restart)', () => {
  const ctx = mkCtx();
  const base = mkF();
  base.characters[1].gather = COPPER();
  const S0 = A.startAccount(base, ctx, T);
  const restartAt = (acc, idx, at) => Object.assign({}, acc, { characters: acc.characters.map((c, i) => (i === idx ? A.restartCharGather(c, at) : c)) });
  // Case A: restart character 1; character 2 crosses its collect-by and its alert is delivered (flag set)
  const prev1 = clone(S0.characters[0].gatherRun);
  let acc = restartAt(S0, 0, at(120 * M));
  acc = Object.assign({}, acc, { characters: acc.characters.map((c, i) => (i === 1 ? Object.assign({}, c, { gatherRun: Object.assign({}, c.gatherRun, { fired: { now: true, overdue: false } }) }) : c)) });
  const undone = A.restoreGatherRun(acc, 'c_1', prev1, at(126 * M), ctx.settings);
  assert.deepEqual(undone.characters[0].gatherRun, prev1);
  assert.equal(undone.characters[1].gatherRun, acc.characters[1].gatherRun, 'character 2 is the very same run');
  assert.deepEqual(undone.characters[1].gatherRun.fired, { now: true, overdue: false }, 'the delivered alert stays delivered');
  assert.equal(undone.stoneRun, acc.stoneRun);
  // Case B: restart 1 then 2, then undo the OLDER restart: 2 keeps its restart
  let both = restartAt(S0, 0, at(100 * M));
  const prev2 = clone(both.characters[1].gatherRun);
  both = restartAt(both, 1, at(102 * M));
  const undoOld = A.restoreGatherRun(both, 'c_1', prev1, at(103 * M), ctx.settings);
  assert.equal(undoOld.characters[0].gatherRun.startedAt, T);
  assert.equal(undoOld.characters[1].gatherRun.startedAt, at(102 * M));
  const undoNew = A.restoreGatherRun(both, 'c_2', prev2, at(103 * M), ctx.settings);
  assert.equal(undoNew.characters[0].gatherRun.startedAt, at(100 * M));
  assert.equal(undoNew.characters[1].gatherRun.startedAt, T);
  // unknown character: same reference; null previous run clears it
  assert.equal(A.restoreGatherRun(acc, 'c_nope', prev1, T, ctx.settings), acc);
  assert.equal(A.restoreGatherRun(acc, 'c_1', null, T, ctx.settings).characters[0].gatherRun, null);
  // stone: put the previous run back, nothing else
  const prevStone = clone(S0.stoneRun);
  const rs = A.restartStone(S0, at(3 * H));
  const back = A.restoreStoneRun(rs, prevStone, at(3 * H), ctx.settings);
  assert.deepEqual(back.stoneRun, prevStone);
  assert.equal(back.characters, rs.characters);
  assert.equal(A.restoreStoneRun(rs, null, T, ctx.settings).stoneRun, null);
});

test('F6 restored runs are settled to the account state (online runs, offline pauses)', () => {
  const ctx = mkCtx();
  const S0 = A.startAccount(mkF(), ctx, T);
  const pausedPrev = A.pauseRun(S0.stoneRun, at(H));                // a run that was paused when it was replaced
  const onlineBack = A.restoreStoneRun(S0, pausedPrev, at(3 * H), ctx.settings);   // the account is online now
  assert.equal(onlineBack.stoneRun.pausedAt, null);
  assert.equal(onlineBack.stoneRun.startedAt, at(2 * H), 'the paused time does not count');
  const off = A.goOffline(S0, at(H), ctx.settings);
  const livePrev = clone(S0.stoneRun);
  const offBack = A.restoreStoneRun(off, livePrev, at(2 * H), ctx.settings);       // offline now: the run must be frozen
  assert.equal(offBack.stoneRun.pausedAt, at(2 * H));
  const noPause = Object.assign({}, ctx.settings, { pauseRunsOnOffline: false });
  assert.equal(A.restoreStoneRun(off, livePrev, at(2 * H), noPause).stoneRun.pausedAt, null);
});

test('F6 undoGoOffline: as if the offline press never happened', () => {
  const ctx = mkCtx();
  const S0 = A.startAccount(mkF(), ctx, T);
  const off = A.goOffline(S0, at(H), ctx.settings);
  const back = A.undoGoOffline(off, at(H), at(2 * H));
  assert.equal(A.isOnline(back), true);
  assert.deepEqual(back.onlineSessions, [{ start: T, end: null }]);
  assert.equal(back.stoneRun.pausedAt, null);
  assert.equal(back.stoneRun.startedAt, T, 'no shift: the minutes between are counted as if online');
  assert.equal(back.characters[0].gatherRun.pausedAt, null);
  assert.equal(back.characters[0].gatherRun.startedAt, T);
  // a run restarted while offline (paused at another moment) is resumed normally
  const restartedOff = Object.assign({}, off, { characters: off.characters.map((c, i) => (i === 0 ? A.restartCharGather(c, at(90 * M)) : c)) });
  assert.equal(restartedOff.characters[0].gatherRun.pausedAt, at(90 * M));
  const back2 = A.undoGoOffline(restartedOff, at(H), at(2 * H));
  assert.equal(back2.characters[0].gatherRun.pausedAt, null);
  assert.equal(back2.characters[0].gatherRun.startedAt, at(2 * H), 'frozen from its restart until now');
  assert.equal(back2.stoneRun.startedAt, T);
  // offline with the pause setting off: only the session reopens
  const offLive = A.goOffline(S0, at(H), noPauseSettings());
  const back3 = A.undoGoOffline(offLive, at(H), at(2 * H));
  assert.equal(A.isOnline(back3), true);
  assert.equal(back3.stoneRun.startedAt, T);
  // nothing to undo: same reference
  assert.equal(A.undoGoOffline(S0, at(H), at(2 * H)), S0);
  assert.equal(A.undoGoOffline(off, at(H) + 1, at(2 * H)), off);
  assert.equal(A.undoGoOffline(off, NaN, at(2 * H)), off);
  // an earlier closed session is not the one to reopen
  const twice = A.goOffline(A.goOnline(off, at(3 * H), ctx.settings), at(4 * H), ctx.settings);
  assert.equal(A.undoGoOffline(twice, at(H), at(5 * H)), twice);
  const reopened = A.undoGoOffline(twice, at(4 * H), at(5 * H));
  assert.deepEqual(reopened.onlineSessions, [{ start: T, end: at(H) }, { start: at(3 * H), end: null }]);
});
function noPauseSettings() { return Object.assign(DEF(), { pauseRunsOnOffline: false }); }

test('F6 restoreClearedRuns puts back only the runs that are still missing', () => {
  const ctx = mkCtx();
  const base = mkF();
  base.characters[1].gather = COPPER();
  const S0 = A.startAccount(base, ctx, T);
  const cleared = A.clearRuns(S0);
  assert.equal(cleared.stoneRun, null);
  const all = A.restoreClearedRuns(cleared, S0, at(5 * M), ctx.settings);
  assert.deepEqual(all.stoneRun, S0.stoneRun);
  assert.deepEqual(all.characters[0].gatherRun, S0.characters[0].gatherRun);
  assert.deepEqual(all.characters[1].gatherRun, S0.characters[1].gatherRun);
  // meanwhile the user started something new: that run is kept
  const newer = A.startAccount(cleared, ctx, at(2 * M));
  assert.equal(A.restoreClearedRuns(newer, S0, at(5 * M), ctx.settings), newer);
  const half = Object.assign({}, newer, { stoneRun: null });
  const mixed = A.restoreClearedRuns(half, S0, at(5 * M), ctx.settings);
  assert.deepEqual(mixed.stoneRun, S0.stoneRun);
  assert.equal(mixed.characters[0].gatherRun, newer.characters[0].gatherRun);
  assert.equal(A.restoreClearedRuns(S0, S0, T, ctx.settings), S0);
  assert.equal(A.restoreClearedRuns(null, S0, T, ctx.settings), null);
});

test('F7 pendingChanges: which plan edits are not in the running timers yet', () => {
  const ctx = mkCtx();
  const base = mkF();
  base.characters[1].gather = COPPER();
  const S0 = A.startAccount(base, ctx, T);
  assert.deepEqual(A.pendingChanges(S0), { stone: false, gather: [], any: false });
  assert.equal(A.pendingChanges(mkF()).any, false, 'no run, nothing can be pending');
  const edit = (patch) => Object.assign({}, S0, patch);
  assert.equal(A.pendingChanges(edit({ stone: Object.assign({}, S0.stone, { freeSlots: 20 }) })).stone, true);
  assert.equal(A.pendingChanges(edit({ stone: Object.assign({}, S0.stone, { spotId: 'longshu' }) })).stone, true);
  assert.equal(A.pendingChanges(edit({ stone: Object.assign({}, S0.stone, { spotId: null }) })).stone, true);
  assert.equal(A.pendingChanges(edit({ stone: Object.assign({}, S0.stone, { droppedToday: 40 }) })).stone, true);
  assert.equal(A.pendingChanges(edit({ stone: Object.assign({}, S0.stone, { rateOverride: 12, dailyCap: 100 }) })).stone, false, 'rate and cap are live, not pending');
  const ch = S0.characters.map((c, i) => (i === 3 ? Object.assign({}, c, { freeSlots: 10 }) : c));
  assert.equal(A.pendingChanges(edit({ characters: ch })).stone, true);
  const g = S0.characters.map((c, i) => (i === 1 ? Object.assign({}, c, { gather: Object.assign({}, c.gather, { baseMinutes: 120 }) }) : c));
  assert.deepEqual(A.pendingChanges(edit({ characters: g })).gather, ['c_2']);
  const cleared = S0.characters.map((c, i) => (i === 0 ? Object.assign({}, c, { gather: null }) : c));
  assert.deepEqual(A.pendingChanges(edit({ characters: cleared })).gather, ['c_1']);
  const sw = S0.characters.map((c, i) => (i === 0 ? Object.assign({}, c, { gather: Object.assign({}, c.gather, { slots: 6 }) }) : c));
  assert.deepEqual(A.pendingChanges(edit({ characters: sw })).any, true);
  // a restart makes the plan current again
  assert.equal(A.pendingChanges(A.restartStone(edit({ stone: Object.assign({}, S0.stone, { freeSlots: 20 }) }), at(M))).stone, false);
  assert.deepEqual(A.pendingChanges(null), { stone: false, gather: [], any: false });
});

test('F8 a rate typed into one account outranks calibration: say so when it has drifted', () => {
  const spot = SPOT_KUDE();
  const list = [obs(10, 80), obs(9, 81), obs(11, 99)];
  const a = A.spotRate(spot, list, T, 12);
  assert.equal(a.source, 'account');
  assert.equal(a.ratePerHour, 12);
  assert.equal(a.calibration.suggestAdoptOverride, true);
  assert.equal(a.calibration.suggestAdopt, false, 'the spec-defined flag still means a SPOT manual rate');
  assert.equal(A.spotRate(spot, list, T, 9.5).calibration.suggestAdoptOverride, false);                 // within 10%
  assert.equal(A.spotRate(spot, list, T, 10.3).calibration.suggestAdoptOverride, true);                 // 14.4% above 9
  assert.equal(A.spotRate(spot, [obs(10, 80, 30)], T, 20).calibration.suggestAdoptOverride, false);     // confidence 0.33
  assert.equal(A.spotRate(spot, list, T, null).calibration.suggestAdoptOverride, false);
  assert.equal(A.spotRate(spot, [], T, 12).calibration, null);
});

test('F9 gather status exposes startsInFuture; the page must not show it as a normal timer', () => {
  const s = A.gatherRunStatus(RUN({ startedAt: T + H }), T);
  assert.equal(s.state, 'running');
  assert.equal(s.startsInFuture, true);
  assert.equal(s.elapsedMs, 0);
  assert.equal(s.progress, 0);
  assert.equal(A.gatherRunStatus(RUN(), T).startsInFuture, false);
  assert.equal(A.gatherRunStatus(RUN({ startedAt: T }), T).startsInFuture, false);
  assert.equal(A.gatherRunStatus(RUN({ baseMinutes: null }), T).startsInFuture, false);
  assert.equal(A.stoneRunStatus(P({ startedAt: T + H }), T).startsInFuture, true);
});

test('F10 attentionItems name the character of a gather timer', () => {
  const ctx = mkCtx();
  const base = mkF();
  base.characters[0].name = '阿龍';
  // v2: two characters gathering the SAME thing at the same time are one group (see GG10), so the second one gathers iron
  base.characters[1].gather = Object.assign(COPPER(), { itemKey: 'mine/鐵', itemName: '鐵', baseMinutes: 120 });
  base.characters[1].name = '小美';
  const S0 = A.startAccount(base, ctx, T);
  const items = A.attentionItems([A.accountView(S0, ctx, at(126 * M))]).filter((i) => i.kind === 'gather');
  assert.deepEqual(items.map((i) => i.charName).sort(), ['小美', '阿龍']);
  assert.deepEqual(items.map((i) => i.charIndex).sort(), [0, 1]);
});

// =====================================================================
// Mutation-survivor coverage: behaviour that existing tests did not pin (found by single-line mutants)
// =====================================================================
test('M1 a paused timer stays frozen at pausedAt: gather and stone alike', () => {
  const ctx = mkCtx();
  const S0 = A.startAccount(mkF(), ctx, T);
  const off = A.goOffline(S0, at(H), ctx.settings);
  const v = A.accountView(off, ctx, at(3 * H));
  const g = v.gathers[0];
  assert.equal(g.run.paused, true);
  assert.equal(g.run.actRemainingMs, 125 * M - H, 'collect-by minus the frozen moment, not minus the real time');
  assert.equal(g.run.status.elapsedMs, H);
  assert.equal(g.run.urgency, 'calm');
  const v2 = A.accountView(off, ctx, at(13 * H));
  assert.equal(v2.gathers[0].run.actRemainingMs, 125 * M - H);
  assert.equal(v2.stone.run.actRemainingMs, v.stone.run.actRemainingMs);
  assert.equal(v2.urgency, null, 'paused timers never raise urgency');
});

test('M2 session.ms24h is the last 24 h, ms7d the last 7 days (older sessions count for neither)', () => {
  const acc = Object.assign(mkF(), {
    onlineSessions: [
      { start: at(-10 * D), end: at(-10 * D + 2 * H) },     // outside both windows
      { start: at(-5 * D), end: at(-5 * D + 2 * H) },       // inside 7 days only
      { start: at(-H), end: null },                          // open: inside both
    ],
  });
  const v = A.accountView(acc, mkCtx(), T);
  assert.equal(v.session.ms24h, H);
  assert.equal(v.session.ms7d, 3 * H);
  assert.equal(v.session.currentMs, H);
});

test('M3 droppedAtStart is snapshotted by the run and used with the daily cap', () => {
  const acc = stoneOnly();
  acc.stone = Object.assign({}, acc.stone, { dailyCap: 200, droppedToday: 100 });
  assert.equal(A.makeStoneRun(acc, T).droppedAtStart, 100);
  const ctx = mkCtx();
  const S0 = A.startAccount(acc, ctx, T);
  assert.equal(S0.stoneRun.droppedAtStart, 100);
  const run = A.accountView(S0, ctx, T).stone.run;
  assert.equal(run.perChar[0].effectiveCapacity, 100);
  assert.equal(run.perChar[0].stopReason, 'daily-cap');
  // editing "dropped today" afterwards does not move the running timer (it keeps its snapshot)
  const edited = Object.assign({}, S0, { stone: Object.assign({}, S0.stone, { droppedToday: 0 }) });
  assert.equal(A.accountView(edited, ctx, T).stone.run.perChar[0].effectiveCapacity, 100);
});

test('M4 the card urgency is the worst of its timers, in both orders', () => {
  // gather "now" (collect-by 125 min passed) while the stone timer is only "soon"
  const a1 = mkF();
  a1.stone = Object.assign({}, a1.stone, { freeSlots: 10 });             // 30 stones = 180 min
  const c1 = mkCtx();
  const v1 = A.accountView(A.startAccount(a1, c1, T), c1, at(126 * M));
  assert.equal(v1.gathers[0].run.urgency, 'now');
  assert.equal(v1.stone.run.urgency, 'soon');
  assert.equal(v1.urgency, 'now');
  // stone "now" while the gather timer is only "soon"
  const a2 = mkF();
  a2.stone = Object.assign({}, a2.stone, { freeSlots: 21 });
  const c2 = mkCtx({ settings: Object.assign(DEF(), { stonesPerSlot: 1 }) });   // 21 stones = 126 min
  const v2 = A.accountView(A.startAccount(a2, c2, T), c2, at(115 * M));
  assert.equal(v2.stone.run.urgency, 'now');
  assert.equal(v2.gathers[0].run.urgency, 'soon');
  assert.equal(v2.urgency, 'now');
  // calm + soon -> soon; overdue beats everything
  const v3 = A.accountView(A.startAccount(a1, c1, T), c1, at(115 * M));      // gather soon (10 min to collect-by), stone calm (65 min left)
  assert.equal(v3.gathers[0].run.urgency, 'soon');
  assert.equal(v3.stone.run.urgency, 'calm');
  assert.equal(v3.urgency, 'soon');
  const v4 = A.accountView(A.startAccount(a1, c1, T), c1, at(181 * M));
  assert.equal(v4.urgency, 'overdue');
});

test('M5 urgency boundaries are inclusive: exactly warnMin / nowMin / soonMs remaining', () => {
  const full = 612 * M;
  assert.equal(A.stoneRunStatus(P(), at(full - 60 * M)).urgency, 'soon');
  assert.equal(A.stoneRunStatus(P(), at(full - 60 * M - 1)).urgency, 'calm');
  assert.equal(A.stoneRunStatus(P(), at(full - 15 * M)).urgency, 'now');
  assert.equal(A.stoneRunStatus(P(), at(full - 15 * M - 1)).urgency, 'soon');
  assert.equal(A.stoneRunStatus(P(), at(full - 1)).urgency, 'now');
  assert.equal(A.stoneRunStatus(P(), at(full)).urgency, 'overdue');
  // gather soonMs = min(30 min, max(10 min, 10% of the limit))
  const soonAt = (base, remainingBeforeCollect) => {
    const run = RUN({ baseMinutes: base });
    const st = A.gatherRunStatus(run, T);
    const t = st.collectBy - remainingBeforeCollect;
    return [A.gatherRunStatus(run, t).urgency, A.gatherRunStatus(run, t - 1).urgency];
  };
  assert.deepEqual(soonAt(135, 13.5 * M), ['soon', 'calm']);       // 10% of 135 = 13.5 min
  assert.deepEqual(soonAt(200, 20 * M), ['soon', 'calm']);         // 10% factor (a 20% factor would say 40 min)
  assert.deepEqual(soonAt(600, 30 * M), ['soon', 'calm']);         // capped at 30 min, not 60
  assert.deepEqual(soonAt(30, 10 * M), ['soon', 'calm']);          // floored at 10 min, not 3
  assert.equal(A.gatherRunStatus(RUN(), at(125 * M)).urgency, 'now');
  assert.equal(A.gatherRunStatus(RUN(), at(135 * M)).urgency, 'overdue');
});

test('M6 staleOpen: an open session is stale only after MORE than 48 h', () => {
  const open = (ms) => A.onlineStats([{ start: T - ms, end: null }], T, 7);
  assert.equal(open(30 * H).staleOpen, false);
  assert.equal(open(47 * H).staleOpen, false);
  assert.equal(open(48 * H).staleOpen, false);
  assert.equal(open(48 * H + 1).staleOpen, true);
  assert.equal(A.onlineStats([{ start: T - 30 * H, end: null }], T, 7, { maxOpenMs: 24 * H }).staleOpen, true);
  const acc = Object.assign(mkF(), { onlineSessions: [{ start: T - 48 * H - 1, end: null }] });
  assert.equal(A.accountView(acc, mkCtx(), T).session.staleOpen, true);
  assert.equal(A.accountView(Object.assign(mkF(), { onlineSessions: [{ start: T - 30 * H, end: null }] }), mkCtx(), T).session.staleOpen, false);
});

test('M7 suggestAdopt needs a >10% gap and enough confidence', () => {
  const spot = SPOT_KUDE();
  const list = [obs(10, 80), obs(9, 81), obs(11, 99)];            // calibrated 9.0, confidence 0.75
  const withManual = (m, l) => A.spotRate(Object.assign({}, spot, { manualRate: m }), l || list, T, null).calibration.suggestAdopt;
  assert.equal(withManual(10.35), true);                         // 15% above
  assert.equal(withManual(10.2), true);                          // 13% above
  assert.equal(withManual(9.8), false);                          // 8.9% above
  assert.equal(withManual(8.0), true);                           // 11% below
  assert.equal(withManual(8.3), false);                          // 7.8% below
  assert.equal(withManual(20, [obs(10, 80, 30)]), false);        // confidence 0.33 < 0.35
  assert.equal(withManual(20, [obs(10, 80, 15)]), true);         // enough weight (confidence 0.41)
  // confidence of exactly 0.35 is enough (>=): one record of 5.384615384615384 h at age 0
  const edge = [obs(5.384615384615384, 50)];
  assert.equal(A.spotRate(spot, edge, T, null).calibration.confidence, 0.35);
  assert.equal(withManual(20, edge), true);
});

test('M8 a running timer keeps the rate of the spot it started on, the plan shows the new spot', () => {
  const spots = [Object.assign(SPOT_KUDE(), { manualRate: 20 }), { id: 'longshu', name: '龍樹', defaultRate: 10, manualRate: 5 }];
  const ctx = mkCtx({ spots });
  const S0 = A.startAccount(stoneOnly(), ctx, T);
  assert.equal(S0.stoneRun.spotId, 'kude');
  const edited = Object.assign({}, S0, { stone: Object.assign({}, S0.stone, { spotId: 'longshu' }) });
  const v = A.accountView(edited, ctx, at(H));
  assert.equal(v.stone.run.ratePerHour, 20);
  assert.equal(v.stone.run.spotName, '庫德');
  assert.equal(v.stone.run.status.durationMs, Math.round(102 / 20 * H));
  assert.equal(v.stone.ratePerHour, 5);
  assert.equal(v.stone.spotName, '龍樹');
});

test('M9 startAccount judges the bag per character, not only by the account value', () => {
  const ctx = mkCtx();
  const a = stoneOnly();
  a.stone = Object.assign({}, a.stone, { freeSlots: 0 });
  a.characters[1] = Object.assign({}, a.characters[1], { freeSlots: 10 });
  const S0 = A.startAccount(a, ctx, T);
  assert.ok(S0.stoneRun, 'one character has room');
  assert.deepEqual(S0.stoneRun.freeSlotsAtStart, [0, 10, 0, 0, 0]);
  const b = stoneOnly();
  b.characters = b.characters.map((c) => Object.assign({}, c, { freeSlots: 0 }));
  assert.equal(A.startAccount(b, ctx, T).stoneRun, null, 'no character has room');
});

test('M10 quickPicks: ceil(topN/2) recent first, frequent by count, newer wins ties, zero counts are skipped', () => {
  const usage = { recent: ['a', 'b', 'c', 'd'].map((key, i) => ({ key, at: 100 - i })), freq: { a: 1, b: 5, c: 2, d: 9, e: 7 }, lastSpot: {} };
  assert.deepEqual(A.quickPicks(usage, 3).map((p) => p.key), ['a', 'b', 'd']);       // 2 recent, then the top frequent
  assert.deepEqual(A.quickPicks(usage, 1).map((p) => p.key), ['a']);
  assert.deepEqual(A.quickPicks(usage, 5).map((p) => p.key), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(A.quickPicks(usage, 3).map((p) => p.src), ['recent', 'recent', 'frequent']);
  const zero = { recent: [], freq: { a: 0, b: 2 }, lastSpot: {} };
  assert.deepEqual(A.quickPicks(zero, 4).map((p) => p.key), ['b']);
  const tie = { recent: [{ key: 'z', at: 50 }, { key: 'q', at: 40 }, { key: 'p', at: 10 }], freq: { p: 3, q: 3 }, lastSpot: {} };
  assert.deepEqual(A.quickPicks(tie, 2).map((p) => p.key), ['z', 'q'], 'the more recently picked one wins the tie');
  const tie2 = { recent: [], freq: { b: 3, a: 3 }, lastSpot: {} };
  assert.deepEqual(A.quickPicks(tie2, 2).map((p) => p.key), ['a', 'b'], 'then the key');
});

test('M11 calibrate boundaries: 0.5 h counts, an outlier is more than 3x (or less than 1/3) of the median', () => {
  const prior = { ratePerHour: 10, strengthHours: 10 };
  assert.equal(A.calibrate([{ hours: 0.5, stones: 5, at: T }], prior, T).usedCount, 1);
  assert.equal(A.calibrate([{ hours: 0.4999, stones: 5, at: T }], prior, T).usedCount, 0);
  const five = (x) => [90, 90, 90, 90, x].map((stones) => ({ hours: 10, stones, at: T }));
  assert.equal(A.calibrate(five(270), prior, T).usedCount, 5);       // exactly 3x the median 9/h: kept
  assert.equal(A.calibrate(five(271), prior, T).usedCount, 4);
  assert.equal(A.calibrate(five(30), prior, T).usedCount, 5);        // exactly 1/3: kept
  assert.equal(A.calibrate(five(29.9), prior, T).usedCount, 4);
});

test('M12 validateImport: exactly 2 MiB is accepted for parsing, one byte more is too-large', () => {
  const doc = (n) => JSON.stringify({ schema: 1, pad: 'x'.repeat(n) });
  const base = doc(0).length;
  const exact = doc(2097152 - base);
  assert.equal(exact.length, 2097152);
  assert.notEqual(A.validateImport(exact, T).code, 'too-large');
  assert.equal(A.validateImport(doc(2097152 - base + 1), T).code, 'too-large');
});

test('M13 detectClockJump: more than the tolerance ahead is a jump back', () => {
  assert.equal(A.detectClockJump(T + 120000, T), null);
  assert.equal(A.detectClockJump(T + 120001, T), 'back');
  assert.equal(A.detectClockJump(T + 5, T, 5), null);
  assert.equal(A.detectClockJump(T + 6, T, 5), 'back');
  assert.equal(A.detectClockJump(T - D, T), null);
  assert.equal(A.detectClockJump(NaN, T), null);
});

test('M14 fees are basis points: 12.5% and 0.01% are exact, stones are floored, durations round', () => {
  assert.equal(A.goldValue(100, 532, 12.5), 46550);
  assert.equal(A.goldValue(100, 532, 0.01), 53194);                  // 53200 * 9999 / 10000 = 53194.68
  assert.equal(A.netGoldPerHour(10, 532, 12.5, null).gross, 4655);
  assert.equal(A.goldValue(101.9, 532), 101 * 532);
  assert.equal(A.stoneRunStatus({ startedAt: T, freeSlots: 1, stonesPerSlot: 1, ratePerHour: 7 }, T).durationMs, 514286);   // 3,600,000 / 7 = 514,285.7
});

test('M15 the 999+ display starts at exactly 1000 hours', () => {
  assert.equal(A.formatDuration(1000 * H), '999+小時');
  assert.equal(A.formatDuration(1000 * H - 1), '999小時59分');
  assert.equal(A.formatCountdown(1000 * H), '999+時');
  assert.equal(A.formatCountdown(-1000 * H), '+999+時');
  assert.equal(A.formatCountdown(1000 * H - 1), '999時59分');
});

test('M16 a gather buffer larger than half the limit is cut to FLOOR(limit/2)', () => {
  const st = A.gatherRunStatus(RUN({ workHoursAtStart: 0.0000009, bufferMin: 10 }), T);      // limit = 3 ms
  assert.equal(st.fillMs, 3);
  assert.equal(st.stopReason, 'workhours');
  assert.equal(st.bufferMs, 1);
  assert.equal(st.bufferClamped, true);
  assert.equal(st.collectBy, T + 2);
});

// =====================================================================
// Net gold per hour: gold per MP (settings.mpGoldValue) x MP burned per hour
// =====================================================================
test('MPG1 mpGoldPerHour: MP/h x gold per MP; unknown on either side -> null; 0 gold per MP is a real value', () => {
  assert.equal(A.mpGoldPerHour(50, 0.2), 10);
  assert.equal(A.mpGoldPerHour(0, 0.2), 0);
  assert.equal(A.mpGoldPerHour(50, 0), 0);
  assert.equal(A.mpGoldPerHour(null, 0.2), null);
  assert.equal(A.mpGoldPerHour(50, null), null);
  assert.equal(A.mpGoldPerHour(undefined, undefined), null);
  assert.equal(A.mpGoldPerHour(-1, 0.2), null);
  assert.equal(A.mpGoldPerHour(50, -0.2), null);
  assert.equal(A.mpGoldPerHour('50', 0.2), null);
  assert.equal(A.mpGoldPerHour(NaN, 0.2), null);
  assert.equal(A.mpGoldPerHour(50, Infinity), null);
  assert.equal(A.mpGoldPerHour(Number.MAX_VALUE, 10), null);        // overflow must not become Infinity
});

test('MPG2 net gold per hour: 10 stones/h x 532 gross 5,320; 50 MP/h x 0.2 gold/MP = 10 gold/h -> net 5,310 and complete', () => {
  const cons = A.mpGoldPerHour(50, 0.2);
  const r = A.netGoldPerHour(10, 532, 0, cons);
  assert.deepEqual({ gross: r.gross, consumptionGold: r.consumptionGold, net: r.net, complete: r.complete }, { gross: 5320, consumptionGold: 10, net: 5310, complete: true });
  // a fee still applies to the gross side only
  const f = A.netGoldPerHour(10, 532, 20, A.mpGoldPerHour(500, 0.2));
  assert.deepEqual({ gross: f.gross, consumptionGold: f.consumptionGold, net: f.net, complete: f.complete }, { gross: 4256, consumptionGold: 100, net: 4156, complete: true });
  // no gold value -> not complete, net equals gross (the UI says 未計入消耗)
  const n = A.netGoldPerHour(10, 532, 0, A.mpGoldPerHour(50, null));
  assert.deepEqual({ gross: n.gross, consumptionGold: n.consumptionGold, net: n.net, complete: n.complete }, { gross: 5320, consumptionGold: null, net: 5320, complete: false });
  // consumption can exceed income: a negative net is reported, not clamped
  const neg = A.netGoldPerHour(1, 100, 0, A.mpGoldPerHour(1000, 1));
  assert.equal(neg.net, 100 - 1000);
});

test('MPG3 sanitizeState settings.mpGoldValue: default null, numeric strings coerced, bad values null, clamped, 4 decimals', () => {
  const v = (x) => A.sanitizeState({ schema: 1, settings: { mpGoldValue: x } }, T).state.settings.mpGoldValue;
  assert.equal(A.defaultSettings().mpGoldValue, null);
  assert.equal(v(undefined), null);
  assert.equal(v(null), null);
  assert.equal(v(''), null);
  assert.equal(v('abc'), null);
  assert.equal(v(-1), null);
  assert.equal(v(NaN), null);
  assert.equal(v(0), 0);
  assert.equal(v('0.2'), 0.2);
  assert.equal(v(0.2), 0.2);
  assert.equal(v(0.123456), 0.1235);
  assert.equal(v(99999), 10000);
  assert.equal(v(true), null);
  assert.equal(v({}), null);
});

test('MPG4 mpGoldValue survives export -> validateImport and a default state is still a fixed point', () => {
  const st = A.defaultState(T);
  st.settings.mpGoldValue = 0.25;
  const text = A.exportState(st, T, {});
  const back = A.validateImport(text, T + 1000);
  assert.equal(back.ok, true);
  assert.equal(back.state.settings.mpGoldValue, 0.25);
  const old = A.sanitizeState({ schema: 1, settings: { stonesPerSlot: 4 } }, T).state;      // a save from before the setting existed
  assert.equal(old.settings.mpGoldValue, null);
  assert.deepEqual(A.sanitizeState(A.defaultState(T), T).state, A.defaultState(T));
});

// =====================================================================
// v2 (2026-10-03): manual MP rate typed as "MP per 12 hours", blended with settled history
// =====================================================================
const MP17500 = 17500 / 12; // 1,458.333.../h, the default the user's "15k-20k per 12 h" midpoint gives

test('MPM1 constants and 12-hour conversion: 17,500 per 12 h is 1,458.33 per hour; bad input is null', () => {
  assert.deepEqual(A.MP_DEFAULTS, { per12h: 17500, priorHours: 10, maxPer12h: 1000000 });
  close(A.mpPerHourFrom12h(17500), MP17500, 1e-9);
  assert.equal(A.mpPerHourFrom12h(0), 0);
  close(A.mpPer12hFromHour(MP17500), 17500, 1e-9);
  for (const bad of [null, undefined, NaN, Infinity, -1, '17500', {}]) {
    assert.equal(A.mpPerHourFrom12h(bad), null, 'from12h ' + String(bad));
    assert.equal(A.mpPer12hFromHour(bad), null, 'fromHour ' + String(bad));
  }
});

test('MPM2 worked example: manual 17,500/12h + one record of 10 h / 12,000 MP, prior 10 h -> 1,329.17/h (blended)', () => {
  const r = A.mpEstimate([mpObs(10, 100, 12000)], T, { manualPerHour: MP17500 });
  close(r.mpPerHour, (10 * MP17500 + 12000) / 20, 1e-9);
  close(r.mpPerHour, 1329.1666667, 1e-6);
  assert.equal(r.source, 'blended');
  assert.equal(r.sampleCount, 1);
  close(r.effectiveSampleHours, 10, 1e-9);
  close(r.manualPerHour, MP17500, 1e-9);
  close(r.manualWeight, 0.5, 1e-9);
  assert.equal(r.priorHours, 10);
});

test('MPM3 manual only: the number is returned as-is; MP per stone comes from the spot rate (null when the rate is unknown)', () => {
  const r = A.mpEstimate([], T, { manualPerHour: MP17500, ratePerHour: 10 });
  assert.equal(r.source, 'manual');
  close(r.mpPerHour, MP17500, 1e-9);
  close(r.mpPerStone, MP17500 / 10, 1e-9);
  close(r.stonesPerKMp, 1000 / (MP17500 / 10), 1e-9);
  assert.equal(r.sampleCount, 0);
  assert.equal(r.effectiveSampleHours, 0);
  assert.equal(r.manualWeight, 1);
  const noRate = A.mpEstimate([], T, { manualPerHour: MP17500 });
  assert.equal(noRate.source, 'manual');
  close(noRate.mpPerHour, MP17500, 1e-9);
  assert.equal(noRate.mpPerStone, null);
  assert.equal(noRate.stonesPerKMp, null);
  assert.equal(A.mpEstimate([], T, { manualPerHour: MP17500, ratePerHour: 0 }).mpPerStone, null, 'a zero rate is no rate');
});

test('MPM4 data only: identical to mpStats, source "data", no manual', () => {
  const recs = [mpObs(10, 85, 500), mpObs(5, 40, 200)];
  const base = A.mpStats(recs, T);
  const r = A.mpEstimate(recs, T, {});
  assert.equal(r.source, 'data');
  assert.equal(r.mpPerHour, base.mpPerHour);
  assert.equal(r.mpPerStone, base.mpPerStone);
  assert.equal(r.stonesPerKMp, base.stonesPerKMp);
  assert.equal(r.sampleCount, 2);
  assert.equal(r.manualPerHour, null);
  assert.equal(r.manualWeight, null);
  close(r.effectiveSampleHours, 15, 1e-9);
  // the spot rate is ignored when there is no manual number
  assert.equal(A.mpEstimate(recs, T, { ratePerHour: 99 }).mpPerStone, base.mpPerStone);
});

test('MPM5 nothing at all: every number is null and the source is "none"', () => {
  const r = A.mpEstimate([], T, {});
  assert.deepEqual(r, { mpPerHour: null, mpPerStone: null, stonesPerKMp: null, sampleCount: 0, source: 'none', manualPerHour: null, effectiveSampleHours: 0, manualWeight: null, priorHours: 0 });
  assert.deepEqual(A.mpEstimate(undefined, undefined, undefined), r);
});

test('MPM6 blended MP per stone: the prior counts as 10 hours at the spot rate; without a rate only the records speak', () => {
  const rec = [mpObs(10, 100, 12000)];
  const withRate = A.mpEstimate(rec, T, { manualPerHour: MP17500, ratePerHour: 10 });
  close(withRate.mpPerStone, (10 * MP17500 + 12000) / (10 * 10 + 100), 1e-9);
  close(withRate.stonesPerKMp, 1000 / withRate.mpPerStone, 1e-9);
  const noRate = A.mpEstimate(rec, T, { manualPerHour: MP17500 });
  close(noRate.mpPerStone, 120, 1e-9);
  // records without stones still move MP/hour but leave MP/stone at the prior
  const zero = A.mpEstimate([mpObs(10, 0, 12000)], T, { manualPerHour: MP17500, ratePerHour: 10 });
  close(zero.mpPerHour, (10 * MP17500 + 12000) / 20, 1e-9);
  close(zero.mpPerStone, MP17500 / 10, 1e-9);
});

test('MPM7 history gradually takes over: more hours of data pull the estimate toward it; old records count less', () => {
  const at100h = A.mpEstimate([mpObs(100, 1000, 100000)], T, { manualPerHour: MP17500 });
  close(at100h.mpPerHour, (10 * MP17500 + 100000) / 110, 1e-9);
  assert.ok(at100h.mpPerHour < MP17500 && at100h.mpPerHour > 1000);
  close(at100h.manualWeight, 10 / 110, 1e-9);
  // monotone: the weight of the manual number only falls as data grows
  let last = 1;
  for (const h of [1, 5, 10, 20, 50, 200]) {
    const w = A.mpEstimate([mpObs(h, h * 10, h * 1000)], T, { manualPerHour: MP17500 }).manualWeight;
    assert.ok(w < last, 'weight falls at ' + h + ' h');
    last = w;
  }
  // a 30-day-old record counts half (30-day half-life)
  const old = A.mpEstimate([mpObs(10, 100, 12000, 30)], T, { manualPerHour: MP17500 });
  close(old.effectiveSampleHours, 5, 1e-9);
  close(old.mpPerHour, (10 * MP17500 + 6000) / 15, 1e-9);
  const custom = A.mpEstimate([mpObs(10, 100, 12000, 60)], T, { manualPerHour: MP17500, halfLifeDays: 60 });
  close(custom.effectiveSampleHours, 5, 1e-9);
});

test('MPM8 priorHours option: 0 means pure history, a large value keeps the manual number in charge', () => {
  const rec = [mpObs(10, 100, 12000)];
  const pure = A.mpEstimate(rec, T, { manualPerHour: MP17500, priorHours: 0 });
  assert.equal(pure.source, 'data');
  close(pure.mpPerHour, 1200, 1e-9);
  assert.equal(pure.manualWeight, 0);
  const heavy = A.mpEstimate(rec, T, { manualPerHour: MP17500, priorHours: 90 });
  close(heavy.mpPerHour, (90 * MP17500 + 12000) / 100, 1e-9);
  // priorHours 0 and no records: the manual number is still returned
  const lone = A.mpEstimate([], T, { manualPerHour: MP17500, priorHours: 0, ratePerHour: 10 });
  assert.equal(lone.source, 'manual');
  close(lone.mpPerHour, MP17500, 1e-9);
  close(lone.mpPerStone, MP17500 / 10, 1e-9);
  // nonsense falls back to the default 10 hours
  close(A.mpEstimate(rec, T, { manualPerHour: MP17500, priorHours: -5 }).mpPerHour, 1329.1666667, 1e-6);
  close(A.mpEstimate(rec, T, { manualPerHour: MP17500, priorHours: NaN }).mpPerHour, 1329.1666667, 1e-6);
});

test('MPM9 excluded and malformed records are skipped; a manual 0 is a real value; a negative or NaN manual is no manual', () => {
  const recs = [mpObs(10, 100, 12000, 0, { excluded: true }), { hours: -1, consumption: { amount: 5 } }, { hours: 5 }, null, mpObs(10, 100, 12000)];
  const r = A.mpEstimate(recs, T, { manualPerHour: MP17500 });
  assert.equal(r.sampleCount, 1);
  close(r.mpPerHour, 1329.1666667, 1e-6);
  const zero = A.mpEstimate([], T, { manualPerHour: 0, ratePerHour: 10 });
  assert.equal(zero.source, 'manual');
  assert.equal(zero.mpPerHour, 0);
  assert.equal(zero.mpPerStone, 0);
  assert.equal(zero.stonesPerKMp, null, '0 MP per stone has no stones-per-1000-MP');
  for (const bad of [-5, NaN, Infinity, null, undefined, '1000']) {
    const x = A.mpEstimate([], T, { manualPerHour: bad });
    assert.equal(x.source, 'none', String(bad));
    assert.equal(x.mpPerHour, null);
  }
});

test('MPM10 mpStats keeps its old shape; only an explicit manualPerHour option returns the extended one; mpForRun accepts both', () => {
  const recs = [mpObs(10, 85, 500), mpObs(5, 40, 200)];
  assert.deepEqual(Object.keys(A.mpStats(recs, T)).sort(), ['mpPerHour', 'mpPerStone', 'sampleCount', 'stonesPerKMp']);
  assert.deepEqual(Object.keys(A.mpStats(recs, T, { halfLifeDays: 10 })).sort(), ['mpPerHour', 'mpPerStone', 'sampleCount', 'stonesPerKMp']);
  const ext = A.mpStats(recs, T, { manualPerHour: MP17500, ratePerHour: 8.5 });
  assert.equal(ext.source, 'blended');
  assert.deepEqual(ext, A.mpEstimate(recs, T, { manualPerHour: MP17500, ratePerHour: 8.5 }));
  const need = A.mpForRun(ext, { hoursRemaining: 10, stonesRemaining: 100 });
  close(need.forTime, ext.mpPerHour * 10, 1e-9);
  close(need.forStones, ext.mpPerStone * 100, 1e-9);
});

test('MPM11 mpForAccount: one character and the whole account (x characters, at least 1)', () => {
  const est = A.mpEstimate([], T, { manualPerHour: MP17500, ratePerHour: 10 });
  const r = A.mpForAccount(est, { hoursRemaining: 10.2, stonesRemaining: 102 }, 5);
  assert.equal(r.characters, 5);
  close(r.perChar.forTime, MP17500 * 10.2, 1e-6);
  close(r.perChar.forTime, 14875, 1e-6);
  close(r.perChar.forStones, 14875, 1e-6);
  close(r.total.forTime, 74375, 1e-6);
  close(r.total.forStones, 74375, 1e-6);
  assert.equal(A.mpForAccount(est, { hoursRemaining: 1 }, 0).characters, 1);
  assert.equal(A.mpForAccount(est, { hoursRemaining: 1 }, NaN).characters, 1);
  assert.equal(A.mpForAccount(est, { hoursRemaining: 1 }, 2.9).characters, 2);
  const none = A.mpForAccount(A.mpEstimate([], T, {}), { hoursRemaining: 5, stonesRemaining: 50 }, 5);
  assert.deepEqual(none.perChar, { forTime: null, forStones: null });
  assert.deepEqual(none.total, { forTime: null, forStones: null });
  assert.deepEqual(A.mpForAccount(undefined, undefined, undefined).total, { forTime: null, forStones: null });
});

test('MPM12 mpSourceLabel says where the number comes from', () => {
  assert.equal(A.mpSourceLabel(A.mpEstimate([], T, { manualPerHour: 1000 })), '你的設定');
  assert.equal(A.mpSourceLabel(A.mpEstimate([mpObs(5, 40, 200), mpObs(5, 40, 200)], T, {})), '依 2 筆紀錄校準');
  assert.equal(A.mpSourceLabel(A.mpEstimate([mpObs(5, 40, 200)], T, { manualPerHour: 1000 })), '依 1 筆紀錄校準（含你的設定）');
  assert.equal(A.mpSourceLabel(A.mpEstimate([], T, {})), '尚無數字');
  assert.equal(A.mpSourceLabel(undefined), '尚無數字');
});

test('MPM13 absurd records never leak Infinity/NaN: overflowing sums count as no data, a tiny MP per stone has no stones-per-1000-MP', () => {
  const huge = [mpObs(Number.MAX_VALUE, 10, 5), mpObs(Number.MAX_VALUE, 10, 5)];
  for (const r of [A.mpEstimate(huge, T, { manualPerHour: MP17500, ratePerHour: 10 }), A.mpStats(huge, T), A.mpEstimate(huge, T, {})]) assertFiniteDeep(r);
  const withManual = A.mpEstimate(huge, T, { manualPerHour: MP17500, ratePerHour: 10 });
  assert.equal(withManual.source, 'manual', 'unusable history falls back to the manual number');
  close(withManual.mpPerHour, MP17500, 1e-9);
  assert.equal(withManual.effectiveSampleHours, 0);
  const noManual = A.mpEstimate(huge, T, {});
  assert.equal(noManual.source, 'none');
  assert.equal(noManual.mpPerHour, null);
  const tiny = A.mpEstimate([mpObs(10, 1e300, 1e-300)], T, {});
  assertFiniteDeep(tiny);
  assert.equal(tiny.stonesPerKMp, null);
  assertFiniteDeep(A.mpStats([mpObs(10, 1e300, 1e-300)], T));
  // a manual number above the believable range is not used
  assert.equal(A.mpEstimate([], T, { manualPerHour: 1e12 }).source, 'none');
  assert.equal(A.mpEstimate([], T, { manualPerHour: Number.MAX_VALUE, ratePerHour: 10 }).mpPerHour, null);
});

// ---------- entry scope: the user may type a per-character or a whole-account number ----------
test('MPS1 entry scope: 15,000 per account / 5 characters = 3,000 per character; per-character entries pass through', () => {
  assert.equal(A.mpPerCharFromEntry(15000, 'account', 5), 3000);
  assert.equal(A.mpPerCharFromEntry(15000, 'char', 5), 15000);
  assert.equal(A.mpPerCharFromEntry(15000, undefined, 5), 15000, 'default scope is per character');
  assert.equal(A.mpPerCharFromEntry(15000, 'bogus', 5), 15000);
  assert.equal(A.mpPerCharFromEntry(15000, 'account', 0), 15000, 'at least one character');
  assert.equal(A.mpPerCharFromEntry(15000, 'account', -3), 15000);
  assert.equal(A.mpPerCharFromEntry(15000, 'account', NaN), 15000);
  assert.equal(A.mpPerCharFromEntry(15000, 'account', 1), 15000);
  assert.equal(A.mpPerCharFromEntry(15000, 'account', 2.9), 7500, 'character count is floored');
  assert.equal(A.mpPerCharFromEntry(0, 'account', 5), 0);
  assert.equal(A.mpPerCharFromEntry(17500, 'account', 3), 5833.3333, 'kept to 4 decimals');
  for (const bad of [null, undefined, NaN, Infinity, -1, '15000', {}]) assert.equal(A.mpPerCharFromEntry(bad, 'account', 5), null, String(bad));
  assert.equal(A.mpPerCharFromEntry(9e9, 'char', 5), 1000000, 'clamped to the limit');
  assert.equal(A.mpPerCharFromEntry(9e9, 'account', 5), 1000000);
});

test('MPS2 mpEntryFromPerChar is the inverse the edit sheet needs to show a stored value in the chosen scope', () => {
  assert.equal(A.mpEntryFromPerChar(3000, 'account', 5), 15000);
  assert.equal(A.mpEntryFromPerChar(3000, 'char', 5), 3000);
  assert.equal(A.mpEntryFromPerChar(3000, undefined, 5), 3000);
  assert.equal(A.mpEntryFromPerChar(3000, 'account', 0), 3000);
  assert.equal(A.mpEntryFromPerChar(null, 'account', 5), null);
  assert.equal(A.mpEntryFromPerChar(NaN, 'char', 5), null);
  // 17,500 split over 3 characters shows 17,500 again, not 17,499.99
  assert.equal(A.mpEntryFromPerChar(A.mpPerCharFromEntry(17500, 'account', 3), 'account', 3), 17500);
});

// ---------- settings.mpPer12h and account.stone.mpPer12hOverride ----------
test('MPC1 defaults: settings.mpPer12h is 17,500 and a sanitized account has mpPer12hOverride null', () => {
  assert.equal(A.defaultSettings().mpPer12h, 17500);
  assert.equal(A.defaultState(T).settings.mpPer12h, 17500);
  const s = A.sanitizeState({ schema: 1, accounts: [{ id: 'a_abcdef', label: 'x' }] }, T).state;
  assert.equal(s.settings.mpPer12h, 17500);
  assert.equal(s.accounts[0].stone.mpPer12hOverride, null);
});

test('MPC2 settings.mpPer12h sanitizing: cleared stays cleared, garbage -> default, limits 0..1,000,000, numeric strings, 4 decimals', () => {
  const v = (x) => A.sanitizeState({ schema: 1, settings: { mpPer12h: x } }, T).state.settings.mpPer12h;
  assert.equal(v(undefined), 17500, 'old save without the field');
  assert.equal(v(null), null, 'the user cleared it');
  assert.equal(v(''), null);
  assert.equal(v('   '), null);
  assert.equal(v(20000), 20000);
  assert.equal(v('15000'), 15000);
  assert.equal(v(0), 0, '0 is a real value');
  assert.equal(v(-1), 17500);
  assert.equal(v('abc'), 17500);
  assert.equal(v(NaN), 17500);
  assert.equal(v({}), 17500);
  assert.equal(v(true), 17500);
  assert.equal(v(5e6), 1000000);
  assert.equal(v(1234.56789), 1234.5679);
});

test('MPC3 account.stone.mpPer12hOverride sanitizing: null/garbage/negative -> null, limits, strings, 4 decimals', () => {
  const v = (x) => A.sanitizeState({ schema: 1, accounts: [{ id: 'a_abcdef', label: 'x', stone: { mpPer12hOverride: x } }] }, T).state.accounts[0].stone.mpPer12hOverride;
  assert.equal(v(undefined), null);
  assert.equal(v(null), null);
  assert.equal(v(''), null);
  assert.equal(v('abc'), null);
  assert.equal(v(-5), null);
  assert.equal(v(NaN), null);
  assert.equal(v(15000), 15000);
  assert.equal(v('18000'), 18000);
  assert.equal(v(0), 0);
  assert.equal(v(2e6), 1000000);
  assert.equal(v(5833.333333), 5833.3333);
});

test('MPC4 resolveMpManual: the account value outranks the setting; null falls through; per HOUR, per character', () => {
  const acc = (ov) => ({ id: 'a_1', stone: { mpPer12hOverride: ov } });
  close(A.resolveMpManual({ mpPer12h: 17500 }, acc(null)), 17500 / 12, 1e-9);
  close(A.resolveMpManual({ mpPer12h: 17500 }, acc(24000)), 2000, 1e-9);
  close(A.resolveMpManual({ mpPer12h: null }, acc(24000)), 2000, 1e-9);
  assert.equal(A.resolveMpManual({ mpPer12h: null }, acc(null)), null, 'nothing set anywhere');
  assert.equal(A.resolveMpManual({ mpPer12h: 17500 }, acc(0)), 0, 'an override of 0 still outranks');
  close(A.resolveMpManual({ mpPer12h: 17500 }, { id: 'a_1' }), 17500 / 12, 1e-9, 'account without a stone plan');
  close(A.resolveMpManual({ mpPer12h: 17500 }, null), 17500 / 12, 1e-9);
  close(A.resolveMpManual({}, acc(undefined)), 17500 / 12, 1e-9, 'a missing setting means the default');
  close(A.resolveMpManual(undefined, undefined), 17500 / 12, 1e-9);
  assert.equal(A.resolveMpManual({ mpPer12h: -4 }, acc(-9)), 17500 / 12, 'invalid values fall back to the default');
  assert.equal(A.resolveMpManual({ mpPer12h: 'x' }, acc('y')), 17500 / 12);
});

test('MPC5 old saves (no MP fields) load unchanged apart from the new defaults; schema stays 1; export -> import keeps the new values', () => {
  const old = {
    schema: 1, rev: 7, savedAt: T - H,
    settings: { stonesPerSlot: 3, stoneUnitPrice: 532, mpGoldValue: 0.2 },
    accounts: [{
      id: 'a_acc001', label: '主帳', accountId: 'login1', note: '', createdAt: T - D, onlineSessions: [{ start: T - H, end: null }],
      stone: { spotId: 'kude', freeSlots: 34, rateOverride: 12, dailyCap: null, droppedToday: 0 },
      stoneRun: null, characters: [{ id: 'c_char01', name: 'A', level: 5, freeSlots: null, gather: null, gatherRun: null }],
    }],
  };
  const raw = JSON.stringify(old);
  const l = A.loadState(raw, T);
  assert.equal(l.status, 'ok');
  assert.equal(l.dropped, 0);
  assert.equal(l.state.schema, 1);
  assert.equal(l.state.rev, 7);
  assert.equal(l.state.settings.mpPer12h, 17500);
  assert.equal(l.state.settings.mpGoldValue, 0.2);
  assert.equal(l.state.accounts[0].stone.mpPer12hOverride, null);
  assert.equal(l.state.accounts[0].stone.rateOverride, 12);
  assert.equal(l.state.accounts[0].characters[0].name, 'A');
  const st = l.state;
  st.settings.mpPer12h = 20000;
  st.accounts[0].stone.mpPer12hOverride = 15000;
  const back = A.validateImport(A.exportState(st, T, {}), T + 1000);
  assert.equal(back.ok, true);
  assert.equal(back.state.settings.mpPer12h, 20000);
  assert.equal(back.state.accounts[0].stone.mpPer12hOverride, 15000);
  assert.deepEqual(A.sanitizeState(back.state, T + 1000).state, back.state, 'still a fixed point');
  assert.equal(A.validateImport({ schema: 1, settings: { mpPer12h: null } }, T).state.settings.mpPer12h, null, 'a settings-only import keeps a cleared value');
});

// ---------- accountView.mp ----------
test('MPV1 accountView.mp, manual only: 5 characters, 34 slots, 17,500 per 12 h -> 1,458/h, 14,875 per character, 74,375 for the account', () => {
  const ctx = mkCtx();
  const S = A.startAccount(stoneOnly(), ctx, T);
  const mp = A.accountView(S, ctx, T).mp;
  assert.equal(mp.source, 'manual');
  assert.equal(mp.manualSource, 'setting');
  close(mp.manualPerHour, MP17500, 1e-9);
  close(mp.manualPer12h, 17500, 1e-9);
  close(mp.mpPerHour, MP17500, 1e-9);
  close(mp.mpPer12h, 17500, 1e-9);
  close(mp.mpPerStone, MP17500 / 10, 1e-9);
  assert.equal(mp.sampleCount, 0);
  assert.equal(mp.characters, 5);
  close(mp.accountPerHour, MP17500 * 5, 1e-9);
  close(mp.accountPer12h, 87500, 1e-6, 'the card prints this as "整個帳號 5 位：每 12 小時約 …"');
  assert.equal(mp.needMode, 'to-full');
  close(mp.needPerChar.forTime, 14875, 1e-6);
  close(mp.needPerChar.forStones, 14875, 1e-6);
  close(mp.needTotal.forTime, 74375, 1e-6);
  close(mp.needTotal.forStones, 74375, 1e-6);
  // halfway through the bag, half the MP is still needed
  const half = A.accountView(S, ctx, at(5.1 * H)).mp;
  close(half.needPerChar.forTime, 7437.5, 1e-3);
  close(half.needPerChar.forStones, 7437.5, 1e-3);
  close(half.needTotal.forTime, 37187.5, 1e-3);
  // before a run exists it is the cost of one full round
  const plan = A.accountView(stoneOnly(), ctx, T).mp;
  assert.equal(plan.needMode, 'round');
  close(plan.needPerChar.forTime, 14875, 1e-6);
  close(plan.needTotal.forTime, 74375, 1e-6);
});

test('MPV2 an account override outranks the setting and says so', () => {
  const ctx = mkCtx();
  const a = stoneOnly();
  a.stone.mpPer12hOverride = 24000;
  const mp = A.accountView(a, ctx, T).mp;
  assert.equal(mp.manualSource, 'account');
  close(mp.manualPerHour, 2000, 1e-9);
  close(mp.mpPerHour, 2000, 1e-9);
  close(mp.needPerChar.forTime, 2000 * 10.2, 1e-6);
});

test('MPV3 nothing set and no records: the view says so (the page then shows a link to the input)', () => {
  const ctx = mkCtx();
  ctx.settings.mpPer12h = null;
  const mp = A.accountView(stoneOnly(), ctx, T).mp;
  assert.equal(mp.source, 'none');
  assert.equal(mp.manualSource, null);
  assert.equal(mp.manualPerHour, null);
  assert.equal(mp.mpPerHour, null);
  assert.equal(mp.mpPer12h, null);
  assert.equal(mp.mpPerStone, null);
  assert.equal(mp.accountPerHour, null);
  assert.equal(mp.accountPer12h, null);
  assert.deepEqual(mp.needPerChar, { forTime: null, forStones: null });
  assert.deepEqual(mp.needTotal, { forTime: null, forStones: null });
  // records alone still work
  const withData = mkCtx({ observations: [mpObs(10, 100, 12000)] });
  withData.settings.mpPer12h = null;
  const d = A.accountView(stoneOnly(), withData, T).mp;
  assert.equal(d.source, 'data');
  close(d.mpPerHour, 1200, 1e-9);
  close(d.mpPer12h, 14400, 1e-9);
});

test('MPV4 history blends into the view: this spot only, excluded records ignored', () => {
  const ctx = mkCtx({ observations: [mpObs(10, 100, 12000), mpObs(10, 100, 99999, 0, { excluded: true }), mpObs(10, 100, 99999, 0, { spotId: 'longshu' })] });
  const mp = A.accountView(stoneOnly(), ctx, T).mp;
  assert.equal(mp.source, 'blended');
  assert.equal(mp.sampleCount, 1);
  close(mp.mpPerHour, 1329.1666667, 1e-6);
  close(mp.mpPerStone, (10 * MP17500 + 12000) / (10 * 10 + 100), 1e-9);
  close(mp.needPerChar.forTime, 1329.1666667 * 10.2, 1e-5);
  assert.equal(A.mpSourceLabel(mp), '依 1 筆紀錄校準（含你的設定）');
});

test('MPV5 characters that cannot mine are not counted; no characters or no spot never produce NaN', () => {
  const ctx = mkCtx();
  const a = stoneOnly();
  a.characters[3].freeSlots = 0;
  a.characters[4].freeSlots = 0;
  const mp = A.accountView(a, ctx, T).mp;
  assert.equal(mp.characters, 3);
  close(mp.accountPer12h, 52500, 1e-6, '3 miners at 17,500 per 12 h');
  close(mp.needTotal.forTime, 3 * 14875, 1e-6);
  close(mp.needPerChar.forTime, 14875, 1e-6);
  for (const odd of [{ id: 'a_x', label: 'x' }, mkF({ characters: [] }), mkF({ stone: { spotId: null, freeSlots: 34 } })]) {
    const v = A.accountView(odd, ctx, T);
    assertFiniteDeep(v.mp);
    assert.equal(v.mp.characters, 0);
    assert.deepEqual(v.mp.needTotal, { forTime: null, forStones: null });
  }
});

// =====================================================================
// v2: one gather box per account (characters gathering the same thing at the same time are one group)
// =====================================================================
const IRON = () => Object.assign(COPPER(), { itemKey: 'mine/鐵', itemName: '鐵', baseMinutes: 120 });
const mk5 = (over) => { const a = mkF(over); a.characters.forEach((c) => { c.gather = COPPER(); }); return a; };
const started5 = (ctx = mkCtx()) => A.startAccount(mk5(), ctx, T);
const gviewOf = (acc, ms, ctx = mkCtx()) => A.accountView(acc, ctx, at(ms));
const withRun = (acc, idx, fn) => Object.assign({}, acc, { characters: acc.characters.map((c, i) => (i === idx ? Object.assign({}, c, { gatherRun: fn(c.gatherRun) }) : c)) });

test('GG1 five identical characters -> ONE group x5; the per-character list is still there', () => {
  const v = gviewOf(started5(), 10 * M);
  assert.equal(v.gatherGroups.length, 1);
  const g = v.gatherGroups[0];
  assert.equal(g.count, 5);
  assert.deepEqual(g.members, [0, 1, 2, 3, 4]);
  assert.deepEqual(g.memberIds, ['c_1', 'c_2', 'c_3', 'c_4', 'c_5']);
  assert.deepEqual(g.charNames, ['角色1', '角色2', '角色3', '角色4', '角色5']);
  assert.equal(g.all, true);
  assert.equal(g.hasRun, true);
  assert.equal(g.itemName, '銅');
  assert.equal(g.category, 'mine');
  assert.equal(g.plan.itemKey, 'mine/銅');
  assert.equal(g.run.state, 'running');
  assert.equal(g.status.state, 'running');
  assert.equal(g.status.fullAt, T + 135 * M);
  assert.equal(g.status.collectBy, T + 125 * M);
  assert.equal(g.urgency, 'calm');
  assert.equal(g.paused, false);
  assert.equal(g.charIndex, 0);
  assert.equal(g.charId, 'c_1');
  assert.equal(g.charName, '角色1');
  assert.equal(v.characterCount, 5);
  assert.equal(v.gathers.length, 5, 'view.gathers stays per character');
  v.gathers.forEach((x) => { assert.equal(x.groupKey, g.key); assert.equal(x.groupCount, 5); });
  assertFiniteDeep(v);
});

test('GG2 four identical + one different item -> 2 groups (4 and 1), ordered by first member', () => {
  const a = mk5();
  a.characters[4].gather = IRON();
  const v = gviewOf(A.startAccount(a, mkCtx(), T), 10 * M);
  assert.deepEqual(v.gatherGroups.map((g) => g.count), [4, 1]);
  assert.deepEqual(v.gatherGroups.map((g) => g.members), [[0, 1, 2, 3], [4]]);
  assert.deepEqual(v.gatherGroups.map((g) => g.itemName), ['銅', '鐵']);
  assert.deepEqual(v.gatherGroups.map((g) => g.all), [false, false]);
  assert.notEqual(v.gatherGroups[0].key, v.gatherGroups[1].key);
  assert.equal(v.gatherGroups[1].status.fullAt, T + 120 * M);
  // one differing number of the plan is enough (speed, slots, buffer, minutes)
  for (const patch of [{ speed: 1.5 }, { slots: 6 }, { bufferMin: 20 }, { baseMinutes: 130 }, { spotKey: 'p:y' }, { workHoursAtStart: 1 }]) {
    const b = mk5();
    b.characters[2].gather = Object.assign(COPPER(), patch);
    assert.deepEqual(gviewOf(A.startAccount(b, mkCtx(), T), M).gatherGroups.map((g) => g.count), [4, 1], JSON.stringify(patch));
  }
});

test('GG3 the same item started at different times -> separate groups', () => {
  const S = started5();
  const later = withRun(S, 4, () => A.restartCharGather(S.characters[4], at(10 * M)).gatherRun);
  const v = gviewOf(later, 20 * M);
  assert.deepEqual(v.gatherGroups.map((g) => g.count), [4, 1]);
  assert.equal(v.gatherGroups[1].status.fullAt, T + 145 * M);
  assert.equal(v.gatherGroups[0].status.fullAt, T + 135 * M);
});

test('GG4 paused vs running -> separate groups; a paused group is frozen and flagged', () => {
  const S = started5();
  const p = withRun(S, 2, (r) => A.pauseRun(r, at(30 * M)));
  const v = gviewOf(p, 60 * M);
  assert.deepEqual(v.gatherGroups.map((g) => g.members), [[0, 1, 3, 4], [2]]);
  assert.deepEqual(v.gatherGroups.map((g) => g.paused), [false, true]);
  assert.equal(v.gatherGroups[1].run.paused, true);
  assert.equal(v.gatherGroups[1].status.elapsedMs, 30 * M, 'frozen at pausedAt');
  assert.equal(v.gatherGroups[0].status.elapsedMs, 60 * M);
  // two members paused at the same moment stay together
  const both = withRun(withRun(S, 3, (r) => A.pauseRun(r, at(30 * M))), 4, (r) => A.pauseRun(r, at(30 * M)));
  assert.deepEqual(gviewOf(both, 60 * M).gatherGroups.map((g) => g.members), [[0, 1, 2], [3, 4]]);
  // paused at different moments do not
  const diff = withRun(withRun(S, 3, (r) => A.pauseRun(r, at(30 * M))), 4, (r) => A.pauseRun(r, at(31 * M)));
  assert.deepEqual(gviewOf(diff, 60 * M).gatherGroups.map((g) => g.members), [[0, 1, 2], [3], [4]]);
});

test('GG5 zero gathers: no groups; an account with no characters is fine', () => {
  const v = gviewOf(A.startAccount(stoneOnly(), mkCtx(), T), M);
  assert.deepEqual(v.gatherGroups, []);
  assert.deepEqual(v.gathers, []);
  assert.deepEqual(gviewOf(mkF({ characters: [] }), M).gatherGroups, []);
  assert.deepEqual(A.groupGathers([]), []);
  assert.deepEqual(A.gatherGroupsOf(stoneOnly()), []);
  // a character without any gather is simply not in a group
  const a = mk5();
  a.characters[1].gather = null;
  const g = gviewOf(A.startAccount(a, mkCtx(), T), M).gatherGroups;
  assert.deepEqual(g.map((x) => x.members), [[0, 2, 3, 4]]);
  assert.equal(g[0].all, false);
});

test('GG6 plans that are not running yet are grouped by plan; a started character splits off', () => {
  const v = gviewOf(mk5(), M);
  assert.equal(v.gatherGroups.length, 1);
  const g = v.gatherGroups[0];
  assert.equal(g.count, 5);
  assert.equal(g.hasRun, false);
  assert.equal(g.run, null);
  assert.equal(g.status, null);
  assert.equal(g.urgency, null);
  assert.equal(g.paused, false);
  assert.equal(g.plan.itemKey, 'mine/銅');
  assert.equal(g.planStatus.state, 'running', 'the preview of the plan');
  assert.ok(g.key.indexOf(':g:plan:') > 0);
  const a = mk5();
  a.characters[0].gatherRun = Object.assign(COPPER(), { startedAt: T, pausedAt: null, lastDepositAt: null, fired: { now: false, overdue: false } });
  assert.deepEqual(gviewOf(a, M).gatherGroups.map((x) => [x.count, x.hasRun]), [[1, true], [4, false]]);
});

test('GG7 group urgency: calm -> soon -> now -> overdue for the whole group at once, also long after (stale)', () => {
  const S = started5();
  const seen = [[95, 'calm'], [112, 'soon'], [125, 'now'], [134, 'now'], [140, 'overdue']].map(([m, u]) => [u, gviewOf(S, m * M).gatherGroups[0].urgency]);
  assert.deepEqual(seen, [['calm', 'calm'], ['soon', 'soon'], ['now', 'now'], ['now', 'now'], ['overdue', 'overdue']]);
  const stale = gviewOf(S, 3 * 24 * 60 * M);
  assert.equal(stale.gatherGroups[0].urgency, 'overdue');
  assert.equal(stale.urgency, 'overdue');
  assert.ok(stale.gatherGroups[0].run.actRemainingMs < 0);
  // a late group does not hide an on-time one: each keeps its own urgency, the card shows the worst
  const a = mk5();
  a.characters[4].gather = IRON();
  const SS = A.startAccount(a, mkCtx(), T);
  const w = gviewOf(SS, 115 * M); // copper: 10 min before collect-by (soon); iron (120 min fill): past its collect-by (now)
  assert.deepEqual(w.gatherGroups.map((g) => g.urgency), ['soon', 'now']);
  assert.equal(w.urgency, 'now');
});

test('GG8 group keys: stable across ticks and round trips, different per plan / start / account, safe characters only', () => {
  const S = started5();
  const k1 = gviewOf(S, 1 * M).gatherGroups[0].key;
  assert.equal(gviewOf(S, 50 * M).gatherGroups[0].key, k1, 'does not change while the timer runs');
  assert.equal(gviewOf(JSON.parse(JSON.stringify(S)), 50 * M).gatherGroups[0].key, k1, 'does not depend on object identity');
  assert.match(k1, /^a_1:g:\d+:[0-9a-f]{16}$/);
  assert.ok(k1.startsWith('a_1:g:' + T + ':'));
  const other = A.startAccount(mk5({ id: 'a_2', label: '副帳' }), mkCtx(), T);
  assert.ok(gviewOf(other, M).gatherGroups[0].key.startsWith('a_2:g:'));
  assert.notEqual(gviewOf(other, M).gatherGroups[0].key, k1);
  assert.notEqual(gviewOf(A.startAccount(mk5(), mkCtx(), T + M), M).gatherGroups[0].key, k1, 'another start time is another key');
  const a = mk5();
  a.characters.forEach((c) => { c.gather = Object.assign(COPPER(), { baseMinutes: 130 }); });
  assert.notEqual(gviewOf(A.startAccount(a, mkCtx(), T), M).gatherGroups[0].key, k1, 'another plan is another key');
  assert.equal(A.gatherGroupKey('a_1', S.characters[0].gatherRun), k1);
  assert.equal(A.gatherGroupKey('a_1', S.characters[3].gatherRun), k1);
  // a key never contains characters that would break an attribute or a selector
  const odd = mk5();
  odd.characters.forEach((c) => { c.gather = Object.assign(COPPER(), { itemKey: 'mine/a|b"c<d>', spotKey: "p:x|y'z" }); });
  assert.match(gviewOf(A.startAccount(odd, mkCtx(), T), M).gatherGroups[0].key, /^a_1:g:\d+:[0-9a-f]{16}$/);
  // items whose names contain the separator cannot collide
  const c1 = Object.assign(COPPER(), { itemKey: 'mine/a|p:x', spotKey: 'p:y' });
  const c2 = Object.assign(COPPER(), { itemKey: 'mine/a', spotKey: 'p:x|p:y' });
  assert.notEqual(A.gatherGroupKey('a_1', c1), A.gatherGroupKey('a_1', c2));
  assert.equal(A.gatherGroupKey(undefined, c1).startsWith(':g:'), true);
  assert.equal(A.gatherGroupKey('a_1', null).startsWith('a_1:g:plan:'), true);
});

test('GG9 groupGathers works on view.gathers and tolerates junk', () => {
  const a = mk5();
  a.characters[4].gather = IRON();
  const v = gviewOf(A.startAccount(a, mkCtx(), T), 10 * M);
  assert.deepEqual(A.groupGathers(v.gathers), v.gatherGroups);
  assert.deepEqual(A.groupGathers(undefined), []);
  assert.deepEqual(A.groupGathers([null, undefined, 5]), []);
  const solo = A.groupGathers([{ charId: 'c_1', charIndex: 0, charName: 'x', itemName: 'i', run: null }, { charId: 'c_2', charIndex: 1, charName: 'y', itemName: 'i', run: null }]);
  assert.deepEqual(solo.map((g) => g.count), [1, 1], 'items without a groupKey are never merged');
  const merged = A.groupGathers([{ groupKey: 'k', charId: 'c_1', charIndex: 0, charName: 'x', run: null }, { groupKey: 'k', charId: 'c_2', charIndex: 1, charName: 'y', run: null }]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].memberIds, ['c_1', 'c_2']);
  assert.deepEqual(A.gatherGroupsOf(A.startAccount(a, mkCtx(), T)).map((g) => [g.key, g.members, g.memberIds, g.hasRun]), v.gatherGroups.map((g) => [g.key, g.members, g.memberIds, true]));
});

test('GG10 attentionItems: ONE item per group with its count and members; the strip count counts groups', () => {
  const ctx = mkCtx();
  const S = A.startAccount(mk5(), ctx, T);
  const v = A.accountView(S, ctx, at(126 * M));
  const items = A.attentionItems([v]);
  const gi = items.filter((i) => i.kind === 'gather');
  assert.equal(gi.length, 1, 'was 5 chips');
  assert.equal(items.length, 2, 'one gather group + the stone timer');
  const it = gi[0];
  assert.equal(it.key, v.gatherGroups[0].key);
  assert.equal(it.groupKey, v.gatherGroups[0].key);
  assert.equal(it.count, 5);
  assert.deepEqual(it.memberIds, ['c_1', 'c_2', 'c_3', 'c_4', 'c_5']);
  assert.deepEqual(it.members, [0, 1, 2, 3, 4]);
  assert.deepEqual(it.charNames, ['角色1', '角色2', '角色3', '角色4', '角色5']);
  assert.equal(it.charName, '', 'no single character to name');
  assert.equal(it.charIndex, 0);
  assert.equal(it.title, '銅');
  assert.equal(it.urgency, 'now');
  assert.equal(it.accountId, 'a_1');
  assert.equal(it.actAt, T + 125 * M);
  assert.equal(it.fullAt, T + 135 * M);
  assert.equal(typeof it.progress, 'number');
  assert.equal(items.find((i) => i.kind === 'stone').count, 1);
  // a group of one keeps naming its character
  const a = mk5();
  a.characters[0].name = '阿龍';
  a.characters[0].gather = IRON();
  const one = A.attentionItems([A.accountView(A.startAccount(a, ctx, T), ctx, at(M))]).filter((i) => i.kind === 'gather');
  assert.deepEqual(one.map((i) => [i.count, i.charName]).sort(), [[1, '阿龍'], [4, '']]);
  // views that carry no gatherGroups (built by hand) are grouped on the fly
  const manual = Object.assign({}, v);
  delete manual.gatherGroups;
  assert.equal(A.attentionItems([manual]).filter((i) => i.kind === 'gather').length, 1);
  // paused groups and invalid runs are still left out
  const paused = A.accountView(withRun(S, 0, (r) => A.pauseRun(r, at(M))), ctx, at(126 * M));
  assert.deepEqual(A.attentionItems([paused]).filter((i) => i.kind === 'gather').map((i) => i.count), [4]);
});

test('GG11 summarize counts groups, not characters', () => {
  const ctx = mkCtx();
  const S1 = A.startAccount(mk5(), ctx, T);
  const S2 = A.startAccount(mkF({ id: 'a_2', label: '副帳' }), ctx, T);
  const views = [A.accountView(S1, ctx, at(126 * M)), A.accountView(S2, ctx, at(126 * M))];
  const s = A.summarize(views, at(126 * M));
  assert.equal(s.stoneTimers, 2);
  assert.equal(s.gatherTimers, 2, 'one group in each account');
  assert.equal(s.timers, 4);
  assert.equal(s.pausedTimers, 0);
  assert.deepEqual(s.byUrgency, { overdue: 0, now: 2, soon: 0, calm: 2 });
  assert.equal(s.accountsTotal, 2);
  // paused groups count as paused, not as urgent
  const p = A.accountView(withRun(S1, 0, (r) => A.pauseRun(r, at(M))), ctx, at(126 * M));
  const sp = A.summarize([p], at(126 * M));
  assert.equal(sp.gatherTimers, 2, 'a paused character is its own group');
  assert.equal(sp.pausedTimers, 1);
  assert.deepEqual(sp.byUrgency, { overdue: 0, now: 1, soon: 0, calm: 1 });
  assert.equal(sp.byUrgency.now + sp.byUrgency.overdue + sp.byUrgency.soon + sp.byUrgency.calm + sp.pausedTimers, sp.timers);
});

test('GG12 markGroupFired sets the flag on EVERY member run, leaves everyone else alone, and never mutates', () => {
  const a = mk5();
  a.characters[4].gather = IRON();
  const S = deepFreeze(A.startAccount(a, mkCtx(), T));
  const groups = A.gatherGroupsOf(S);
  const big = groups[0];
  const n1 = A.markGroupFired(S, big.key, 'now');
  assert.deepEqual(n1.characters.map((c) => c.gatherRun.fired), [{ now: true, overdue: false }, { now: true, overdue: false }, { now: true, overdue: false }, { now: true, overdue: false }, { now: false, overdue: false }]);
  assert.equal(n1.characters[4], S.characters[4], 'the member that differs is the same object');
  assert.deepEqual(S.characters[0].gatherRun.fired, { now: false, overdue: false }, 'input untouched');
  assert.equal(n1.stoneRun, S.stoneRun);
  const n2 = A.markGroupFired(n1, big.key, 'overdue');
  assert.deepEqual(n2.characters[0].gatherRun.fired, { now: true, overdue: true }, 'overdue implies now');
  assert.deepEqual(n2.characters[4].gatherRun.fired, { now: false, overdue: false });
  // an object level (what nextNotification returns) works, and a flag is never lowered
  const n3 = A.markGroupFired(n2, big.key, { now: true, overdue: false });
  assert.equal(n3, n2, 'nothing new to set: the same reference');
  assert.equal(A.markGroupFired(n2, big.key, 'now'), n2);
  const n4 = A.markGroupFired(S, groups[1].key, { now: true, overdue: true });
  assert.deepEqual(n4.characters[4].gatherRun.fired, { now: true, overdue: true });
  assert.equal(n4.characters[0], S.characters[0]);
  // 'overdue' from a clean state implies 'now' as well; flags are never lowered by an object level
  assert.deepEqual(A.markGroupFired(S, big.key, 'overdue').characters[0].gatherRun.fired, { now: true, overdue: true });
  assert.equal(A.markGroupFired(n1, big.key, { now: false, overdue: false }), n1, 'a false flag never un-fires');
  assert.equal(A.markGroupFired(n2, big.key, { now: false, overdue: true }), n2);
  // unknown key / bad level / bad account -> same reference
  assert.equal(A.markGroupFired(S, 'nope', 'now'), S);
  assert.equal(A.markGroupFired(S, big.key, 'later'), S);
  assert.equal(A.markGroupFired(S, big.key, null), S);
  assert.equal(A.markGroupFired(null, big.key, 'now'), null);
  assert.equal(A.markGroupFired({ id: 'a_1' }, big.key, 'now').id, 'a_1');
});

test('GG13 paused members: marking a paused group works, and a paused group never fires', () => {
  const S = started5();
  const P = withRun(withRun(S, 3, (r) => A.pauseRun(r, at(M))), 4, (r) => A.pauseRun(r, at(M)));
  const [live, paused] = A.gatherGroupsOf(P);
  assert.deepEqual(paused.members, [3, 4]);
  const marked = A.markGroupFired(P, paused.key, 'now');
  assert.deepEqual(marked.characters.map((c) => c.gatherRun.fired.now), [false, false, false, true, true]);
  assert.equal(marked.characters[0], P.characters[0]);
  const v = gviewOf(P, 140 * M);
  const pg = v.gatherGroups.find((g) => g.paused);
  assert.deepEqual(A.nextGroupNotification(P, pg, at(140 * M)), { fire: null, fired: { now: false, overdue: false }, missed: false });
  assert.equal(A.nextGroupNotification(P, v.gatherGroups.find((g) => !g.paused), at(136 * M)).fire, 'overdue');
  assert.deepEqual(live.members, [0, 1, 2]);
  // a group paused AFTER its due time is frozen as overdue, and still must not alert (or count as missed) while paused
  const late = withRun(withRun(S, 3, (r) => A.pauseRun(r, at(140 * M))), 4, (r) => A.pauseRun(r, at(140 * M)));
  const lv = gviewOf(late, 200 * M);
  const lg = lv.gatherGroups.find((g) => g.paused);
  assert.equal(lg.urgency, 'overdue');
  assert.deepEqual(A.nextGroupNotification(late, lg, at(200 * M)), { fire: null, fired: { now: false, overdue: false }, missed: false });
});

test('GG14 groupFiredFlags merges the members (old saves flagged characters one by one); nextGroupNotification fires once', () => {
  const S = started5();
  assert.deepEqual(A.groupFiredFlags(S, A.gatherGroupsOf(S)[0].key), { now: false, overdue: false });
  assert.deepEqual(A.groupFiredFlags(S, 'nope'), { now: false, overdue: false });
  assert.deepEqual(A.groupFiredFlags(null, 'x'), { now: false, overdue: false });
  const key = A.gatherGroupsOf(S)[0].key;
  const g = () => gviewOf(S, 125 * M).gatherGroups[0];
  const r = A.nextGroupNotification(S, g(), at(125 * M));
  assert.deepEqual(r, { fire: 'now', fired: { now: true, overdue: false }, missed: false });
  const S2 = A.markGroupFired(S, key, r.fired);
  assert.equal(A.nextGroupNotification(S2, g(), at(125 * M)).fire, null);
  assert.deepEqual(A.groupFiredFlags(S2, key), { now: true, overdue: false });
  // one member was already flagged by an older version: the group counts as flagged (no double alert)
  const old = withRun(S, 2, (run) => Object.assign({}, run, { fired: { now: true, overdue: false } }));
  assert.deepEqual(A.groupFiredFlags(old, key), { now: true, overdue: false });
  assert.equal(A.nextGroupNotification(old, g(), at(125 * M)).fire, null);
  // ONE member already carries BOTH flags (now AND overdue): the group counts as fully announced, so the overdue
  // alert is not repeated (a group needs "any member has it" for the overdue level too, not "every member")
  const oldBoth = withRun(S, 3, (run) => Object.assign({}, run, { fired: { now: true, overdue: true } }));
  assert.deepEqual(A.groupFiredFlags(oldBoth, key), { now: true, overdue: true });
  const lateG = gviewOf(oldBoth, 140 * M).gatherGroups[0];
  assert.equal(lateG.urgency, 'overdue');
  assert.deepEqual(A.nextGroupNotification(oldBoth, lateG, at(140 * M)), { fire: null, fired: { now: true, overdue: true }, missed: false });
  assert.equal(A.nextGroupNotification(S, lateG, at(140 * M)).fire, 'overdue', 'control: with no flag at all it fires');
  // not running / no run -> nothing
  assert.deepEqual(A.nextGroupNotification(S, null, at(M)), { fire: null, fired: { now: false, overdue: false }, missed: false });
  assert.equal(A.nextGroupNotification(mk5(), gviewOf(mk5(), M).gatherGroups[0], at(M)).fire, null);
});

test('GG15 a stale jump is reported once per group, silently (missed), and flags every member', () => {
  const S = started5();
  const key = A.gatherGroupsOf(S)[0].key;
  const g = gviewOf(S, 200 * M).gatherGroups[0];
  const r = A.nextGroupNotification(S, g, at(200 * M));
  assert.deepEqual(r, { fire: null, fired: { now: true, overdue: true }, missed: true });
  const S2 = A.markGroupFired(S, key, r.fired);
  assert.ok(S2.characters.every((c) => c.gatherRun.fired.now && c.gatherRun.fired.overdue));
  const r2 = A.nextGroupNotification(S2, gviewOf(S2, 201 * M).gatherGroups[0], at(201 * M));
  assert.deepEqual(r2, { fire: null, fired: { now: true, overdue: true }, missed: false });
});

test('GG16 notification lifecycle: five characters give exactly two alerts (now, overdue), not ten', () => {
  const ctx = mkCtx();
  let acc = A.startAccount(mk5(), ctx, T);
  const alerts = [];
  for (let m = 0; m <= 200; m++) {
    const v = A.accountView(acc, ctx, at(m * M));
    for (const g of v.gatherGroups) {
      const r = A.nextGroupNotification(acc, g, at(m * M));
      if (r.fire) alerts.push({ m, level: r.fire, count: g.count });
      acc = A.markGroupFired(acc, g.key, r.fired);
    }
  }
  assert.deepEqual(alerts, [{ m: 125, level: 'now', count: 5 }, { m: 135, level: 'overdue', count: 5 }]);
  assert.ok(acc.characters.every((c) => c.gatherRun.fired.now && c.gatherRun.fired.overdue), 'every member run carries the flags (they are saved per character)');
  // a restart of the group re-arms it for all members
  const again = A.restartGatherGroup(acc, A.gatherGroupsOf(acc)[0].key, at(210 * M));
  assert.ok(again.characters.every((c) => !c.gatherRun.fired.now && !c.gatherRun.fired.overdue));
});

test('GG17 setAccountGather: every character gets its own copy of the plan; runs are left alone; runtime fields are not copied', () => {
  const S = deepFreeze(A.startAccount(mk5(), mkCtx(), T));
  const plan = Object.assign(IRON(), { startedAt: 5, pausedAt: 7, fired: { now: true, overdue: true }, bogus: 1 });
  const out = A.setAccountGather(S, plan);
  assert.ok(out.characters.every((c) => c.gather.itemKey === 'mine/鐵' && c.gather.baseMinutes === 120));
  assert.deepEqual(Object.keys(out.characters[0].gather).sort(), ['baseMinutes', 'bufferMin', 'category', 'itemKey', 'itemName', 'placeLabel', 'slots', 'speed', 'spotKey', 'workHoursAtStart']);
  assert.notEqual(out.characters[0].gather, out.characters[1].gather, 'no shared object between characters');
  assert.ok(out.characters.every((c, i) => c.gatherRun === S.characters[i].gatherRun), 'the running timers are not touched');
  assert.equal(A.pendingChanges(out).gather.length, 5, 'so the plan is pending until the group is restarted');
  assert.equal(out.stoneRun, S.stoneRun);
  assert.equal(S.characters[0].gather.itemKey, 'mine/銅', 'input untouched');
  // it overrides differences that were there
  const mixed = mk5();
  mixed.characters[4].gather = IRON();
  const unified = A.setAccountGather(mixed, COPPER());
  assert.equal(A.gatherGroupsOf(unified).length, 1);
  assert.ok(unified.characters.every((c) => c.gather.itemKey === 'mine/銅'));
  // characters that had no plan get one; null / junk plan clears
  assert.ok(A.setAccountGather(stoneOnly(), COPPER()).characters.every((c) => c.gather));
  assert.ok(A.setAccountGather(mk5(), null).characters.every((c) => c.gather === null));
  assert.ok(A.setAccountGather(mk5(), 'junk').characters.every((c) => c.gather === null));
  assert.equal(A.setAccountGather(null, COPPER()), null);
  assert.deepEqual(A.setAccountGather({ id: 'a_1' }, COPPER()), { id: 'a_1' });
  assert.deepEqual(A.setAccountGather(mkF({ characters: [null, { id: 'c_1' }] }), COPPER()).characters.map((c) => c && c.gather && c.gather.itemKey), [null, 'mine/銅']);
});

test('GG18 setAccountGather then startAccount: a fresh online account gets five identical runs = one group', () => {
  const plain = mkF();
  const planned = A.setAccountGather(plain, COPPER());
  const S = A.startAccount(planned, mkCtx(), T);
  assert.ok(S.characters.every((c) => c.gatherRun && c.gatherRun.startedAt === T));
  assert.equal(gviewOf(S, M).gatherGroups.length, 1);
  assert.equal(gviewOf(S, M).gatherGroups[0].count, 5);
});

test('GG19 clearAccountGather: plans only by default, runs too on request', () => {
  const S = deepFreeze(A.startAccount(mk5(), mkCtx(), T));
  const planOnly = A.clearAccountGather(S);
  assert.ok(planOnly.characters.every((c) => c.gather === null));
  assert.ok(planOnly.characters.every((c, i) => c.gatherRun === S.characters[i].gatherRun));
  const all = A.clearAccountGather(S, { runs: true });
  assert.ok(all.characters.every((c) => c.gather === null && c.gatherRun === null));
  assert.equal(all.stoneRun, S.stoneRun, 'the stone timer is not a gather');
  assert.deepEqual(gviewOf(all, M).gatherGroups, []);
  assert.equal(A.clearAccountGather(null), null);
  assert.deepEqual(A.clearAccountGather({ id: 'a_1' }), { id: 'a_1' });
  assert.equal(A.clearAccountGather(stoneOnly()).characters.length, 5);
});

test('GG20 restartGatherGroup restarts the whole group together, keeps the others, re-arms the alerts', () => {
  const a = mk5();
  a.characters[4].gather = IRON();
  const S = deepFreeze(A.startAccount(a, mkCtx(), T));
  const groups = A.gatherGroupsOf(S);
  const flagged = A.markGroupFired(S, groups[0].key, 'overdue');
  const R = A.restartGatherGroup(flagged, groups[0].key, at(130 * M));
  for (let i = 0; i < 4; i++) {
    const r = R.characters[i].gatherRun;
    assert.equal(r.startedAt, T + 130 * M);
    assert.equal(r.lastDepositAt, T + 130 * M);
    assert.deepEqual(r.fired, { now: false, overdue: false });
    assert.equal(r.pausedAt, null);
    assert.equal(r.itemKey, 'mine/銅');
  }
  assert.equal(R.characters[4], flagged.characters[4], 'the character that differs is untouched');
  assert.equal(R.characters[4].gatherRun.startedAt, T);
  assert.equal(R.stoneRun, flagged.stoneRun);
  const v = gviewOf(R, 140 * M);
  assert.deepEqual(v.gatherGroups.map((g) => [g.count, g.status.fullAt]), [[4, T + 265 * M], [1, T + 120 * M]]);
  assert.equal(v.gatherGroups.find((g) => g.count === 4).urgency, 'calm');
  assert.equal(v.gatherGroups.find((g) => g.count === 1).urgency, 'overdue', 'the iron nobody restarted is still late');
  assert.equal(S.characters[0].gatherRun.startedAt, T, 'input untouched');
});

test('GG21 restartGatherGroup: paused groups stay paused; pending plan edits are picked up; no-ops return the same reference', () => {
  const S = started5();
  const P = A.goOffline(S, at(30 * M), mkCtx().settings);
  const pk = A.gatherGroupsOf(P)[0].key;
  const R = A.restartGatherGroup(P, pk, at(40 * M));
  assert.ok(R.characters.every((c) => c.gatherRun.startedAt === T + 40 * M && c.gatherRun.pausedAt === T + 40 * M));
  assert.equal(gviewOf(R, 50 * M).gatherGroups.length, 1);
  assert.equal(gviewOf(R, 50 * M).gatherGroups[0].paused, true);
  // a plan edit for the whole account is applied by the restart and the group stays one
  const edited = A.setAccountGather(S, Object.assign(COPPER(), { baseMinutes: 100 }));
  const applied = A.restartGatherGroup(edited, A.gatherGroupsOf(S)[0].key, at(10 * M));
  assert.ok(applied.characters.every((c) => c.gatherRun.baseMinutes === 100));
  assert.equal(A.gatherGroupsOf(applied).length, 1);
  // a plan edit for ONE character splits it off after the restart (the others keep their plan)
  const one = Object.assign({}, S, { characters: S.characters.map((c, i) => (i === 2 ? Object.assign({}, c, { gather: Object.assign(COPPER(), { baseMinutes: 100 }) }) : c)) });
  assert.deepEqual(A.gatherGroupsOf(A.restartGatherGroup(one, A.gatherGroupsOf(S)[0].key, at(10 * M))).map((g) => g.count), [4, 1]);
  // no-ops
  assert.equal(A.restartGatherGroup(S, 'nope', at(M)), S);
  assert.equal(A.restartGatherGroup(S, pk, NaN), S);
  assert.equal(A.restartGatherGroup(S, pk, undefined), S);
  assert.equal(A.restartGatherGroup(null, pk, at(M)), null);
  const planOnly = mk5();
  assert.equal(A.restartGatherGroup(planOnly, A.gatherGroupsOf(planOnly)[0].key, at(M)), planOnly, 'a plan without a run has nothing to restart');
});

test('GG22 restoreGatherRuns puts every member back (undo of a group restart) and settles them to the account state', () => {
  const ctx = mkCtx();
  const S = A.startAccount(mk5(), ctx, T);
  const key = A.gatherGroupsOf(S)[0].key;
  const prev = S.characters.map((c) => ({ charId: c.id, run: JSON.parse(JSON.stringify(c.gatherRun)) }));
  const R = A.restartGatherGroup(S, key, at(130 * M));
  const U = A.restoreGatherRuns(R, prev, at(131 * M), ctx.settings);
  assert.deepEqual(U.characters.map((c) => c.gatherRun), S.characters.map((c) => c.gatherRun));
  assert.equal(A.gatherGroupsOf(U).length, 1);
  assert.equal(A.restoreGatherRuns(R, [], at(131 * M), ctx.settings), R);
  assert.equal(A.restoreGatherRuns(R, null, at(131 * M), ctx.settings), R);
  assert.equal(A.restoreGatherRuns(null, prev, at(131 * M), ctx.settings), null);
  // a null run in the undo list removes the timer
  const gone = A.restoreGatherRuns(R, [{ charId: 'c_1', run: null }], at(131 * M), ctx.settings);
  assert.equal(gone.characters[0].gatherRun, null);
  assert.equal(gone.characters[1].gatherRun.startedAt, T + 130 * M);
});

test('GG23 pendingGatherGroups names the groups with an unapplied plan edit', () => {
  const S = started5();
  assert.deepEqual(A.pendingGatherGroups(S), []);
  const edited = A.setAccountGather(S, Object.assign(COPPER(), { baseMinutes: 100 }));
  assert.deepEqual(A.pendingGatherGroups(edited), [A.gatherGroupsOf(S)[0].key]);
  const one = Object.assign({}, S, { characters: S.characters.map((c, i) => (i === 2 ? Object.assign({}, c, { gather: Object.assign(COPPER(), { baseMinutes: 100 }) }) : c)) });
  assert.deepEqual(A.pendingGatherGroups(one), [A.gatherGroupsOf(S)[0].key]);
  assert.deepEqual(A.pendingGatherGroups(mk5()), [], 'no run, nothing pending');
  assert.deepEqual(A.pendingGatherGroups(null), []);
  assert.deepEqual(A.pendingChanges(S), { stone: false, gather: [], any: false }, 'pendingChanges keeps its shape');
});

test('GG24 old saves: five per-character runs with their own flags and deposit times load and show as ONE group', () => {
  const run = (extra) => Object.assign({ category: 'mine', itemKey: 'mine/銅', spotKey: 'p:x', itemName: '銅', placeLabel: 'x', baseMinutes: 135, slots: 5, speed: 1, bufferMin: null, workHoursAtStart: null, startedAt: T - 20 * M, pausedAt: null, lastDepositAt: T - 20 * M, fired: { now: false, overdue: false } }, extra || {});
  const old = {
    schema: 1, rev: 3, savedAt: T,
    settings: {},
    accounts: [{
      id: 'a_acc001', label: '主帳', accountId: '', note: '', createdAt: T - D, onlineSessions: [{ start: T - H, end: null }],
      stone: { spotId: 'kude', freeSlots: 34 }, stoneRun: null,
      characters: [1, 2, 3, 4, 5].map((i) => ({
        id: 'c_char0' + i, name: '角色' + i, level: 1, freeSlots: null, gather: run({ startedAt: undefined, pausedAt: undefined, lastDepositAt: undefined, fired: undefined }),
        gatherRun: run(i === 2 ? { lastDepositAt: null, fired: { now: true, overdue: false } } : (i === 4 ? { lastDepositAt: T - 5 * M } : {})),
      })),
    }],
  };
  const l = A.loadState(JSON.stringify(old), T);
  assert.equal(l.status, 'ok');
  assert.equal(l.dropped, 0);
  const v = A.accountView(l.state.accounts[0], mkCtx(), T);
  assert.equal(v.gatherGroups.length, 1, 'flags and deposit times do not split a group');
  assert.equal(v.gatherGroups[0].count, 5);
  const gi = A.attentionItems([v]).filter((i) => i.kind === 'gather');
  assert.deepEqual(gi.map((i) => [i.count, i.urgency]), [[5, 'calm']], 'one calm chip, not five');
  // the flagged member makes the whole group count as flagged (no second alert for something already announced)
  assert.deepEqual(A.groupFiredFlags(l.state.accounts[0], v.gatherGroups[0].key), { now: true, overdue: false });
});

test('GG25 groups survive a save/load round trip with the same keys; hostile gather data cannot break grouping', () => {
  const S = started5();
  const st = A.defaultState(T);
  st.accounts = [Object.assign(withValidIds(S), {})];
  const back = A.loadState(A.exportState(st, T, {}), T + M).state.accounts[0];
  const v1 = A.accountView(withValidIds(S), mkCtx(), at(M));
  const v2 = A.accountView(back, mkCtx(), at(M));
  assert.deepEqual(v2.gatherGroups.map((g) => g.key), v1.gatherGroups.map((g) => g.key));
  const hostile = mkF({ characters: [{ id: 'c_1', gather: 5, gatherRun: 'x' }, { id: 'c_2', gather: { itemKey: 7 }, gatherRun: { startedAt: 'a' } }, null, { id: 'c_4', gather: [] }] });
  const hv = A.accountView(hostile, mkCtx(), T);
  assertFiniteDeep(hv);
  A.attentionItems([hv]);
  A.summarize([hv], T);
  assert.equal(A.markGroupFired(hostile, 'x', 'now'), hostile);
  A.restartGatherGroup(hostile, hv.gatherGroups.length ? hv.gatherGroups[0].key : 'x', T);
});

test('B6 fuzz (v2): MP estimates, grouping, group notifications and group edits never throw and never produce NaN/Infinity', () => {
  let seed = 987654;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const weird = [0, 1, -1, 0.5, 34, 135, 1e-9, 1e9, 1e15, Number.MAX_VALUE, NaN, Infinity, -Infinity, null, undefined, '5', 'x', 3.7];
  const times = [T, T - H, T + H, T + 125 * M, T + 10 * H, T - 100 * D, NaN, undefined];
  for (let i = 0; i < 1500; i++) {
    const recs = [];
    for (let k = 0; k < Math.floor(rnd() * 4); k++) recs.push({ spotId: 'kude', at: pick(times), hours: pick(weird), stones: pick(weird), excluded: pick([false, true, undefined]), consumption: pick([null, { amount: pick(weird) }, { amount: pick(weird), goldValue: pick(weird) }]) });
    const est = A.mpEstimate(recs, pick(times), { manualPerHour: pick(weird), priorHours: pick(weird), ratePerHour: pick(weird), halfLifeDays: pick(weird) });
    assertFiniteDeep(est);
    assertFiniteDeep(A.mpForAccount(est, { hoursRemaining: pick(weird), stonesRemaining: pick(weird) }, pick(weird)));
    assertFiniteDeep(A.mpPerCharFromEntry(pick(weird), pick(['char', 'account', 'x', undefined]), pick(weird)) || 0);
    assertFiniteDeep(A.mpEntryFromPerChar(pick(weird), pick(['char', 'account', undefined]), pick(weird)) || 0);
    assertFiniteDeep(A.mpPerHourFrom12h(pick(weird)) || 0);
    assertFiniteDeep(A.resolveMpManual({ mpPer12h: pick(weird) }, { stone: { mpPer12hOverride: pick(weird) } }) || 0);
    A.mpSourceLabel(est);
    // a random account whose characters gather random things
    const chars = [];
    for (let k = 0; k < Math.floor(rnd() * 6); k++) {
      const plan = pick([null, undefined, 5, COPPER(), IRON(), Object.assign(COPPER(), { baseMinutes: pick(weird), slots: pick(weird), speed: pick(weird), bufferMin: pick(weird) })]);
      const run = pick([null, undefined, 'x', Object.assign({}, COPPER(), { startedAt: pick(times), pausedAt: pick([null, undefined, T, NaN]), fired: pick([null, { now: true }, { now: false, overdue: false }, 3]) })]);
      chars.push(pick([null, { id: 'c_' + k, name: 'n' + k, gather: plan, gatherRun: run }]));
    }
    const acc = { id: 'a_1', label: 'x', stone: { spotId: 'kude', freeSlots: pick(weird), mpPer12hOverride: pick(weird) }, stoneRun: null, onlineSessions: [], characters: chars };
    const ctx = mkCtx({ observations: recs });
    ctx.settings.mpPer12h = pick(weird);
    const now = pick(times);
    const v = A.accountView(acc, ctx, now);
    // (the view echoes the raw plan it was given, so only what the view COMPUTES must be finite)
    assertFiniteDeep(v.mp);
    assertFiniteDeep(v.stone.plan);
    assertFiniteDeep(v.gathers.map((g) => [g.run, g.planStatus, g.groupCount]));
    assertFiniteDeep(v.gatherGroups.map((g) => [g.count, g.members, g.run, g.planStatus, g.status, g.urgency, g.paused]));
    assertFiniteDeep(A.attentionItems([v]).map((i) => [i.remainingMs, i.actAt, i.fullAt, i.progress, i.count, i.members]));
    assertFiniteDeep(A.summarize([v], now));
    const groups = A.gatherGroupsOf(acc);
    const key = groups.length ? groups[0].key : 'x';
    A.markGroupFired(acc, key, pick(['now', 'overdue', { now: true }, null, 3]));
    A.restartGatherGroup(acc, key, pick(times));
    A.setAccountGather(acc, pick([null, COPPER(), IRON(), 'x', { itemKey: 3 }]));
    A.clearAccountGather(acc, pick([undefined, { runs: true }]));
    assertFiniteDeep(A.groupFiredFlags(acc, key));
    v.gatherGroups.forEach((g) => A.nextGroupNotification(acc, g, now));
    A.pendingGatherGroups(acc);
  }
});


// =====================================================================
// Review fixes (v2): live-run spot for MP, cleared plans, and the pins for the mutants that survived
// =====================================================================
const SPOT_LONG = () => ({ id: 'longshu', name: '龍舌', defaultRate: 20, manualRate: null });

test('MPV6 a live run keeps ITS spot for the MP figures: changing the plan spot meanwhile changes nothing until the restart', () => {
  const ctx = mkCtx({ spots: [SPOT_KUDE(), SPOT_LONG()], observations: [mpObs(10, 100, 12000), mpObs(10, 50, 30000, 0, { spotId: 'longshu' })] });
  const base = A.startAccount(stoneOnly(), ctx, T); // the run mines kude (10 / h)
  assert.equal(base.stoneRun.spotId, 'kude');
  const switched = Object.assign({}, base, { stone: Object.assign({}, base.stone, { spotId: 'longshu' }) }); // the plan moved to longshu (20 / h), the run did not
  for (const ms of [0, 2.5 * H, 5 * H]) {
    const vb = A.accountView(base, ctx, at(ms));
    const vs = A.accountView(switched, ctx, at(ms));
    assert.equal(vs.stone.run.spotId, 'kude', 'the run still mines kude');
    assert.deepEqual(vs.mp, vb.mp, 'every MP figure is the same as for the account that did not switch, at +' + ms / H + ' h');
    assert.equal(vs.mp.source, 'blended');
    assert.equal(vs.mp.sampleCount, 1, 'only the kude record counts, the longshu one does not');
    assert.equal(vs.mp.needPerChar.forTime !== null, true);
    close(vs.mp.needPerChar.forStones, vs.mp.needPerChar.forTime, 1e-6, 'stones-based and time-based need agree (they used to differ 2x)');
  }
  // without records: MP per stone = the manual number over the RUN's rate (kude 10 / h), not the plan's (longshu 20 / h)
  const clean = mkCtx({ spots: [SPOT_KUDE(), SPOT_LONG()] });
  const noRec = A.accountView(switched, clean, at(5 * H)).mp;
  close(noRec.mpPerStone, MP17500 / 10, 1e-9);
  close(noRec.needPerChar.forTime, noRec.needPerChar.forStones, 1e-6);
  // after the restart the plan spot takes over: longshu records and the longshu rate
  const restarted = A.restartStone(switched, at(5 * H));
  assert.equal(restarted.stoneRun.spotId, 'longshu');
  const after = A.accountView(restarted, ctx, at(5 * H)).mp;
  assert.equal(after.sampleCount, 1);
  assert.notEqual(after.mpPerStone, A.accountView(base, ctx, at(5 * H)).mp.mpPerStone);
  close(A.accountView(restarted, clean, at(5 * H)).mp.mpPerStone, MP17500 / 20, 1e-9);
  // no run at all: the plan spot is what counts
  const noRun = A.accountView(Object.assign({}, stoneOnly(), { stone: Object.assign({}, stoneOnly().stone, { spotId: 'longshu' }) }), clean, T).mp;
  close(noRun.mpPerStone, MP17500 / 20, 1e-9);
  assert.equal(noRun.needMode, 'round');
});

test('GG26 clearing a gather plan while its timer runs: the restart applies the clear (the timer goes, the rest restarts), undo brings it back', () => {
  const ctx = mkCtx();
  const S = deepFreeze(A.startAccount(mk5(), ctx, T));
  const key = A.gatherGroupsOf(S)[0].key;
  // characters 4 and 5 lose their plan, the timers keep running with the old numbers (pending)
  const edited = deepFreeze(Object.assign({}, S, { characters: S.characters.map((c, i) => (i >= 3 ? Object.assign({}, c, { gather: null }) : c)) }));
  assert.deepEqual(A.pendingChanges(edited).gather, ['c_4', 'c_5']);
  assert.deepEqual(A.pendingGatherGroups(edited), [key]);
  assert.equal(A.gatherGroupsOf(edited).length, 1, 'still one box x5 until the restart');
  const R = A.restartGatherGroup(edited, key, at(130 * M));
  assert.equal(R.characters[3].gatherRun, null);
  assert.equal(R.characters[4].gatherRun, null);
  assert.equal(R.characters[3].gather, null, 'the plan stays cleared');
  for (let i = 0; i < 3; i++) assert.equal(R.characters[i].gatherRun.startedAt, T + 130 * M);
  assert.deepEqual(A.pendingChanges(R), { stone: false, gather: [], any: false }, '待套用 is gone after the restart');
  assert.deepEqual(A.pendingGatherGroups(R), []);
  const v = gviewOf(R, 140 * M);
  assert.deepEqual(v.gatherGroups.map((g) => g.count), [3]);
  // undo: every member's old run comes back (the page keeps [{charId, run}] for all members)
  const prev = edited.characters.map((c) => ({ charId: c.id, run: JSON.parse(JSON.stringify(c.gatherRun)) }));
  const U = A.restoreGatherRuns(R, prev, at(131 * M), ctx.settings);
  assert.deepEqual(U.characters.map((c) => c.gatherRun), edited.characters.map((c) => c.gatherRun));
  // every plan cleared: the restart removes every timer of the group and the stone timer is not touched
  const none = A.setAccountGather(S, null);
  const R2 = A.restartGatherGroup(none, key, at(130 * M));
  assert.ok(R2.characters.every((c) => c.gatherRun === null));
  assert.equal(R2.stoneRun, S.stoneRun);
  assert.deepEqual(A.gatherGroupsOf(R2), []);
});

test('GG27 coverage pins: all needs more than one character, characterCount counts characters, group helpers ignore bad input', () => {
  // groupGathers.all: a lone character is not "all" (total > 1)
  const one = { charIndex: 0, charId: 'c_1', charName: 'x', groupKey: 'k' };
  assert.equal(A.groupGathers([one], 1)[0].all, false);
  assert.equal(A.groupGathers([one, Object.assign({}, one, { charIndex: 1, charId: 'c_2' })], 2)[0].all, true);
  assert.equal(A.groupGathers([one], 0)[0].all, false);
  // charNames: only strings pass through
  const odd = A.groupGathers([Object.assign({}, one, { charName: 123 }), Object.assign({}, one, { charIndex: 1, charId: 'c_2', charName: null })], 2)[0];
  assert.deepEqual(odd.charNames, ['', '']);
  // view.characterCount is the number of characters, not the number of gatherers
  const a = mkF();
  a.characters[0].gather = COPPER();
  a.characters[1].gather = COPPER();
  a.characters[2].gather = COPPER();
  const v = A.accountView(a, mkCtx(), T);
  assert.equal(v.characterCount, 5);
  assert.equal(v.gathers.length, 3);
  assert.equal(v.gatherGroups[0].all, false, '3 of 5 is not all');
  // clearAccountGather: opts without runs:true keeps the timers
  const S = A.startAccount(mk5(), mkCtx(), T);
  for (const opts of [{ runs: false }, {}, { runs: 'yes' }, null]) {
    const c = A.clearAccountGather(S, opts);
    assert.ok(c.characters.every((ch, i) => ch.gather === null && ch.gatherRun === S.characters[i].gatherRun), JSON.stringify(opts));
  }
  // markGroupFired with a missing or unknown level is a no-op (same reference)
  const key = A.gatherGroupsOf(S)[0].key;
  assert.equal(A.markGroupFired(S, key, undefined), S);
  assert.equal(A.markGroupFired(S, key), S);
  // mpEstimate ignores a rate that is zero or negative (no negative MP per stone), a positive one still works
  for (const bad of [-5, 0, NaN, null]) {
    const est = A.mpEstimate([], T, { manualPerHour: MP17500, ratePerHour: bad });
    assert.equal(est.mpPerStone, null, 'rate ' + bad);
    close(est.mpPerHour, MP17500, 1e-9);
  }
  close(A.mpEstimate([], T, { manualPerHour: MP17500, ratePerHour: 10 }).mpPerStone, MP17500 / 10, 1e-9);
});

test('GG28 nextGroupNotification passes opts through (staleMs), and restoreGatherRuns honours "do not pause on offline"', () => {
  const S = started5();
  const g = gviewOf(S, 133 * M).gatherGroups[0];
  assert.equal(g.urgency, 'now');
  // 8 minutes after the "now" moment: default staleMs (5 min) calls it missed, a 20 minute window still alerts
  assert.deepEqual(A.nextGroupNotification(S, g, at(133 * M)), { fire: null, fired: { now: true, overdue: false }, missed: true });
  assert.deepEqual(A.nextGroupNotification(S, g, at(133 * M), { staleMs: 20 * M }), { fire: 'now', fired: { now: true, overdue: false }, missed: false });
  // undo of a group restart on an OFFLINE account: runs are paused unless the setting says they keep going
  const ctx = mkCtx();
  const key = A.gatherGroupsOf(S)[0].key;
  const prev = S.characters.map((c) => ({ charId: c.id, run: JSON.parse(JSON.stringify(c.gatherRun)) }));
  const R = A.restartGatherGroup(S, key, at(10 * M));
  const offline = A.goOffline(R, at(20 * M), ctx.settings);
  const keepGoing = Object.assign({}, ctx.settings, { pauseRunsOnOffline: false });
  const kept = A.restoreGatherRuns(offline, prev, at(30 * M), keepGoing);
  assert.ok(kept.characters.every((c) => c.gatherRun.pausedAt === null), 'runs keep going when pausing is off');
  const paused = A.restoreGatherRuns(offline, prev, at(30 * M), ctx.settings);
  assert.ok(paused.characters.every((c) => c.gatherRun.pausedAt === T + 30 * M), 'and are paused by default');
});

// =====================================================================
// Second review pass (v2): MP signpost, MP in the compact row, remembered open rows
// =====================================================================
test('FX1 mpHeadline: the default number, per-account overrides counted, "none" only when the default is cleared', () => {
  const s = DEF();
  const a = mkF();
  const b = mkF({ id: 'a_2' }); b.stone.mpPer12hOverride = 20000;
  const c = mkF({ id: 'a_3' }); c.stone.mpPer12hOverride = 0; // 0 is a real number (free MP), still an override
  const d = mkF({ id: 'a_4' }); d.stone.mpPer12hOverride = null;
  const h = A.mpHeadline(s, [a, b, c, d]);
  assert.equal(h.state, 'set');
  assert.equal(h.per12h, 17500);
  close(h.perHour, 17500 / 12, 1e-9);
  assert.equal(h.overrides, 2);
  assert.equal(h.accounts, 4);
  // the default cleared (explicit null) = no number; an override elsewhere does not turn the headline back on
  const none = A.mpHeadline(Object.assign({}, s, { mpPer12h: null }), [b]);
  assert.deepEqual(none, { state: 'none', per12h: null, perHour: null, overrides: 1, accounts: 1 });
  // an old save without the setting means the default, garbage means the default too
  assert.equal(A.mpHeadline({}, []).per12h, A.MP_DEFAULTS.per12h);
  assert.equal(A.mpHeadline({ mpPer12h: 'x' }, null).per12h, A.MP_DEFAULTS.per12h);
  assert.equal(A.mpHeadline(undefined, undefined).accounts, 0);
  // bad overrides and bad accounts are not counted and never throw
  const bad = [null, 7, {}, { stone: null }, { stone: { mpPer12hOverride: -5 } }, { stone: { mpPer12hOverride: NaN } }, { stone: { mpPer12hOverride: '9' } }];
  assert.equal(A.mpHeadline(s, bad).overrides, 0);
  assert.equal(A.mpHeadline(s, bad).accounts, bad.length);
});

test('FX2 mpNeedBrief: ok (to-full for a live run, round before the start), none without a number, hidden without a character that can mine', () => {
  const ctx = mkCtx();
  // not started: one whole round, every character that can mine
  const plan = A.mpNeedBrief(A.accountView(stoneOnly(), ctx, T).mp);
  assert.equal(plan.state, 'ok');
  assert.equal(plan.mode, 'round');
  assert.equal(plan.characters, 5);
  close(plan.total, plan.perChar * 5, 1e-6, 'the account total is the per-character number times the characters');
  assert.equal(plan.source, 'manual');
  close(plan.per12h, 17500, 1e-9);
  // a live run: what is still needed until it is full, and it shrinks as the run goes on
  const run = A.startAccount(stoneOnly(), ctx, T);
  const early = A.mpNeedBrief(A.accountView(run, ctx, at(1 * H)).mp);
  const late = A.mpNeedBrief(A.accountView(run, ctx, at(8 * H)).mp);
  assert.equal(early.mode, 'to-full');
  assert.ok(early.total > late.total && late.total > 0, 'less MP is still needed later in the run');
  assert.equal(early.total, A.accountView(run, ctx, at(1 * H)).mp.needTotal.forTime, 'the brief repeats the view, it does not recompute');
  // no number at all: the row shows a link to the input instead
  const blank = mkCtx({ settings: Object.assign(DEF(), { mpPer12h: null }) });
  assert.deepEqual(A.mpNeedBrief(A.accountView(stoneOnly(), blank, T).mp), { state: 'none' });
  // the account's own number counts even when the default is cleared
  const own = stoneOnly(); own.stone.mpPer12hOverride = 12000;
  const ownBrief = A.mpNeedBrief(A.accountView(own, blank, T).mp);
  assert.equal(ownBrief.state, 'ok');
  close(ownBrief.per12h, 12000, 1e-9);
  // a number but nobody who can mine: nothing to work out, nothing to show
  const nobody = stoneOnly(); nobody.characters = [];
  assert.deepEqual(A.mpNeedBrief(A.accountView(nobody, ctx, T).mp), { state: 'hidden' });
  // hostile input never throws and never leaks NaN
  for (const bad of [undefined, null, 5, 'x', [], {}, { source: 'manual', mpPerHour: 1 }, { source: 'manual', mpPerHour: 1, needPerChar: { forTime: NaN }, needTotal: { forTime: 1 } }, { source: 'manual', mpPerHour: 1, needPerChar: { forTime: -1 }, needTotal: { forTime: -1 } }]) {
    const r = A.mpNeedBrief(bad);
    assert.ok(['none', 'hidden'].includes(r.state), JSON.stringify(bad));
  }
  const odd = A.mpNeedBrief({ source: 'data', mpPerHour: 5, characters: 0, needMode: 'whatever', needPerChar: { forTime: 2 }, needTotal: { forTime: 2 } });
  assert.equal(odd.characters, 1);
  assert.equal(odd.mode, 'round');
  assertFiniteDeep(odd);
});

test('FX3 formatWan: plain below 1萬, 萬 with one decimal, 億 above, never NaN', () => {
  const t = [[0, '0'], [-5, '0'], [NaN, '0'], [Infinity, '0'], ['9', '0'], [999, '999'], [9800, '9,800'], [9999.6, '10,000'], [10000, '1萬'], [17500, '1.8萬'],
    [262500, '26.3萬'], [1458333, '145.8萬'], [99999999, '1億'], [123456789, '1.2億'], [1e9, '10億']];
  for (const [n, s] of t) assert.equal(A.formatWan(n), s, String(n));
});

test('FX4 sanitizeUi: defaults for anything odd; only real account ids; rowOpen keeps only strict true; no prototype pollution', () => {
  const dflt = { expanded: {}, rowOpen: {}, stripExpanded: false, compact: true, mpScope: 'char', ignoredAdopt: {} };
  for (const bad of [undefined, null, 5, 'x', [], {}, { compact: 'no', mpScope: 'both', rowOpen: 5, expanded: [1], ignoredAdopt: 'x' }]) {
    assert.deepEqual(A.sanitizeUi(bad), dflt, JSON.stringify(bad));
  }
  // a normal round trip keeps everything meaningful
  const good = { expanded: { a_abcd: true, a_wxyz: false }, rowOpen: { a_abcd: true, a_wxyz: true }, stripExpanded: true, compact: false, mpScope: 'account', ignoredAdopt: { kude: '9.5' } };
  assert.deepEqual(A.sanitizeUi(good), good);
  assert.deepEqual(A.sanitizeUi(JSON.parse(JSON.stringify(A.sanitizeUi(good)))), good, 'idempotent through JSON');
  // rowOpen is "which rows are open": false, 1, "true" are not open; keys that are not account ids are dropped
  const r = A.sanitizeUi({ rowOpen: { a_abcd: false, a_efgh: 1, a_ijkl: 'true', a_mnop: true, 'a_': true, a_ABCD: true, 'x y': true, c_abcd: true } });
  assert.deepEqual(r.rowOpen, { a_mnop: true, c_abcd: true });
  // expanded keeps explicit false (the character list was closed on purpose); ids are checked the same way
  assert.deepEqual(A.sanitizeUi({ expanded: { a_abcd: false, nope: true } }).expanded, { a_abcd: false });
  // text values are cut to 12 characters
  assert.equal(A.sanitizeUi({ ignoredAdopt: { kude: '1234567890123456' } }).ignoredAdopt.kude, '123456789012');
  assert.deepEqual(A.sanitizeUi({ ignoredAdopt: { 'bad key': 'x', _x: 'y', a: 'z' } }).ignoredAdopt, {});
  // a hostile document cannot reach Object.prototype and cannot make the map grow without bound
  const evil = JSON.parse('{"rowOpen":{"__proto__":true,"constructor":true,"a_abcd":true},"expanded":{"__proto__":{"polluted":1}},"ignoredAdopt":{"__proto__":"x"}}');
  const e = A.sanitizeUi(evil);
  assert.deepEqual(e.rowOpen, { a_abcd: true });
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(e.rowOpen), Object.prototype);
  const many = { rowOpen: {} };
  for (let i = 0; i < 500; i++) many.rowOpen['a_' + String(i).padStart(4, '0')] = true;
  assert.ok(Object.keys(A.sanitizeUi(many).rowOpen).length <= 60);
  // it never mutates its input
  const frozen = deepFreeze({ rowOpen: { a_abcd: true }, expanded: { a_abcd: true }, ignoredAdopt: { kude: '1' } });
  assert.doesNotThrow(() => A.sanitizeUi(frozen));
});

test('FX5 rowsOpenState: all / some / none, only strict true counts, an empty list is none', () => {
  const ids = ['a_1', 'a_2', 'a_3'];
  assert.equal(A.rowsOpenState(ids, {}), 'none');
  assert.equal(A.rowsOpenState(ids, { a_1: true }), 'some');
  assert.equal(A.rowsOpenState(ids, { a_1: true, a_2: true, a_3: true }), 'all');
  assert.equal(A.rowsOpenState(ids, { a_1: true, a_2: true, a_3: false }), 'some');
  assert.equal(A.rowsOpenState(ids, { a_1: 1, a_2: 'true', a_3: {} }), 'none');
  assert.equal(A.rowsOpenState(ids, { a_1: true, a_2: true, a_3: true, gone: true }), 'all', 'rows of deleted accounts do not matter');
  assert.equal(A.rowsOpenState([], { a_1: true }), 'none');
  assert.equal(A.rowsOpenState(null, null), 'none');
  assert.equal(A.rowsOpenState(['a_1'], null), 'none');
});
