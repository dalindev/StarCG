/*!
 * starcg_afk_logic.js - pure logic for the 掛機追蹤 (AFK tracker) page.
 *
 * UMD: exposes window.StarCG_Afk in a browser and module.exports in Node.
 * No DOM, no timers, no network, no clock: every function that needs the time takes it as an
 * argument (epoch milliseconds). Functions never mutate their inputs; "no-op" cases return the
 * very same reference where the spec says so.
 *
 * Merge note: this is a NEW file in the fork; it touches no upstream file.
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.StarCG_Afk = factory();
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  // ===================================================================
  // Constants and tiny helpers
  // ===================================================================
  var SCHEMA = 1;
  var STORAGE_KEY = 'starcg_afk_v1';
  var BACKUP_KEY = 'starcg_afk_v1_bak';
  var CORRUPT_KEY = 'starcg_afk_corrupt';
  var MS = Object.freeze({ MIN: 60000, HOUR: 3600000, DAY: 86400000 });
  var LIMITS = Object.freeze({
    accounts: 12, characters: 5, spots: 30, sessions: 500, observations: 500,
    usageRecent: 30, usageKeys: 200, overrides: 200, importBytes: 2097152,
  });

  // A bag that would need more than this many hours to fill is treated as "no usable rate" everywhere
  // (hoursToFull and stoneRunStatus share the bound so the plan and the timer always agree).
  var MAX_FILL_HOURS = 9999;
  // Hard limits for one calibration record (what sanitizeState clamps to); the dialog rejects instead of clamping.
  var OBS_LIMITS = Object.freeze({ minHours: 0.01, maxHours: 500, maxStones: 20000, maxAmount: 1e9, oddRateFactor: 5, futureSlackMs: 120000, minAt: 946684800000 });

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  /** x if it is a finite number, else the fallback. No string coercion. */
  function num(x, fb) { return isNum(x) ? x : fb; }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  var PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];
  function isSafeKey(k) { return typeof k === 'string' && PROTO_KEYS.indexOf(k) < 0; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // ===================================================================
  // 6.1 Stones
  // ===================================================================
  function stoneCapacity(freeSlots, stonesPerSlot) {
    var s = Math.floor(num(freeSlots, 0));
    var p = Math.floor(num(stonesPerSlot, 0));
    if (s <= 0 || p <= 0) return 0;
    return Math.min(s, 999) * Math.min(p, 99);
  }

  function hoursToFull(capacity, ratePerHour) {
    var c = num(capacity, 0);
    var r = num(ratePerHour, 0);
    if (c <= 0 || r <= 0) return null;
    var h = c / r;
    return isFinite(h) && h <= MAX_FILL_HOURS ? h : null;
  }

  function resolveRate(accountOverride, spotManual, spotCalibrated, spotDefault) {
    var list = [accountOverride, spotManual, spotCalibrated];
    for (var i = 0; i < list.length; i++) {
      if (isNum(list[i]) && list[i] > 0) return list[i];
    }
    return isNum(spotDefault) && spotDefault > 0 ? spotDefault : 10;
  }

  function invalidStone(reason, capacity) {
    return {
      state: 'invalid', reason: reason, capacity: capacity, effectiveCapacity: 0, stopReason: null,
      durationMs: null, fullAt: null, nowAt: null, overdueAt: null, elapsedMs: null, remainingMs: null,
      progress: null, estStones: 0, startsInFuture: false, urgency: null,
    };
  }

  /**
   * p = {startedAt, freeSlots, stonesPerSlot, ratePerHour, dailyCap?, droppedAtStart?, warnMin?, nowMin?}
   * Check order of the invalid reasons: bad-time, no-slots, no-rate, cap-reached, too-slow.
   */
  function stoneRunStatus(p, now) {
    p = p || {};
    var capacity = stoneCapacity(p.freeSlots, p.stonesPerSlot);
    if (!isNum(p.startedAt) || !isNum(now)) return invalidStone('bad-time', capacity);
    if (capacity === 0) return invalidStone('no-slots', capacity);
    var rate = num(p.ratePerHour, 0);
    if (rate <= 0) return invalidStone('no-rate', capacity);

    var effective = capacity;
    var stopReason = 'bag';
    var cap = num(p.dailyCap, 0);
    if (cap > 0) {
      var left = Math.max(0, Math.floor(cap) - Math.max(0, Math.floor(num(p.droppedAtStart, 0))));
      if (left < capacity) { effective = left; stopReason = 'daily-cap'; }
    }
    if (effective <= 0) return invalidStone('cap-reached', capacity);
    // a rate so small that the bag would take more than MAX_FILL_HOURS: no honest "full at" exists
    if (!(effective / rate <= MAX_FILL_HOURS)) return invalidStone('too-slow', capacity);

    var warnMin = num(p.warnMin, 60);
    var nowMin = num(p.nowMin, 15);
    var durationMs = Math.round(effective / rate * MS.HOUR);
    var fullAt = p.startedAt + durationMs;
    var elapsedMs = Math.max(0, now - p.startedAt);
    var remainingMs = Math.max(0, fullAt - now);
    var progress = durationMs > 0 ? clamp(elapsedMs / durationMs, 0, 1) : (now >= fullAt ? 1 : 0);
    var estStones = Math.floor(Math.min(effective, rate * elapsedMs / MS.HOUR) + 1e-9);
    var urgency = 'calm';
    if (now >= fullAt) urgency = 'overdue';
    else if (fullAt - now <= nowMin * MS.MIN) urgency = 'now';
    else if (fullAt - now <= warnMin * MS.MIN) urgency = 'soon';
    return {
      state: now >= fullAt ? 'full' : 'running',
      capacity: capacity,
      effectiveCapacity: effective,
      stopReason: stopReason,
      durationMs: durationMs,
      fullAt: fullAt,
      nowAt: fullAt - nowMin * MS.MIN,
      overdueAt: fullAt,
      elapsedMs: elapsedMs,
      remainingMs: remainingMs,
      progress: progress,
      estStones: estStones,
      startsInFuture: p.startedAt > now,
      urgency: urgency,
    };
  }

  function estimatedStonesAt(p, at) {
    return stoneRunStatus(p, at).estStones;
  }

  // ===================================================================
  // 6.2 Gold and consumption
  // ===================================================================
  function feeBp(feePct) { return Math.round(clamp(num(feePct, 0), 0, 100) * 100); }

  function goldValue(stones, unitPrice, feePct) {
    var n = Math.floor(clamp(num(stones, 0), 0, 1e5));
    var price = clamp(num(unitPrice, 0), 0, 1e6);
    return Math.floor(n * price * (10000 - feeBp(feePct)) / 10000);
  }

  function accountGold(perCharStones, unitPrice, feePct) {
    var list = Array.isArray(perCharStones) ? perCharStones : [];
    var perChar = list.map(function (s) { return goldValue(s, unitPrice, feePct); });
    var total = 0;
    for (var i = 0; i < perChar.length; i++) total += perChar[i];
    return { perChar: perChar, total: total };
  }

  function netGoldPerHour(ratePerHour, unitPrice, feePct, consumptionGoldPerHour) {
    var gross = Math.round(clamp(num(ratePerHour, 0), 0, 1e5) * clamp(num(unitPrice, 0), 0, 1e6) * (10000 - feeBp(feePct)) / 10000);
    var cg = isNum(consumptionGoldPerHour) ? Math.round(Math.max(0, consumptionGoldPerHour)) : null;
    return { gross: gross, consumptionGold: cg, net: gross - (cg === null ? 0 : cg), complete: cg !== null };
  }

  function ageWeight(at, now, halfLifeDays) {
    var hl = isNum(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : 30;
    if (!isNum(at) || !isNum(now)) return 1;
    return Math.pow(0.5, Math.max(0, now - at) / MS.DAY / hl);
  }

  function consumptionPerHour(observations, now, opts) {
    var halfLife = opts && isNum(opts.halfLifeDays) ? opts.halfLifeDays : 30;
    var list = (Array.isArray(observations) ? observations : []).filter(function (o) {
      return o && isNum(o.hours) && o.hours > 0 && o.consumption && isNum(o.consumption.amount) && o.consumption.amount >= 0;
    });
    if (!list.length) return { perHour: null, unitLabel: null, goldPerHour: null, sampleCount: 0, mixedUnits: false };
    // only the newest record's unit counts; ties go to the record appended last
    var newest = list[0];
    var newestAt = isNum(newest.at) ? newest.at : -Infinity;
    for (var i = 1; i < list.length; i++) {
      var a = isNum(list[i].at) ? list[i].at : -Infinity;
      if (a >= newestAt) { newest = list[i]; newestAt = a; }
    }
    var unit = newest.consumption.unitLabel;
    var same = list.filter(function (o) { return o.consumption.unitLabel === unit; });
    var mixed = same.length !== list.length;
    function ratio(items, pick) {
      var n = 0, d = 0;
      for (var k = 0; k < items.length; k++) {
        var w = ageWeight(items[k].at, now, halfLife);
        n += w * pick(items[k]);
        d += w * items[k].hours;
      }
      return d > 0 ? n / d : null;
    }
    var withGold = same.filter(function (o) { return isNum(o.consumption.goldValue) && o.consumption.goldValue >= 0; });
    return {
      perHour: ratio(same, function (o) { return o.consumption.amount; }),
      unitLabel: unit === undefined ? null : unit,
      goldPerHour: withGold.length ? ratio(withGold, function (o) { return o.consumption.goldValue; }) : null,
      sampleCount: same.length,
      mixedUnits: mixed,
    };
  }

  // 消耗 = MP spent (confirmed by the user 2026-10-03). Amounts are per character and age-weighted exactly
  // like consumptionPerHour, but the unit label is ignored: every record that carries a consumption amount
  // is MP, so older records saved with another label still count. Excluded records are skipped.
  function mpAccumulate(observations, now, halfLife) {
    var list = (Array.isArray(observations) ? observations : []).filter(function (o) {
      return o && !o.excluded && isNum(o.hours) && o.hours > 0 && o.consumption && isNum(o.consumption.amount) && o.consumption.amount >= 0;
    });
    var acc = { count: list.length, wHours: 0, wMp: 0, wStones: 0, wMpWithStones: 0 };
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      var w = ageWeight(o.at, now, halfLife);
      acc.wHours += w * o.hours;
      acc.wMp += w * o.consumption.amount;
      if (isNum(o.stones) && o.stones > 0) { acc.wStones += w * o.stones; acc.wMpWithStones += w * o.consumption.amount; }
    }
    // absurd records (a sum that overflows) count as no usable data instead of leaking Infinity/NaN
    if (!isNum(acc.wHours) || !isNum(acc.wMp) || !isNum(acc.wStones) || !isNum(acc.wMpWithStones)) {
      acc.wHours = 0; acc.wMp = 0; acc.wStones = 0; acc.wMpWithStones = 0;
    }
    return acc;
  }

  /**
   * History only: {mpPerHour, mpPerStone, stonesPerKMp, sampleCount}. When opts has a `manualPerHour` key
   * (even null) this is mpEstimate(observations, now, opts) instead, which returns a superset of these fields.
   */
  function mpStats(observations, now, opts) {
    if (opts && typeof opts === 'object' && hasOwn(opts, 'manualPerHour')) return mpEstimate(observations, now, opts);
    var halfLife = opts && isNum(opts.halfLifeDays) ? opts.halfLifeDays : 30;
    var a = mpAccumulate(observations, now, halfLife);
    var perHour = a.wHours > 0 ? a.wMp / a.wHours : null;
    var perStone = a.wStones > 0 ? a.wMpWithStones / a.wStones : null;
    return {
      mpPerHour: perHour,
      mpPerStone: perStone,
      stonesPerKMp: perStone !== null && perStone > 0 ? fin(1000 / perStone) : null,
      sampleCount: a.count,
    };
  }

  // ---- manual MP rate (what the user types: MP per 12 hours, per character) ----
  var MP_DEFAULTS = Object.freeze({ per12h: 17500, priorHours: 10, maxPer12h: 1000000 });
  var MP_HOURLY_CAP = 1e9; // anything larger is not a believable per-hour value and is treated as "not given"

  function fin(x) { return isNum(x) ? x : null; }
  /** MP per 12 hours -> MP per hour. null when x is not a finite number >= 0. */
  function mpPerHourFrom12h(x) { return isNum(x) && x >= 0 ? fin(x / 12) : null; }
  /** MP per hour -> MP per 12 hours (for showing a stored value). null when not a finite number >= 0. */
  function mpPer12hFromHour(x) { return isNum(x) && x >= 0 ? fin(x * 12) : null; }

  // the per-12-hours setting as stored: explicit null = "no number"; missing or garbage = the default
  function mpSettingPer12h(s) {
    s = isObj(s) ? s : {};
    if (s.mpPer12h === null) return null;
    return isNum(s.mpPer12h) && s.mpPer12h >= 0 ? s.mpPer12h : MP_DEFAULTS.per12h;
  }

  /**
   * The manual MP/hour of ONE character for this account: the account's own override (stone.mpPer12hOverride)
   * outranks settings.mpPer12h; null when neither holds a number. A missing setting means the default.
   */
  function resolveMpManual(settings, account) {
    var st = account && isObj(account.stone) ? account.stone : null;
    var ov = st ? st.mpPer12hOverride : null;
    if (isNum(ov) && ov >= 0) return mpPerHourFrom12h(ov);
    return mpPerHourFrom12h(mpSettingPer12h(settings));
  }

  /**
   * Manual number blended with settled history. All amounts are per ONE character.
   * opts = {manualPerHour, priorHours (10), halfLifeDays (30), ratePerHour (stones/h, to derive MP per stone)}.
   * estimate = (priorHours*manual + age-weighted MP) / (priorHours + age-weighted hours).
   * Returns {mpPerHour, mpPerStone, stonesPerKMp, sampleCount, source: 'none'|'manual'|'blended'|'data',
   *   manualPerHour, effectiveSampleHours, manualWeight (share of the manual number, null without one), priorHours (weight used)}.
   */
  function mpEstimate(observations, now, opts) {
    var o = isObj(opts) ? opts : {};
    var halfLife = isNum(o.halfLifeDays) && o.halfLifeDays > 0 ? o.halfLifeDays : 30;
    var prior = isNum(o.priorHours) && o.priorHours >= 0 ? o.priorHours : MP_DEFAULTS.priorHours;
    var manual = isNum(o.manualPerHour) && o.manualPerHour >= 0 && o.manualPerHour <= MP_HOURLY_CAP ? o.manualPerHour : null;
    var rate = isNum(o.ratePerHour) && o.ratePerHour > 0 ? o.ratePerHour : null;
    var a = mpAccumulate(observations, now, halfLife);
    var hasData = a.wHours > 0 && isNum(a.wMp);
    var pw = manual !== null ? prior : 0;
    var useManual = manual !== null && pw > 0;

    var perHour = null;
    var den = pw + (hasData ? a.wHours : 0);
    if (den > 0) perHour = ((useManual ? pw * manual : 0) + (hasData ? a.wMp : 0)) / den;
    else if (manual !== null) perHour = manual;
    perHour = fin(perHour);

    // MP per stone: the prior is worth `prior` hours at the spot rate; without a rate only the records speak
    var priorStones = useManual && rate !== null ? pw * rate : 0;
    var priorMp = priorStones > 0 ? pw * manual : 0;
    var perStone = null;
    if (priorStones + a.wStones > 0) perStone = (priorMp + a.wMpWithStones) / (priorStones + a.wStones);
    else if (manual !== null && rate !== null) perStone = manual / rate;
    perStone = fin(perStone);

    var source = 'none';
    if (perHour !== null) {
      if (useManual && hasData) source = 'blended';
      else if (hasData && !useManual) source = 'data';
      else source = 'manual';
    }
    return {
      mpPerHour: perHour,
      mpPerStone: perStone,
      stonesPerKMp: perStone !== null && perStone > 0 ? fin(1000 / perStone) : null,
      sampleCount: a.count,
      source: source,
      manualPerHour: manual,
      effectiveSampleHours: hasData ? a.wHours : 0,
      manualWeight: manual === null ? null : (den > 0 ? pw / den : 1),
      priorHours: pw,
    };
  }

  /** Where the number comes from, for the line under it ("你的設定" / "依 N 筆紀錄校準"). */
  function mpSourceLabel(est) {
    var e = isObj(est) ? est : {};
    var n = isNum(e.sampleCount) ? Math.max(0, Math.floor(e.sampleCount)) : 0;
    if (e.source === 'manual') return '你的設定';
    if (e.source === 'data') return '依 ' + n + ' 筆紀錄校準';
    if (e.source === 'blended') return '依 ' + n + ' 筆紀錄校準（含你的設定）';
    return '尚無數字';
  }

  /**
   * The signpost on the main page ("MP 每 12 小時 17,500／角色 · 調整"): the default number every account starts from
   * and how many accounts carry their own number instead.
   * -> {state: 'set'|'none', per12h (per character, null when none), perHour, overrides, accounts}
   */
  function mpHeadline(settings, accounts) {
    var per12h = mpSettingPer12h(settings);
    var list = Array.isArray(accounts) ? accounts : [];
    var overrides = 0;
    list.forEach(function (a) {
      var st = isObj(a) && isObj(a.stone) ? a.stone : null;
      if (st && isNum(st.mpPer12hOverride) && st.mpPer12hOverride >= 0) overrides++;
    });
    return { state: per12h === null ? 'none' : 'set', per12h: per12h, perHour: mpPerHourFrom12h(per12h), overrides: overrides, accounts: list.length };
  }

  /**
   * The compact row's MP one-liner, from an account view's `mp`.
   * {state: 'none'}   no MP number yet: the row shows a link to the input instead
   * {state: 'hidden'} there is a number but nothing to work out (no character can mine)
   * {state: 'ok', mode: 'to-full'|'round', perChar, total, characters, per12h, source}
   *   to-full = what is still needed until the bag is full (a live run), round = what one whole round needs (not started)
   */
  function mpNeedBrief(mp) {
    var m = isObj(mp) ? mp : {};
    if (m.source === 'none' || !isNum(m.mpPerHour)) return { state: 'none' };
    var perChar = isObj(m.needPerChar) ? m.needPerChar.forTime : null;
    var total = isObj(m.needTotal) ? m.needTotal.forTime : null;
    if (!isNum(perChar) || !isNum(total) || perChar < 0 || total < 0) return { state: 'hidden' };
    return {
      state: 'ok', mode: m.needMode === 'to-full' ? 'to-full' : 'round', perChar: perChar, total: total,
      characters: Math.max(1, Math.floor(num(m.characters, 1))), per12h: isNum(m.mpPer12h) ? m.mpPer12h : null, source: typeof m.source === 'string' ? m.source : 'none',
    };
  }

  /** a big amount in the short form the 4-6 account rows have room for: 9,800 / 26.3萬 / 1.2億 (never NaN) */
  function formatWan(n) {
    if (!isNum(n) || n <= 0) return '0';
    var wan = Math.round(n / 1e3) / 10;   // in units of 萬, one decimal
    if (wan >= 10000) return String(Math.round(n / 1e7) / 10).replace(/\.0$/, '') + '億';
    if (n >= 1e4) return String(wan).replace(/\.0$/, '') + '萬';
    return Math.round(n).toLocaleString('en-US');
  }

  // ---- view preferences kept in the browser (starcg_afk_ui): which view, which rows are open ----
  var UI_ID_RE = /^[a-z]_[a-z0-9]{3,12}$/;
  var UI_SPOT_RE = /^[a-z][a-z0-9_]{1,15}$/;
  var UI_MAX_IDS = 60;
  /**
   * Whatever came out of storage -> clean view preferences. Never throws, never trusts a key or a value.
   * {expanded: {accountId: bool} (character list open), rowOpen: {accountId: true} (compact row open),
   *  stripExpanded, compact (default true = 精簡), mpScope ('char' default | 'account'), ignoredAdopt: {spotId: text}}
   */
  function sanitizeUi(raw) {
    var o = isObj(raw) ? raw : {};
    var out = { expanded: {}, rowOpen: {}, stripExpanded: !!o.stripExpanded, compact: typeof o.compact === 'boolean' ? o.compact : true, mpScope: o.mpScope === 'account' ? 'account' : 'char', ignoredAdopt: {} };
    if (isObj(o.expanded)) {
      Object.keys(o.expanded).slice(0, UI_MAX_IDS).forEach(function (k) { if (UI_ID_RE.test(k)) out.expanded[k] = !!o.expanded[k]; });
    }
    if (isObj(o.rowOpen)) {
      var kept = 0;
      Object.keys(o.rowOpen).forEach(function (k) {
        if (kept < UI_MAX_IDS && UI_ID_RE.test(k) && o.rowOpen[k] === true) { out.rowOpen[k] = true; kept++; }
      });
    }
    if (isObj(o.ignoredAdopt)) {
      Object.keys(o.ignoredAdopt).slice(0, UI_MAX_IDS).forEach(function (k) { if (UI_SPOT_RE.test(k)) out.ignoredAdopt[k] = String(o.ignoredAdopt[k]).slice(0, 12); });
    }
    return out;
  }

  /** 'all' | 'some' | 'none': how many of the accounts' compact rows are open (drives the 全部展開 / 全部收合 button) */
  function rowsOpenState(accountIds, open) {
    var ids = Array.isArray(accountIds) ? accountIds : [];
    var map = isObj(open) ? open : {};
    var n = 0;
    ids.forEach(function (id) { if (map[id] === true) n++; });
    return ids.length > 0 && n === ids.length ? 'all' : n > 0 ? 'some' : 'none';
  }

  function charCountOf(n) { return Math.max(1, Math.floor(num(n, 1))); }
  function round4(x) { return Math.round(x * 10000) / 10000; }

  /**
   * What the user typed -> MP per 12 h per character (what gets stored). scope 'account' = the whole-account total,
   * divided by the number of characters (at least 1); anything else = already per character.
   * null when the value is not a finite number >= 0; clamped to 0..MP_DEFAULTS.maxPer12h; kept to 4 decimals.
   */
  function mpPerCharFromEntry(value, scope, characterCount) {
    if (!isNum(value) || value < 0) return null;
    var per = scope === 'account' ? value / charCountOf(characterCount) : value;
    return isNum(per) ? round4(clamp(per, 0, MP_DEFAULTS.maxPer12h)) : null;
  }

  /** The inverse for showing a stored per-character value in the chosen scope (2 decimals). */
  function mpEntryFromPerChar(perChar, scope, characterCount) {
    if (!isNum(perChar) || perChar < 0) return null;
    var v = scope === 'account' ? perChar * charCountOf(characterCount) : perChar;
    if (!isNum(v)) return null;
    return v > 1e12 ? v : round2(v); // (rounding a huge value would overflow)
  }

  // Gold cost of the MP one character burns per hour: MP/h x gold per 1 MP (potion price / MP restored).
  // null when either side is unknown (the caller then shows 未計入消耗); 0 gold per MP is a real value (free MP).
  // Feed the result to netGoldPerHour as consumptionGoldPerHour.
  function mpGoldPerHour(mpPerHour, goldPerMp) {
    if (!isNum(mpPerHour) || mpPerHour < 0 || !isNum(goldPerMp) || goldPerMp < 0) return null;
    var g = mpPerHour * goldPerMp;
    return isFinite(g) ? g : null;
  }

  // How much MP one character still needs. forTime = MP/h x hours left; forStones = MP/stone x stones left.
  function mpForRun(stats, remaining) {
    var s = stats || {};
    var r = remaining || {};
    return {
      forTime: isNum(s.mpPerHour) && isNum(r.hoursRemaining) && r.hoursRemaining >= 0 ? s.mpPerHour * r.hoursRemaining : null,
      forStones: isNum(s.mpPerStone) && isNum(r.stonesRemaining) && r.stonesRemaining >= 0 ? s.mpPerStone * r.stonesRemaining : null,
    };
  }

  /** mpForRun for one character AND for the whole account (x characters, at least 1). Non-finite results are null. */
  function mpForAccount(stats, remaining, characterCount) {
    var one = mpForRun(stats, remaining);
    var n = charCountOf(characterCount);
    var perChar = { forTime: fin(one.forTime), forStones: fin(one.forStones) };
    return {
      characters: n,
      perChar: perChar,
      total: { forTime: perChar.forTime === null ? null : fin(perChar.forTime * n), forStones: perChar.forStones === null ? null : fin(perChar.forStones * n) },
    };
  }

  // ===================================================================
  // 6.3 Gather
  // ===================================================================
  function gatherFillMs(baseMinutes, o) {
    var base = num(baseMinutes, 0);
    if (base <= 0) return null;
    o = o || {};
    var slots = o.slots === 6 ? 6 : 5;
    var speed = clamp(num(o.speed, 1), 0.5, 3);
    var ms = Math.round(base * MS.MIN * (slots * 800) / 4000 / speed);
    return isFinite(ms) && ms > 0 ? ms : null;
  }

  function invalidGather(reason) {
    return {
      state: 'invalid', reason: reason, fillMs: null, stopReason: null, fullAt: null, collectBy: null,
      nowAt: null, overdueAt: null, bufferMs: null, bufferClamped: false, startsInFuture: false, elapsedMs: null,
      remainingToFullMs: null, remainingToCollectMs: null, progress: null, bufferMarker: null, urgency: null,
    };
  }

  /**
   * Gathering only stops when the gather bag is full; a bank deposit keeps it running.
   * collectBy = fullAt - buffer (the buffer is clamped to half of the fill).
   */
  function gatherRunStatus(run, now, o) {
    run = run || {};
    o = o || {};
    var fill = gatherFillMs(run.baseMinutes, run);
    if (fill === null) return invalidGather('no-minutes');
    if (!isNum(run.startedAt) || !isNum(now)) return invalidGather('bad-time');

    var limit = fill;
    var stopReason = 'bag';
    var wh = num(run.workHoursAtStart, 0);
    if (wh > 0) {
      var burn = isNum(o.burn) && o.burn > 0 ? o.burn : 1;
      var w = Math.round(wh * burn * MS.HOUR);
      if (w > 0 && w < fill) { limit = w; stopReason = 'workhours'; }
    }
    var bm = isNum(run.bufferMin) ? run.bufferMin : (isNum(o.bufferMin) ? o.bufferMin : 10);
    var bufferMs = Math.round(Math.max(0, bm) * MS.MIN);
    var maxBuffer = Math.floor(limit / 2);
    var bufferClamped = false;
    if (bufferMs > maxBuffer) { bufferMs = maxBuffer; bufferClamped = true; }

    var fullAt = run.startedAt + limit;
    var collectBy = fullAt - bufferMs;
    var elapsedMs = Math.max(0, now - run.startedAt);
    var soonMs = isNum(o.soonMs) && o.soonMs >= 0 ? o.soonMs : Math.min(30 * MS.MIN, Math.max(10 * MS.MIN, 0.1 * limit));
    var urgency = 'calm';
    if (now >= fullAt) urgency = 'overdue';
    else if (now >= collectBy) urgency = 'now';
    else if (collectBy - now <= soonMs) urgency = 'soon';
    return {
      state: 'running',
      fillMs: limit,
      stopReason: stopReason,
      fullAt: fullAt,
      collectBy: collectBy,
      nowAt: collectBy,
      overdueAt: fullAt,
      bufferMs: bufferMs,
      bufferClamped: bufferClamped,
      startsInFuture: run.startedAt > now,
      elapsedMs: elapsedMs,
      remainingToFullMs: Math.max(0, fullAt - now),
      remainingToCollectMs: collectBy - now,
      progress: clamp(elapsedMs / limit, 0, 1),
      bufferMarker: (limit - bufferMs) / limit,
      urgency: urgency,
    };
  }

  function freshFired() { return { now: false, overdue: false }; }

  function restartGather(run, at) {
    if (!run || !isNum(at)) return run;
    return Object.assign({}, run, {
      startedAt: at,
      lastDepositAt: at,
      fired: freshFired(),
      pausedAt: run.pausedAt != null ? at : null,
    });
  }

  function makeGatherRun(plan, at) {
    return Object.assign({}, plan, { startedAt: at, pausedAt: null, lastDepositAt: null, fired: freshFired() });
  }

  function restartCharGather(character, at) {
    if (!character || !isNum(at)) return character;
    if (character.gather) {
      var run = makeGatherRun(character.gather, at);
      run.lastDepositAt = at;
      if (character.gatherRun && character.gatherRun.pausedAt != null) run.pausedAt = at;
      return Object.assign({}, character, { gatherRun: run });
    }
    if (character.gatherRun) {
      // A run whose plan was CLEARED (plan null): the restart is what applies that edit, so the old run is dropped.
      // (Keeping it alive here made a cleared plan impossible to apply: the 待套用 badge never went away.)
      return Object.assign({}, character, { gatherRun: null });
    }
    return character;
  }

  function bestSpot(item) {
    var spots = item && Array.isArray(item.spots) ? item.spots : [];
    var best = -1;
    var i;
    for (i = 0; i < spots.length; i++) {
      var s = spots[i];
      if (!s || s.kind === 'shed' || !(isNum(s.minutes) && s.minutes > 0)) continue;
      if (best < 0 || s.minutes < spots[best].minutes) best = i;
    }
    if (best >= 0) return best;
    for (i = 0; i < spots.length; i++) {
      if (spots[i] && spots[i].kind === 'shed' && isNum(spots[i].minutes) && spots[i].minutes > 0) return i;
    }
    return null;
  }

  function spotMinutes(itemKey, spot, overrides) {
    if (!spot) return null;
    var k = itemKey + '|' + spot.key;
    if (overrides && typeof overrides === 'object' && hasOwn(overrides, k) && isNum(overrides[k]) && overrides[k] > 0) return overrides[k];
    return isNum(spot.minutes) && spot.minutes > 0 ? spot.minutes : null;
  }

  function lookupGather(data, itemKey, spotKey, hint) {
    var none = { item: null, spot: null, matched: null };
    try {
      var cats = data && Array.isArray(data.categories) ? data.categories : [];
      var findItem = function (key, category, name) {
        for (var i = 0; i < cats.length; i++) {
          var c = cats[i];
          if (!c || !Array.isArray(c.items)) continue;
          if (category != null && c.key !== category) continue;
          for (var j = 0; j < c.items.length; j++) {
            var it = c.items[j];
            if (!it) continue;
            if (name != null ? it.name === name : it.key === key) return it;
          }
        }
        return null;
      };
      var pickSpot = function (item) {
        var spots = Array.isArray(item.spots) ? item.spots : [];
        for (var i = 0; i < spots.length; i++) if (spots[i] && spots[i].key === spotKey) return spots[i];
        return null;
      };
      var item = findItem(itemKey, null, null);
      var matched = 'exact';
      if (!item && data && isObj(data.aliases) && isSafeKey(itemKey) && hasOwn(data.aliases, itemKey)) {
        item = findItem(data.aliases[itemKey], null, null);
        matched = 'alias';
      }
      if (!item && hint && hint.name != null) {
        item = findItem(null, hint.category != null ? hint.category : null, hint.name);
        matched = 'name';
      }
      if (!item) return none;
      return { item: item, spot: pickSpot(item), matched: matched };
    } catch (e) {
      return none;
    }
  }

  // ===================================================================
  // 6.4 Calibration and rates
  // ===================================================================
  function medianOf(sorted) {
    var n = sorted.length;
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }

  /**
   * Gamma-Poisson posterior mean with recency decay (see spec 4.5). Observations are per ONE
   * character. The caller pre-filters by spot and the excluded flag.
   */
  function calibrate(observations, prior, now, opts) {
    var pr = prior && typeof prior === 'object' ? prior : {};
    var r0 = isNum(pr.ratePerHour) && pr.ratePerHour > 0 ? pr.ratePerHour : 10;
    var h0 = isNum(pr.strengthHours) && pr.strengthHours >= 0 ? pr.strengthHours : 10;
    var o = opts || {};
    var halfLife = isNum(o.halfLifeDays) && o.halfLifeDays > 0 ? o.halfLifeDays : 30;
    var minHours = isNum(o.minHours) && o.minHours >= 0 ? o.minHours : 0.5;
    var factor = isNum(o.outlierFactor) && o.outlierFactor > 1 ? o.outlierFactor : 3;
    var minForOutlier = isNum(o.minForOutlier) ? o.minForOutlier : 5;

    var valid = (Array.isArray(observations) ? observations : []).filter(function (x) {
      return x && isNum(x.hours) && x.hours > 0 && isNum(x.stones) && x.stones >= 0 && isNum(x.at);
    });
    var enough = valid.filter(function (x) { return x.hours >= minHours; });
    // A record flagged `full` (the bag was already full when it was settled) is right-censored: mining
    // stopped at capacity, so stones/hours is only a LOWER bound on the real rate. Treating it as exact
    // would drag the rate down and make "full" alerts late. A censored record therefore never lowers the
    // estimate: it counts only when its lower bound is above what the exact records (plus the prior) say.
    var exact = enough.filter(function (x) { return x.full !== true; });
    var censored = enough.filter(function (x) { return x.full === true; });
    if (exact.length >= minForOutlier) {
      var ratios = exact.map(function (x) { return x.stones / x.hours; }).sort(function (a, b) { return a - b; });
      var med = medianOf(ratios);
      exact = exact.filter(function (x) {
        var q = x.stones / x.hours;
        return q <= factor * med && q >= med / factor;
      });
    }
    function posterior(list) {
      var s = 0, wsum = 0;
      for (var i = 0; i < list.length; i++) {
        var w = ageWeight(list[i].at, now, halfLife);
        s += w * list[i].stones;
        wsum += w * list[i].hours;
      }
      return { S: s, W: wsum };
    }
    var p0 = posterior(exact);
    var a0 = r0 * h0 + p0.S;
    var b0 = h0 + p0.W;
    var baseRate = exact.length === 0 ? r0 : (b0 > 0 ? a0 / b0 : r0);
    var lifted = censored.filter(function (x) { return x.stones / x.hours > baseRate; });
    var used = exact.concat(lifted);
    var ps = posterior(used);
    var S = ps.S, W = ps.W;
    var a = r0 * h0 + S;
    var b = h0 + W;
    var rate = used.length === 0 ? r0 : (b > 0 ? a / b : r0);
    var confidence = b > 0 ? W / b : 0;
    var sd = b > 0 ? Math.sqrt(a) / b : 0;
    return {
      ratePerHour: rate,
      sampleCount: valid.length,
      usedCount: used.length,
      censoredCount: censored.length,
      censoredIgnored: censored.length - lifted.length,
      effectiveHours: W,
      confidence: confidence,
      label: confidence < 0.35 ? '低' : (confidence < 0.7 ? '中' : '高'),
      low: Math.max(0, rate - 1.28 * sd),
      high: rate + 1.28 * sd,
      method: used.length ? 'gamma-poisson-recency' : 'prior',
    };
  }

  function spotRate(spot, observations, now, accountRateOverride) {
    if (!spot) return { ratePerHour: 10, source: 'default', calibration: null };
    var def = isNum(spot.defaultRate) && spot.defaultRate > 0 ? spot.defaultRate : 10;
    var mine = (Array.isArray(observations) ? observations : []).filter(function (o) {
      return o && o.spotId === spot.id && !o.excluded;
    });
    var cal = calibrate(mine, { ratePerHour: def, strengthHours: 10 }, now);
    var has = cal.usedCount > 0;
    var ratePerHour = resolveRate(accountRateOverride, spot.manualRate, has ? cal.ratePerHour : null, def);
    var source = 'default';
    if (num(accountRateOverride, 0) > 0) source = 'account';
    else if (num(spot.manualRate, 0) > 0) source = 'manual';
    else if (has) source = 'calibrated';
    var suggestAdopt = source === 'manual' && has && cal.confidence >= 0.35 && cal.ratePerHour > 0 &&
      Math.abs(spot.manualRate - cal.ratePerHour) / cal.ratePerHour > 0.10;
    // same idea for a rate typed into one account: it silently outranks calibration, so say when it has drifted
    var suggestAdoptOverride = source === 'account' && has && cal.confidence >= 0.35 && cal.ratePerHour > 0 &&
      Math.abs(num(accountRateOverride, 0) - cal.ratePerHour) / cal.ratePerHour > 0.10;
    return {
      ratePerHour: ratePerHour,
      source: source,
      calibration: has ? {
        ratePerHour: cal.ratePerHour, confidence: cal.confidence, label: cal.label, low: cal.low, high: cal.high,
        usedCount: cal.usedCount, sampleCount: cal.sampleCount, effectiveHours: cal.effectiveHours, suggestAdopt: suggestAdopt,
        suggestAdoptOverride: suggestAdoptOverride, censoredCount: cal.censoredCount, censoredIgnored: cal.censoredIgnored,
      } : null,
    };
  }

  // ===================================================================
  // 6.5 Pause, online, account operations
  // ===================================================================
  function effectiveNow(run, now) {
    return run && isNum(run.pausedAt) ? Math.min(run.pausedAt, now) : now;
  }

  function pauseRun(run, at) {
    if (!run || run.pausedAt != null || !isNum(at)) return run;
    return Object.assign({}, run, { pausedAt: at });
  }

  function resumeRun(run, at) {
    if (!run || run.pausedAt == null || !isNum(at)) return run;
    var shift = isNum(run.pausedAt) ? Math.max(0, at - run.pausedAt) : 0;
    return Object.assign({}, run, { startedAt: run.startedAt + shift, pausedAt: null });
  }

  function isOnline(account) {
    var list = account && Array.isArray(account.onlineSessions) ? account.onlineSessions : [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].end == null) return true;
    return false;
  }

  function mapRuns(account, fn) {
    var out = Object.assign({}, account);
    if (account.stoneRun) out.stoneRun = fn(account.stoneRun);
    if (Array.isArray(account.characters)) {
      out.characters = account.characters.map(function (c) {
        return c && c.gatherRun ? Object.assign({}, c, { gatherRun: fn(c.gatherRun) }) : c;
      });
    }
    return out;
  }

  function goOnline(account, at, settings) { // eslint-disable-line no-unused-vars
    if (!account || !isNum(at) || isOnline(account)) return account;
    var sessions = (Array.isArray(account.onlineSessions) ? account.onlineSessions : []).concat([{ start: at, end: null }]);
    if (sessions.length > LIMITS.sessions) sessions = sessions.slice(sessions.length - LIMITS.sessions);
    return mapRuns(Object.assign({}, account, { onlineSessions: sessions }), function (r) { return resumeRun(r, at); });
  }

  function goOffline(account, at, settings) {
    if (!account || !isNum(at) || !isOnline(account)) return account;
    var sessions = account.onlineSessions.map(function (s) {
      return s && s.end == null ? { start: s.start, end: Math.max(at, s.start) } : s;
    });
    var next = Object.assign({}, account, { onlineSessions: sessions });
    if (settings && settings.pauseRunsOnOffline === false) return next;
    return mapRuns(next, function (r) { return pauseRun(r, at); });
  }

  function slotsFor(account, c) {
    var stone = account.stone || {};
    return Math.floor(num(c && c.freeSlots != null ? c.freeSlots : stone.freeSlots, 0));
  }

  function makeStoneRun(account, at) {
    var stone = account.stone || {};
    var chars = Array.isArray(account.characters) ? account.characters : [];
    return {
      spotId: stone.spotId != null ? stone.spotId : null,
      startedAt: at,
      pausedAt: null,
      freeSlotsAtStart: chars.map(function (c) { return slotsFor(account, c); }),
      droppedAtStart: num(stone.droppedToday, 0) || 0,
      fired: freshFired(),
    };
  }

  function findSpot(spots, id) {
    if (id == null || !Array.isArray(spots)) return null;
    for (var i = 0; i < spots.length; i++) if (spots[i] && spots[i].id === id) return spots[i];
    return null;
  }

  function settingsOf(s) {
    s = isObj(s) ? s : {};
    return {
      stonesPerSlot: num(s.stonesPerSlot, 3),
      stoneUnitPrice: num(s.stoneUnitPrice, 532),
      stoneFeePct: num(s.stoneFeePct, 0),
      dailyCap: isNum(s.dailyCap) && s.dailyCap > 0 ? s.dailyCap : null,
      gatherBufferMin: num(s.gatherBufferMin, 10),
      stoneWarnMin: num(s.stoneWarnMin, 60),
      stoneNowMin: num(s.stoneNowMin, 15),
      workHourBurn: num(s.workHourBurn, 1),
      mpPer12h: mpSettingPer12h(s),
    };
  }

  function startAccount(account, ctx, at) {
    if (!account || !isNum(at)) return account;
    ctx = ctx || {};
    var st = settingsOf(ctx.settings);
    var a = goOnline(account, at, ctx.settings);
    var stone = a.stone || {};
    var chars = Array.isArray(a.characters) ? a.characters : [];

    var stoneRun = a.stoneRun;
    if (!stoneRun && stone.spotId != null) {
      var spot = Array.isArray(ctx.spots) ? findSpot(ctx.spots, stone.spotId) : { id: stone.spotId };
      if (spot) {
        var rate = spotRate(spot, ctx.observations, at, stone.rateOverride).ratePerHour;
        var dailyCap = stone.dailyCap != null ? stone.dailyCap : st.dailyCap;
        var anyValid = chars.some(function (c) {
          return stoneRunStatus({
            startedAt: at, freeSlots: slotsFor(a, c), stonesPerSlot: st.stonesPerSlot, ratePerHour: rate,
            dailyCap: dailyCap, droppedAtStart: stone.droppedToday,
          }, at).state !== 'invalid';
        });
        if (anyValid) stoneRun = makeStoneRun(a, at);
      }
    }

    var gatherChanged = false;
    var nextChars = chars.map(function (c) {
      if (c && !c.gatherRun && c.gather && gatherFillMs(c.gather.baseMinutes, c.gather) !== null) {
        gatherChanged = true;
        return Object.assign({}, c, { gatherRun: makeGatherRun(c.gather, at) });
      }
      return c;
    });

    if (stoneRun === a.stoneRun && !gatherChanged) return a;
    var out = Object.assign({}, a, { stoneRun: stoneRun });
    if (gatherChanged) out.characters = nextChars;
    return out;
  }

  function restartStone(account, at) {
    if (!account || !account.stoneRun || !isNum(at)) return account;
    var fresh = makeStoneRun(account, at);
    if (account.stoneRun.pausedAt != null) fresh.pausedAt = at;
    return Object.assign({}, account, { stoneRun: fresh });
  }

  function clearRuns(account) {
    if (!account) return account;
    var chars = Array.isArray(account.characters) ? account.characters : [];
    var hasRun = !!account.stoneRun || chars.some(function (c) { return c && c.gatherRun; });
    if (!hasRun) return account;
    var out = Object.assign({}, account, { stoneRun: null });
    if (Array.isArray(account.characters)) {
      out.characters = chars.map(function (c) { return c && c.gatherRun ? Object.assign({}, c, { gatherRun: null }) : c; });
    }
    return out;
  }

  // ===================================================================
  // 6.6 Online stats, usage, sorting
  // ===================================================================
  function onlineStats(sessions, now, windowDays, o) {
    var days = isNum(windowDays) && windowDays >= 1 ? Math.min(Math.floor(windowDays), 3650) : 7;
    var maxOpen = o && isNum(o.maxOpenMs) && o.maxOpenMs >= 0 ? o.maxOpenMs : 48 * MS.HOUR;
    var buckets = [];
    var i;
    for (i = 0; i < days; i++) buckets.push(0);
    var empty = { currentSessionMs: null, staleOpen: false, totalMs: 0, buckets: buckets, longestMs: 0 };
    if (!isNum(now)) return empty;

    var windowStart = now - days * MS.DAY;
    var intervals = [];
    var current = null;
    var list = Array.isArray(sessions) ? sessions : [];
    for (i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || !isNum(s.start) || s.start > now) continue;
      var open = s.end == null;
      var end = open ? now : s.end;
      if (!isNum(end) || end < s.start) continue;
      if (open) current = current === null ? now - s.start : Math.max(current, now - s.start);
      var lo = Math.max(s.start, windowStart);
      var hi = Math.min(end, now);
      if (hi > lo) intervals.push([lo, hi]);
    }
    intervals.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [];
    for (i = 0; i < intervals.length; i++) {
      var last = merged[merged.length - 1];
      if (last && intervals[i][0] <= last[1]) last[1] = Math.max(last[1], intervals[i][1]);
      else merged.push([intervals[i][0], intervals[i][1]]);
    }
    var total = 0, longest = 0;
    for (i = 0; i < merged.length; i++) {
      var len = merged[i][1] - merged[i][0];
      total += len;
      if (len > longest) longest = len;
    }
    for (i = 0; i < days; i++) {
      var bHi = now - i * MS.DAY;
      var bLo = bHi - MS.DAY;
      var t = 0;
      for (var k = 0; k < merged.length; k++) {
        var x = Math.max(merged[k][0], bLo);
        var y = Math.min(merged[k][1], bHi);
        if (y > x) t += y - x;
      }
      buckets[i] = t;
    }
    return { currentSessionMs: current, staleOpen: current !== null && current > maxOpen, totalMs: total, buckets: buckets, longestMs: longest };
  }

  function normUsage(usage) {
    var u = isObj(usage) ? usage : {};
    var recent = [];
    var i, k;
    if (Array.isArray(u.recent)) {
      for (i = 0; i < u.recent.length; i++) {
        var r = u.recent[i];
        if (r && isSafeKey(r.key)) recent.push({ key: r.key, at: num(r.at, 0) });
      }
    }
    var freq = {};
    if (isObj(u.freq)) {
      var fk = Object.keys(u.freq);
      for (i = 0; i < fk.length; i++) if (isSafeKey(fk[i]) && isNum(u.freq[fk[i]])) freq[fk[i]] = u.freq[fk[i]];
    }
    var lastSpot = {};
    if (isObj(u.lastSpot)) {
      var lk = Object.keys(u.lastSpot);
      for (k = 0; k < lk.length; k++) if (isSafeKey(lk[k]) && typeof u.lastSpot[lk[k]] === 'string') lastSpot[lk[k]] = u.lastSpot[lk[k]];
    }
    return { recent: recent, freq: freq, lastSpot: lastSpot };
  }

  function recordPick(usage, key, now) {
    var u = normUsage(usage);
    if (typeof key !== 'string' || key === '' || !isSafeKey(key)) return u;
    var recent = [{ key: key, at: num(now, 0) }]
      .concat(u.recent.filter(function (x) { return x.key !== key; }))
      .slice(0, LIMITS.usageRecent);
    var freq = u.freq;
    freq[key] = (hasOwn(freq, key) ? freq[key] : 0) + 1;
    var keys = Object.keys(freq);
    if (keys.length > LIMITS.usageKeys) {
      var lastAt = {};
      recent.forEach(function (r) { if (!hasOwn(lastAt, r.key)) lastAt[r.key] = r.at; });
      var victims = keys.filter(function (k) { return k !== key; }).sort(function (a, b) {
        if (freq[a] !== freq[b]) return freq[a] - freq[b];
        var la = hasOwn(lastAt, a) ? lastAt[a] : -Infinity;
        var lb = hasOwn(lastAt, b) ? lastAt[b] : -Infinity;
        if (la !== lb) return la - lb;
        return a < b ? 1 : -1;
      });
      victims.slice(0, keys.length - LIMITS.usageKeys).forEach(function (k) { delete freq[k]; });
    }
    return { recent: recent, freq: freq, lastSpot: u.lastSpot };
  }

  function quickPicks(usage, topN, opts) {
    var n = Math.floor(num(topN, 0));
    if (n <= 0) return [];
    var u = normUsage(usage);
    var prefix = opts && typeof opts.prefix === 'string' ? opts.prefix : '';
    var ok = function (k) { return prefix === '' || k.indexOf(prefix) === 0; };
    var out = [];
    var seen = {};
    var half = Math.ceil(n / 2);
    var newest = {};
    u.recent.forEach(function (r) { if (!hasOwn(newest, r.key) || r.at > newest[r.key]) newest[r.key] = r.at; });
    var i;
    for (i = 0; i < u.recent.length && out.length < half; i++) {
      var k = u.recent[i].key;
      if (!ok(k) || hasOwn(seen, k)) continue;
      seen[k] = true;
      out.push({ key: k, src: 'recent' });
    }
    var freqKeys = Object.keys(u.freq).filter(function (f) { return ok(f) && !hasOwn(seen, f) && u.freq[f] > 0; });
    freqKeys.sort(function (a, b) {
      if (u.freq[a] !== u.freq[b]) return u.freq[b] - u.freq[a];
      var na = hasOwn(newest, a) ? newest[a] : -Infinity;
      var nb = hasOwn(newest, b) ? newest[b] : -Infinity;
      if (na !== nb) return nb - na;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    for (i = 0; i < freqKeys.length && out.length < n; i++) out.push({ key: freqKeys[i], src: 'frequent' });
    return out;
  }

  var URGENCY_RANK = { overdue: 0, now: 1, soon: 2, calm: 3 };

  function urgencySort(items) {
    var list = Array.isArray(items) ? items : [];
    var rankOf = function (x) { return x && typeof x.urgency === 'string' && hasOwn(URGENCY_RANK, x.urgency) ? URGENCY_RANK[x.urgency] : 4; };
    var remOf = function (x) { return x && isNum(x.remainingMs) ? x.remainingMs : Infinity; };
    return list.map(function (x, i) { return { x: x, i: i }; }).sort(function (A, B) {
      var ra = rankOf(A.x), rb = rankOf(B.x);
      if (ra !== rb) return ra - rb;
      if (ra < 4) {
        var ma = remOf(A.x), mb = remOf(B.x);
        if (ma !== mb) return ma < mb ? -1 : 1;
      }
      return A.i - B.i;
    }).map(function (p) { return p.x; });
  }

  // ===================================================================
  // 6.7 View model
  // ===================================================================
  var URGENCY_SEVERITY = { calm: 0, soon: 1, now: 2, overdue: 3 };

  function accountView(account, ctx, now) {
    account = account || {};
    ctx = ctx || {};
    var st = settingsOf(ctx.settings);
    var spots = Array.isArray(ctx.spots) ? ctx.spots : [];
    var observations = Array.isArray(ctx.observations) ? ctx.observations : [];
    var chars = (Array.isArray(account.characters) ? account.characters : []).map(function (c) { return c || {}; });
    var plan = isObj(account.stone) ? account.stone : {};
    var online = isOnline(account);
    var os = onlineStats(account.onlineSessions, now, 7);
    var spot = findSpot(spots, plan.spotId);
    var sr = spot ? spotRate(spot, observations, now, plan.rateOverride) : null;
    var rate = sr ? sr.ratePerHour : 0;
    var dailyCap = plan.dailyCap != null ? plan.dailyCap : st.dailyCap;
    var slotsOf = function (c) { return c.freeSlots != null ? c.freeSlots : plan.freeSlots; };
    var stoneParams = function (startedAt, freeSlots, dropped, r) {
      return {
        startedAt: startedAt, freeSlots: freeSlots, stonesPerSlot: st.stonesPerSlot, ratePerHour: r,
        dailyCap: dailyCap, droppedAtStart: dropped, warnMin: st.stoneWarnMin, nowMin: st.stoneNowMin,
      };
    };
    var gatherOpts = { bufferMin: st.gatherBufferMin, burn: st.workHourBurn };

    // ---- stone plan (per character, from the plan) ----
    var capacities = chars.map(function (c) { return stoneCapacity(slotsOf(c), st.stonesPerSlot); });
    var planStatus = chars.map(function (c) {
      return stoneRunStatus(stoneParams(0, slotsOf(c), num(plan.droppedToday, 0), rate), 0);
    });
    var validPlan = planStatus.filter(function (s) { return s.state !== 'invalid'; });
    var effCaps = planStatus.map(function (s) { return s.state === 'invalid' ? 0 : s.effectiveCapacity; });
    var planOut = { state: validPlan.length ? 'ok' : 'invalid' };
    if (!validPlan.length) {
      planOut.reason = !chars.length ? 'no-characters' : (!spot ? 'no-spot' : planStatus[0].reason);
    }
    var minCap = validPlan.length ? Math.min.apply(null, validPlan.map(function (s) { return s.effectiveCapacity; })) : 0;
    var maxCap = validPlan.length ? Math.max.apply(null, validPlan.map(function (s) { return s.effectiveCapacity; })) : 0;
    planOut.firstFullHours = validPlan.length ? hoursToFull(minCap, rate) : null;
    planOut.lastFullHours = validPlan.length ? hoursToFull(maxCap, rate) : null;
    planOut.capacity = effCaps.length ? Math.max.apply(null, effCaps) : 0;
    planOut.goldAtFull = accountGold(effCaps, st.stoneUnitPrice, st.stoneFeePct);

    // ---- stone run ----
    var runOut = null;
    if (account.stoneRun) {
      var run = account.stoneRun;
      var paused = run.pausedAt != null;
      var eff = effectiveNow(run, now);
      var runSpot = findSpot(spots, run.spotId) || spot;
      var runRate = runSpot === spot ? rate : (runSpot ? spotRate(runSpot, observations, now, plan.rateOverride).ratePerHour : 0);
      var startSlots = Array.isArray(run.freeSlotsAtStart) ? run.freeSlotsAtStart : [];
      var per = chars.map(function (c, i) {
        return stoneRunStatus(stoneParams(run.startedAt, startSlots[i] != null ? startSlots[i] : slotsOf(c), num(run.droppedAtStart, 0), runRate), eff);
      });
      var order = per.map(function (s, i) { return { s: s, i: i }; })
        .filter(function (x) { return x.s.state !== 'invalid'; })
        .sort(function (a, b) { return (a.s.fullAt - b.s.fullAt) || (a.i - b.i); });
      var first = order.length ? order[0] : null;
      var est = per.map(function (s) { return s.state === 'invalid' ? 0 : s.estStones; });
      var full = per.map(function (s) { return s.state === 'invalid' ? 0 : s.effectiveCapacity; });
      runOut = {
        paused: paused,
        state: first ? first.s.state : 'invalid',
        perChar: per,
        fullCharIndex: first ? first.i : null,
        status: first ? first.s : null,
        urgency: first ? first.s.urgency : null,
        actAt: first ? first.s.fullAt : null,
        actRemainingMs: first ? first.s.fullAt - eff : null,
        estStones: est,
        goldNow: accountGold(est, st.stoneUnitPrice, st.stoneFeePct),
        goldAtFull: accountGold(full, st.stoneUnitPrice, st.stoneFeePct),
        spotId: runSpot ? runSpot.id : null,
        spotName: runSpot ? runSpot.name : null,
        ratePerHour: runRate,
      };
      if (!first) runOut.reason = !per.length ? 'no-characters' : per[0].reason;
    }

    // ---- gather timers ----
    var gathers = [];
    chars.forEach(function (c, i) {
      if (!c.gather && !c.gatherRun) return;
      var g = c.gatherRun;
      var src = g || c.gather;
      var item = {
        charIndex: i,
        charId: c.id,
        charName: c.name,
        groupKey: gatherGroupKey(account.id, src),
        groupCount: 1,
        plan: c.gather || null,
        itemName: src.itemName,
        placeLabel: src.placeLabel,
        category: src.category,
        planStatus: c.gather ? gatherRunStatus(Object.assign({}, c.gather, { startedAt: 0 }), 0, gatherOpts) : null,
        run: null,
      };
      if (g) {
        var gEff = effectiveNow(g, now);
        var gs = gatherRunStatus(g, gEff, gatherOpts);
        var valid = gs.state === 'running';
        item.run = {
          paused: g.pausedAt != null,
          state: gs.state,
          status: valid ? gs : null,
          urgency: valid ? gs.urgency : null,
          actAt: valid ? gs.collectBy : null,
          actRemainingMs: valid ? gs.collectBy - gEff : null,
        };
        if (!valid) item.run.reason = gs.reason;
      }
      gathers.push(item);
    });

    // ---- gather groups: characters whose plan, start and pause are identical share ONE timer box ----
    var gatherGroups = groupGathers(gathers, chars.length);
    var groupSize = new Map();
    gatherGroups.forEach(function (g) { groupSize.set(g.key, g.count); });
    gathers.forEach(function (it) { it.groupCount = groupSize.get(it.groupKey) || 1; });

    // ---- MP (消耗): the user's number blended with settled history of this spot; per character AND per account ----
    // A live run keeps ITS spot and rate until restarted (like the gold block), so the MP history and the
    // MP-per-stone figure must come from the run's spot, not from a plan spot the user changed meanwhile.
    var runIsLive = !!(runOut && runOut.status);
    var mpSpotId = runIsLive && runOut.spotId != null ? runOut.spotId : (spot ? spot.id : null);
    var mpRate = runIsLive ? runOut.ratePerHour : rate;
    var manualPerHour = resolveMpManual(ctx.settings, account);
    var spotObs = mpSpotId != null ? observations.filter(function (o) { return o && o.spotId === mpSpotId; }) : [];
    var est = mpEstimate(spotObs, now, { manualPerHour: manualPerHour, ratePerHour: mpRate > 0 ? mpRate : null });
    var mpRuns = []; // one {hoursRemaining, stonesRemaining} per character that can mine
    if (runIsLive) {
      runOut.perChar.forEach(function (s) {
        if (s.state !== 'invalid') mpRuns.push({ hoursRemaining: s.remainingMs / MS.HOUR, stonesRemaining: Math.max(0, s.effectiveCapacity - s.estStones) });
      });
    } else {
      planStatus.forEach(function (s) {
        if (s.state !== 'invalid') mpRuns.push({ hoursRemaining: s.durationMs / MS.HOUR, stonesRemaining: s.effectiveCapacity });
      });
    }
    var mpCount = mpRuns.length;
    var needTime = est.mpPerHour !== null && mpCount > 0 ? 0 : null;
    var needStones = est.mpPerStone !== null && mpCount > 0 ? 0 : null;
    mpRuns.forEach(function (r) {
      var n = mpForRun(est, r);
      needTime = needTime === null || n.forTime === null ? null : needTime + n.forTime;
      needStones = needStones === null || n.forStones === null ? null : needStones + n.forStones;
    });
    needTime = fin(needTime);
    needStones = fin(needStones);
    var ovr = isObj(account.stone) ? account.stone.mpPer12hOverride : null;
    var mp = {
      source: est.source,
      manualSource: est.manualPerHour === null ? null : (isNum(ovr) && ovr >= 0 ? 'account' : 'setting'),
      manualPerHour: est.manualPerHour,
      manualPer12h: mpPer12hFromHour(est.manualPerHour),
      mpPerHour: est.mpPerHour,
      mpPer12h: mpPer12hFromHour(est.mpPerHour),
      mpPerStone: est.mpPerStone,
      stonesPerKMp: est.stonesPerKMp,
      sampleCount: est.sampleCount,
      effectiveSampleHours: est.effectiveSampleHours,
      manualWeight: est.manualWeight,
      characters: mpCount,
      accountPerHour: est.mpPerHour !== null && mpCount > 0 ? fin(est.mpPerHour * mpCount) : null,
      accountPer12h: est.mpPerHour !== null && mpCount > 0 ? fin(est.mpPerHour * 12 * mpCount) : null,
      needMode: runIsLive ? 'to-full' : 'round',
      needPerChar: { forTime: needTime !== null ? fin(needTime / mpCount) : null, forStones: needStones !== null ? fin(needStones / mpCount) : null },
      needTotal: { forTime: needTime, forStones: needStones },
    };

    // ---- overall urgency among ACTIVE timers ----
    var urgency = null;
    var actAt = null;
    var consider = function (t) {
      if (!t || t.paused || !t.urgency) return;
      if (urgency === null || URGENCY_SEVERITY[t.urgency] > URGENCY_SEVERITY[urgency]) urgency = t.urgency;
      if (actAt === null || t.actAt < actAt) actAt = t.actAt;
    };
    consider(runOut);
    gatherGroups.forEach(function (g) { consider(g.run); });

    var hasRuns = !!account.stoneRun || chars.some(function (c) { return c.gatherRun; });
    return {
      id: account.id,
      label: account.label,
      online: online,
      phase: online ? 'running' : (hasRuns ? 'paused' : 'idle'),
      session: { currentMs: os.currentSessionMs, staleOpen: os.staleOpen, ms24h: os.buckets[0], ms7d: os.totalMs },
      stone: {
        configured: !!(spot && capacities.some(function (x) { return x > 0; })),
        spotId: spot ? spot.id : null,
        spotName: spot ? spot.name : null,
        ratePerHour: rate,
        rateSource: sr ? sr.source : null,
        calibration: sr ? sr.calibration : null,
        capacities: capacities,
        plan: planOut,
        run: runOut,
      },
      gathers: gathers,
      gatherGroups: gatherGroups,
      characterCount: chars.length,
      mp: mp,
      urgency: urgency,
      actAt: actAt,
    };
  }

  /** The gather groups of a view; views built by hand (without gatherGroups) are grouped on the fly. */
  function groupsOfView(v) {
    return Array.isArray(v.gatherGroups) ? v.gatherGroups.filter(isObj) : groupGathers(v.gathers, v.characterCount);
  }

  function attentionItems(views) {
    var out = [];
    var list = Array.isArray(views) ? views : [];
    list.forEach(function (v) {
      if (!v) return;
      var sr = v.stone && v.stone.run;
      if (sr && !sr.paused && sr.urgency && sr.status) {
        out.push({
          key: v.id + ':stone', accountId: v.id, label: v.label, kind: 'stone', charIndex: null, count: 1,
          title: sr.spotName != null ? sr.spotName : v.stone.spotName,
          urgency: sr.urgency, actAt: sr.actAt, remainingMs: sr.actRemainingMs,
          fullAt: sr.status.fullAt, progress: sr.status.progress,
        });
      }
      // ONE item per gather GROUP (characters gathering the same thing at the same time are one timer)
      groupsOfView(v).forEach(function (g) {
        var gr = g && g.run;
        if (gr && !gr.paused && gr.urgency && gr.status) {
          out.push({
            key: g.key, groupKey: g.key, accountId: v.id, label: v.label, kind: 'gather', charIndex: g.charIndex,
            charName: g.count === 1 ? (g.charName || '') : '', charNames: g.charNames, count: g.count,
            members: g.members, memberIds: g.memberIds,
            title: g.itemName, urgency: gr.urgency, actAt: gr.actAt, remainingMs: gr.actRemainingMs,
            fullAt: gr.status.fullAt, progress: gr.status.progress,
          });
        }
      });
    });
    return urgencySort(out);
  }

  /**
   * Account-level totals. Timer counts are per TIMER: one stone timer per account and one per gather GROUP
   * (five characters gathering the same thing are one). byUrgency counts only active (not paused) timers.
   */
  function summarize(views, now) { // eslint-disable-line no-unused-vars
    var list = Array.isArray(views) ? views : [];
    var online = 0, ms24h = 0, ms7d = 0, gold = 0;
    var stoneTimers = 0, gatherTimers = 0, pausedTimers = 0;
    var byUrgency = { overdue: 0, now: 0, soon: 0, calm: 0 };
    var count = function (t) {
      if (!t || !t.status) return false;
      if (t.paused) pausedTimers++;
      else if (typeof t.urgency === 'string' && hasOwn(byUrgency, t.urgency)) byUrgency[t.urgency]++;
      return true;
    };
    list.forEach(function (v) {
      if (!v) return;
      if (v.online) online++;
      if (v.session) { ms24h += num(v.session.ms24h, 0); ms7d += num(v.session.ms7d, 0); }
      if (v.stone && v.stone.run && v.stone.run.goldAtFull) gold += num(v.stone.run.goldAtFull.total, 0);
      if (v.stone && count(v.stone.run)) stoneTimers++;
      groupsOfView(v).forEach(function (g) { if (g && count(g.run)) gatherTimers++; });
    });
    return {
      accountsOnline: online, accountsTotal: list.length, ms24h: ms24h, ms7d: ms7d, goldThisRound: gold,
      timers: stoneTimers + gatherTimers, stoneTimers: stoneTimers, gatherTimers: gatherTimers, pausedTimers: pausedTimers, byUrgency: byUrgency,
    };
  }

  // ===================================================================
  // 6.8 Notifications
  // ===================================================================
  function nextNotification(status, fired, now, opts) {
    var staleMs = opts && isNum(opts.staleMs) ? opts.staleMs : 300000;
    var f = { now: !!(fired && fired.now), overdue: !!(fired && fired.overdue) };
    var nothing = { fire: null, fired: f, missed: false };
    if (!status || (status.state !== 'running' && status.state !== 'full')) return nothing;
    var level = status.urgency === 'overdue' ? 'overdue' : (status.urgency === 'now' ? 'now' : null);
    if (!level || f[level] || (level === 'now' && f.overdue)) return nothing;
    var threshold = level === 'overdue' ? status.overdueAt : status.nowAt;
    var nf = level === 'overdue' ? { now: true, overdue: true } : { now: true, overdue: f.overdue };
    if (isNum(threshold) && isNum(now) && now - threshold > staleMs) return { fire: null, fired: nf, missed: true };
    return { fire: level, fired: nf, missed: false };
  }

  // ===================================================================
  // 6.9 Formatting and clock
  // ===================================================================
  function formatDuration(ms, o) {
    if (!isNum(ms)) return '—';
    var sign = ms < 0 ? '-' : '';
    var abs = Math.abs(ms);
    if (abs >= 1000 * MS.HOUR) return sign + '999+小時';
    var total = Math.floor(abs / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var style = o && o.style;
    var r;
    if (style === 'hms') r = h + ':' + pad2(m) + ':' + pad2(s);
    else if (style === 'compact') r = h > 0 ? h + 'h' + m + 'm' : (total < 60 ? '<1m' : m + 'm');
    else r = h > 0 ? h + '小時' + m + '分' : (total < 60 ? '不到1分' : m + '分');
    return sign + r;
  }

  function formatCountdown(ms) {
    if (!isNum(ms)) return '—';
    var sign = ms < 0 ? '+' : '';
    var abs = Math.abs(ms);
    if (abs >= 1000 * MS.HOUR) return sign + '999+時';
    var total = Math.floor(abs / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h >= 1) return sign + h + '時' + pad2(m) + '分';
    return sign + pad2(m) + ':' + pad2(s);
  }

  var zoneFormatters = new Map();
  function zoneFormatter(tz) {
    var key = typeof tz === 'string' ? tz : '';
    if (zoneFormatters.has(key)) return zoneFormatters.get(key);
    var base = { hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' };
    var f;
    try {
      f = new Intl.DateTimeFormat('en-US', key ? Object.assign({ timeZone: key }, base) : base);
    } catch (e) {
      f = new Intl.DateTimeFormat('en-US', base);
    }
    zoneFormatters.set(key, f);
    return f;
  }

  function zoneParts(ms, tz) {
    var parts = zoneFormatter(tz).formatToParts(new Date(ms));
    var o = {};
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type !== 'literal') o[parts[i].type] = parseInt(parts[i].value, 10);
    }
    if (o.hour === 24) o.hour = 0;
    return o;
  }

  var WEEKDAYS = '日一二三四五六';

  function formatEta(targetMs, nowMs, opts) {
    if (!isNum(targetMs) || !isNum(nowMs)) return '—';
    try {
      var tz = opts && opts.tz;
      var a = zoneParts(targetMs, tz);
      var b = zoneParts(nowMs, tz);
      var hm = pad2(a.hour) + ':' + pad2(a.minute);
      var dayA = Date.UTC(a.year, a.month - 1, a.day);
      var dayB = Date.UTC(b.year, b.month - 1, b.day);
      var diff = Math.round((dayA - dayB) / MS.DAY);
      if (diff === 0) return '今天 ' + hm;
      if (diff === 1) return '明天 ' + hm;
      if (diff === -1) return '昨天 ' + hm;
      if (diff >= 2 && diff <= 6) return '週' + WEEKDAYS.charAt(new Date(dayA).getUTCDay()) + ' ' + hm;
      return a.month + '/' + a.day + ' ' + hm;
    } catch (e) {
      return '—';
    }
  }

  function detectClockJump(lastSeenAt, now, tolMs) {
    var tol = isNum(tolMs) ? tolMs : 120000;
    return isNum(lastSeenAt) && isNum(now) && lastSeenAt > now + tol ? 'back' : null;
  }

  // ===================================================================
  // 6.10 Text, ids, schema
  // ===================================================================
  var STRIP_RE = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

  function sanitizeText(s, maxCodePoints) {
    if (typeof s !== 'string') return '';
    var t = s.normalize('NFC').replace(STRIP_RE, '').trim();
    var max = isNum(maxCodePoints) ? Math.max(0, Math.floor(maxCodePoints)) : Infinity;
    var cps = Array.from(t);
    return cps.length > max ? cps.slice(0, max).join('') : t;
  }

  var HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) { return HTML_ESC[c]; });
  }

  var ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

  function newId(prefix, existingIds, rand) {
    var p = (typeof prefix === 'string' ? prefix.toLowerCase().replace(/[^a-z]/g, '').charAt(0) : '') || 'x';
    var r = typeof rand === 'function' ? rand : Math.random;
    var taken = function (id) {
      if (!existingIds) return false;
      if (typeof existingIds.has === 'function') return existingIds.has(id);
      return Array.isArray(existingIds) && existingIds.indexOf(id) >= 0;
    };
    for (var attempt = 0; attempt < 200; attempt++) {
      var body = '';
      for (var i = 0; i < 6; i++) {
        body += ID_CHARS.charAt(Math.min(35, Math.max(0, Math.floor(num(r(), 0) * 36))));
      }
      var id = p + '_' + body;
      if (!taken(id)) return id;
    }
    // deterministic fallback (a degenerate rand): walk a base-36 counter
    for (var n = 0; n < 2176782336; n++) {
      var s = n.toString(36);
      var cand = p + '_' + '000000'.slice(s.length) + s;
      if (!taken(cand)) return cand;
    }
    return p + '_000000';
  }

  function defaultSettings() {
    return {
      stonesPerSlot: 3,
      stoneUnitPrice: 532,
      stoneFeePct: 0,
      dailyCap: null,
      gatherBufferMin: 10,
      stoneWarnMin: 60,
      stoneNowMin: 15,
      gatherSlots: 5,
      gatherSpeed: 1,
      workHourBurn: 1,
      pauseRunsOnOffline: true,
      notifications: false,
      sound: false,
      keepAwake: false,
      gatherMinuteOverrides: {},
      mpGoldValue: null,
      mpPer12h: MP_DEFAULTS.per12h,
    };
  }

  var PRESET_SPOTS = [
    { id: 'kude', name: '庫德' },
    { id: 'longshu', name: '龍樹' },
  ];

  function presetSpot(p) {
    return { id: p.id, name: p.name, preset: true, defaultRate: 10, manualRate: null, note: '' };
  }

  function defaultState(now) {
    return {
      schema: SCHEMA,
      rev: 0,
      savedAt: 0,
      settings: defaultSettings(),
      spots: PRESET_SPOTS.map(presetSpot),
      accounts: [],
      observations: [],
      usage: { recent: [], freq: {}, lastSpot: {} },
      meta: { lastSeenAt: isNum(now) ? now : 0 },
    };
  }

  // ---------- sanitize ----------
  var RE_ID = /^[a-z]_[a-z0-9]{3,12}$/;
  var RE_SPOT_ID = /^[a-z][a-z0-9_]{1,15}$/;
  var RE_ITEM_KEY = /^[a-z]+\/\S{1,40}$/;
  var RE_SPOT_KEY = /^(shed|p:\S{1,80})$/;
  var RE_OVERRIDE_KEY = /^[a-z]+\/\S{1,40}\|(shed|p:\S{1,80})$/;
  var RE_USAGE_KEY = /^[gs]:\S{1,60}$/;
  var CATEGORIES = ['hunt', 'mine', 'wood', 'herb'];
  var TS_MIN = Date.UTC(2000, 0, 1);

  /** finite number, numeric string, else NaN */
  function toNum(x) {
    if (typeof x === 'number') return isFinite(x) ? x : NaN;
    if (typeof x === 'string' && x.trim() !== '') {
      var n = Number(x);
      return isFinite(n) ? n : NaN;
    }
    return NaN;
  }
  function intIn(x, lo, hi, dflt) {
    var n = toNum(x);
    return isNaN(n) ? dflt : clamp(Math.floor(n), lo, hi);
  }
  function numIn(x, lo, hi, dflt) {
    var n = toNum(x);
    return isNaN(n) ? dflt : clamp(n, lo, hi);
  }
  function round2(x) { return Math.round(x * 100) / 100; }
  /** null when missing / non-numeric / below 1, else a clamped int */
  function nullableInt(x, lo, hi) {
    var n = toNum(x);
    return isNaN(n) || n < lo ? null : clamp(Math.floor(n), lo, hi);
  }
  /** rates: <= 0 or non-numeric -> null; otherwise clamped to lo..hi */
  function nullableRate(x, lo, hi) {
    var n = toNum(x);
    return isNaN(n) || n <= 0 ? null : clamp(n, lo, hi);
  }
  function boolOr(x, dflt) { return typeof x === 'boolean' ? x : dflt; }
  /** gold per 1 MP: missing / non-numeric / negative -> null; otherwise clamped to 0..10000 and kept to 4 decimals */
  function nullableGoldPerMp(x) {
    var n = toNum(x);
    return isNaN(n) || n < 0 ? null : Math.round(clamp(n, 0, 10000) * 10000) / 10000;
  }

  /**
   * MP per 12 hours (per character): null / '' = no number (the user cleared it); garbage, NaN or negative -> dflt;
   * otherwise clamped to 0..1,000,000 and kept to 4 decimals. 0 is a real value.
   */
  function mpPer12hIn(x, dflt) {
    if (x === null || (typeof x === 'string' && x.trim() === '')) return null;
    var n = toNum(x);
    if (isNaN(n) || n < 0) return dflt;
    return round4(clamp(n, 0, MP_DEFAULTS.maxPer12h));
  }

  function sanitizeState(obj, now) {
    var warnings = [];
    var dropped = 0;
    var warn = function (m) { warnings.push(m); };
    var drop = function (m) { dropped++; warnings.push(m); };
    var nowMs = isNum(now) ? now : 0;
    var hi = isNum(now) ? now + MS.DAY : Infinity;
    var src = isObj(obj) ? obj : {};
    if (!isObj(obj)) warn('root is not an object; defaults used');

    /** timestamp: finite number or numeric string, floored, within 2000-01-01 .. now + 1 day; else null */
    var ts = function (x) {
      var n = toNum(x);
      if (isNaN(n)) return null;
      var f = Math.floor(n);
      return f >= TS_MIN && f <= hi ? f : null;
    };

    // ---- settings ----
    var s = isObj(src.settings) ? src.settings : {};
    var settings = defaultSettings();
    settings.stonesPerSlot = intIn(s.stonesPerSlot, 1, 99, 3);
    settings.stoneUnitPrice = intIn(s.stoneUnitPrice, 0, 1e6, 532);
    settings.stoneFeePct = round2(numIn(s.stoneFeePct, 0, 100, 0));
    settings.dailyCap = nullableInt(s.dailyCap, 1, 9999);
    settings.gatherBufferMin = intIn(s.gatherBufferMin, 0, 240, 10);
    settings.stoneWarnMin = intIn(s.stoneWarnMin, 1, 720, 60);
    settings.stoneNowMin = intIn(s.stoneNowMin, 1, settings.stoneWarnMin, Math.min(15, settings.stoneWarnMin));
    settings.gatherSlots = s.gatherSlots === 6 || s.gatherSlots === '6' ? 6 : 5;
    settings.gatherSpeed = numIn(s.gatherSpeed, 0.5, 3, 1);
    settings.workHourBurn = numIn(s.workHourBurn, 0.1, 10, 1);
    settings.pauseRunsOnOffline = boolOr(s.pauseRunsOnOffline, true);
    settings.notifications = boolOr(s.notifications, false);
    settings.sound = boolOr(s.sound, false);
    settings.keepAwake = boolOr(s.keepAwake, false);
    settings.mpGoldValue = nullableGoldPerMp(s.mpGoldValue);
    settings.mpPer12h = mpPer12hIn(s.mpPer12h, MP_DEFAULTS.per12h);
    if (isObj(s.gatherMinuteOverrides)) {
      var ovKeys = Object.keys(s.gatherMinuteOverrides);
      var kept = 0;
      for (var oi = 0; oi < ovKeys.length; oi++) {
        var ok = ovKeys[oi];
        var ov = toNum(s.gatherMinuteOverrides[ok]);
        if (!isSafeKey(ok) || !RE_OVERRIDE_KEY.test(ok) || isNaN(ov) || ov <= 0) { drop('settings.gatherMinuteOverrides: bad entry dropped'); continue; }
        if (kept >= LIMITS.overrides) { drop('settings.gatherMinuteOverrides: more than ' + LIMITS.overrides + ' entries, extra dropped'); continue; }
        settings.gatherMinuteOverrides[ok] = clamp(Math.floor(ov), 1, 6000);
        kept++;
      }
    }

    // ---- spots (the two presets always exist) ----
    var spotIdMap = new Map();
    var allSpotIds = new Set();
    var presetOut = {};
    var customs = [];
    var spotsIn = Array.isArray(src.spots) ? src.spots : [];
    var maxCustoms = LIMITS.spots - PRESET_SPOTS.length;
    var isPresetId = function (id) { return PRESET_SPOTS.some(function (p) { return p.id === id; }); };
    spotsIn.forEach(function (sp, idx) {
      if (!isObj(sp)) { drop('spots[' + idx + '] is not an object'); return; }
      var id = typeof sp.id === 'string' ? sp.id : '';
      var preset = isPresetId(id) && !hasOwn(presetOut, id);
      if (!preset && customs.length >= maxCustoms) { drop('spots[' + idx + '] beyond the ' + LIMITS.spots + '-spot limit'); return; }
      var presetDef = preset ? PRESET_SPOTS.filter(function (p) { return p.id === id; })[0] : null;
      var finalId = id;
      if (!preset) {
        if (!(RE_SPOT_ID.test(id) && isSafeKey(id) && !isPresetId(id) && !allSpotIds.has(id))) {
          var reason = id === '' ? null : 'spots[' + idx + '] id is invalid or duplicated; regenerated';
          finalId = newId('s', allSpotIds);
          if (reason) warn(reason);
        }
      }
      allSpotIds.add(finalId);
      if (id !== '' && !spotIdMap.has(id)) spotIdMap.set(id, finalId);
      var out = {
        id: finalId,
        name: sanitizeText(sp.name, 24) || (presetDef ? presetDef.name : '自訂地點'),
        preset: !!presetDef,
        defaultRate: nullableRate(sp.defaultRate, 0.1, 9999) || 10,
        manualRate: nullableRate(sp.manualRate, 0.1, 9999),
        note: sanitizeText(sp.note, 120),
      };
      if (preset) presetOut[finalId] = out; else customs.push(out);
    });
    var spots = PRESET_SPOTS.map(function (p) {
      var o = presetOut[p.id] || presetSpot(p);
      allSpotIds.add(p.id);
      spotIdMap.set(p.id, p.id);
      return o;
    }).concat(customs);
    var spotRef = function (raw, where) {
      if (typeof raw !== 'string') return null;
      if (spotIdMap.has(raw)) return spotIdMap.get(raw);
      warn(where + ': unknown spot "' + sanitizeText(raw, 24) + '", cleared');
      return null;
    };

    // ---- gather plan / run ----
    var sanitizeGatherPlan = function (g, path) {
      if (g == null) return null;
      if (!isObj(g)) { drop(path + ' is not an object'); return null; }
      var category = typeof g.category === 'string' && CATEGORIES.indexOf(g.category) >= 0 ? g.category : null;
      var itemKey = typeof g.itemKey === 'string' && isSafeKey(g.itemKey) && RE_ITEM_KEY.test(g.itemKey) ? g.itemKey : null;
      var spotKey = typeof g.spotKey === 'string' && RE_SPOT_KEY.test(g.spotKey) ? g.spotKey : null;
      if (!category || !itemKey || !spotKey) { drop(path + ' has an invalid category, itemKey or spotKey and was removed'); return null; }
      var bm = toNum(g.baseMinutes);
      var wh = toNum(g.workHoursAtStart);
      var bufferMin = toNum(g.bufferMin);
      return {
        category: category,
        itemKey: itemKey,
        spotKey: spotKey,
        itemName: sanitizeText(g.itemName, 24) || sanitizeText(itemKey.split('/')[1], 24),
        placeLabel: sanitizeText(g.placeLabel, 60),
        baseMinutes: isNaN(bm) || bm <= 0 ? null : round2(clamp(bm, 1, 6000)),
        slots: g.slots === 6 || g.slots === '6' ? 6 : 5,
        speed: numIn(g.speed, 0.5, 3, 1),
        bufferMin: isNaN(bufferMin) ? null : clamp(Math.floor(bufferMin), 0, 240),
        workHoursAtStart: isNaN(wh) || wh <= 0 ? null : clamp(wh, 0.1, 99),
      };
    };
    var sanitizePaused = function (raw, startedAt, path) {
      if (raw == null) return null;
      var p = ts(raw);
      if (p === null) { warn(path + '.pausedAt is invalid, set to null'); return null; }
      return p < startedAt ? startedAt : p;
    };
    var sanitizeFired = function (f) {
      var o = isObj(f) ? f : {};
      return { now: boolOr(o.now, false), overdue: boolOr(o.overdue, false) };
    };
    var sanitizeGatherRun = function (g, path) {
      if (g == null) return null;
      if (!isObj(g)) { drop(path + ' is not an object'); return null; }
      var plan = sanitizeGatherPlan(g, path);
      if (!plan) return null;
      var startedAt = ts(g.startedAt);
      if (startedAt === null) { drop(path + '.startedAt is missing or out of range; run removed'); return null; }
      var last = null;
      if (g.lastDepositAt != null) {
        last = ts(g.lastDepositAt);
        if (last === null) warn(path + '.lastDepositAt is invalid, set to null');
      }
      return Object.assign(plan, {
        startedAt: startedAt,
        pausedAt: sanitizePaused(g.pausedAt, startedAt, path),
        lastDepositAt: last,
        fired: sanitizeFired(g.fired),
      });
    };

    // ---- accounts ----
    var seenIds = { a: new Set(), c: new Set(), o: new Set() };
    var takeId = function (raw, kind, where) {
      var ok = typeof raw === 'string' && isSafeKey(raw) && RE_ID.test(raw) && !seenIds[kind].has(raw);
      var id = ok ? raw : newId(kind, seenIds[kind]);
      if (!ok && raw != null && raw !== '') warn(where + ': id is invalid or duplicated; regenerated');
      seenIds[kind].add(id);
      return id;
    };
    var accounts = [];
    var accountIdMap = new Map();
    var labels = new Set();
    var accIn = Array.isArray(src.accounts) ? src.accounts : [];
    accIn.forEach(function (a, ai) {
      var where = 'accounts[' + ai + ']';
      if (!isObj(a)) { drop(where + ' is not an object'); return; }
      if (accounts.length >= LIMITS.accounts) { drop(where + ' beyond the ' + LIMITS.accounts + '-account limit'); return; }

      var id = takeId(a.id, 'a', where);
      if (typeof a.id === 'string' && !accountIdMap.has(a.id)) accountIdMap.set(a.id, id);

      var label = sanitizeText(a.label, 40);
      if (label === '') { label = '帳號' + (accounts.length + 1); warn(where + ': empty label replaced'); }
      if (labels.has(label)) {
        var base = label;
        var n = 2;
        do {
          var suffix = ' ' + n;
          label = Array.from(base).slice(0, 40 - suffix.length).join('') + suffix;
          n++;
        } while (labels.has(label));
        warn(where + ': duplicate label renamed to "' + label + '"');
      }
      labels.add(label);

      // sessions
      var sessions = [];
      (Array.isArray(a.onlineSessions) ? a.onlineSessions : []).forEach(function (ss, si) {
        var sw = where + '.onlineSessions[' + si + ']';
        if (!isObj(ss)) { drop(sw + ' is not an object'); return; }
        var start = ts(ss.start);
        if (start === null) { drop(sw + ': bad start, session dropped'); return; }
        var end = null;
        if (ss.end != null) {
          end = ts(ss.end);
          if (end === null || end < start) { drop(sw + ': bad end, session dropped'); return; }
        }
        sessions.push({ start: start, end: end });
      });
      sessions.sort(function (x, y) { return x.start - y.start; });
      var openSeen = false;
      for (var oi2 = sessions.length - 1; oi2 >= 0; oi2--) {
        if (sessions[oi2].end === null) {
          if (openSeen) { drop(where + ': more than one open session, older one dropped'); sessions.splice(oi2, 1); } else openSeen = true;
        }
      }
      if (sessions.length > LIMITS.sessions) {
        drop(where + ': more than ' + LIMITS.sessions + ' sessions, oldest dropped');
        sessions.splice(0, sessions.length - LIMITS.sessions);
      }

      // stone plan
      var st = isObj(a.stone) ? a.stone : {};
      var stone = {
        spotId: st.spotId == null ? null : spotRef(st.spotId, where + '.stone.spotId'),
        freeSlots: intIn(st.freeSlots, 0, 999, 0),
        rateOverride: nullableRate(st.rateOverride, 0.1, 9999),
        dailyCap: nullableInt(st.dailyCap, 1, 9999),
        droppedToday: intIn(st.droppedToday, 0, 9999, 0),
        mpPer12hOverride: mpPer12hIn(st.mpPer12hOverride, null),
      };

      // characters
      var chars = [];
      (Array.isArray(a.characters) ? a.characters : []).forEach(function (c, ci) {
        var cw = where + '.characters[' + ci + ']';
        if (!isObj(c)) { drop(cw + ' is not an object'); return; }
        if (chars.length >= LIMITS.characters) { drop(cw + ' beyond the ' + LIMITS.characters + '-character limit'); return; }
        chars.push({
          id: takeId(c.id, 'c', cw),
          name: sanitizeText(c.name, 24),
          level: intIn(c.level, 1, 999, 1),
          freeSlots: c.freeSlots == null ? null : intIn(c.freeSlots, 0, 999, null),
          gather: sanitizeGatherPlan(c.gather, cw + '.gather'),
          gatherRun: sanitizeGatherRun(c.gatherRun, cw + '.gatherRun'),
        });
      });

      // stone run
      var stoneRun = null;
      if (a.stoneRun != null) {
        var r = a.stoneRun;
        var rw = where + '.stoneRun';
        if (!isObj(r)) {
          drop(rw + ' is not an object');
        } else {
          var startedAt = ts(r.startedAt);
          if (startedAt === null) {
            drop(rw + '.startedAt is missing or out of range; run removed');
          } else {
            var fallbackSlots = function (i) { return chars[i] && chars[i].freeSlots != null ? chars[i].freeSlots : stone.freeSlots; };
            var fsStart;
            if (Array.isArray(r.freeSlotsAtStart)) {
              fsStart = r.freeSlotsAtStart.slice(0, LIMITS.characters).map(function (v, i) { return intIn(v, 0, 999, fallbackSlots(i)); });
            } else {
              fsStart = chars.map(function (c, i) { return fallbackSlots(i); });
            }
            stoneRun = {
              spotId: r.spotId == null ? null : spotRef(r.spotId, rw + '.spotId'),
              startedAt: startedAt,
              pausedAt: sanitizePaused(r.pausedAt, startedAt, rw),
              freeSlotsAtStart: fsStart,
              droppedAtStart: intIn(r.droppedAtStart, 0, 9999, 0),
              fired: sanitizeFired(r.fired),
            };
          }
        }
      }

      var createdAt = ts(a.createdAt);
      accounts.push({
        id: id,
        label: label,
        accountId: sanitizeText(a.accountId, 64),
        note: sanitizeText(a.note, 120),
        createdAt: createdAt === null ? nowMs : createdAt,
        onlineSessions: sessions,
        stone: stone,
        stoneRun: stoneRun,
        characters: chars,
      });
    });

    // ---- observations ----
    var observations = [];
    (Array.isArray(src.observations) ? src.observations : []).forEach(function (o, oi3) {
      var ow = 'observations[' + oi3 + ']';
      if (!isObj(o)) { drop(ow + ' is not an object'); return; }
      var spotId = typeof o.spotId === 'string' && spotIdMap.has(o.spotId) ? spotIdMap.get(o.spotId) : null;
      if (spotId === null) { drop(ow + ': unknown spot, observation dropped'); return; }
      var at = ts(o.at);
      if (at === null) { drop(ow + ': bad timestamp, observation dropped'); return; }
      var hours = toNum(o.hours);
      var stones = toNum(o.stones);
      if (isNaN(hours) || hours <= 0 || isNaN(stones) || stones < 0) { drop(ow + ': bad hours or stones, observation dropped'); return; }
      var consumption = null;
      if (o.consumption != null) {
        var cons = isObj(o.consumption) ? o.consumption : null;
        var amount = cons ? toNum(cons.amount) : NaN;
        if (isNaN(amount) || amount < 0) {
          warn(ow + ': bad consumption, cleared');
        } else {
          var gv = toNum(cons.goldValue);
          consumption = {
            amount: round2(clamp(amount, 0, 1e9)),
            unitLabel: sanitizeText(cons.unitLabel, 12) || '魔法',
            goldValue: isNaN(gv) || gv < 0 ? null : clamp(Math.floor(gv), 0, 1e9),
          };
        }
      }
      var rec = {
        id: takeId(o.id, 'o', ow),
        spotId: spotId,
        at: at,
        hours: clamp(hours, 0.01, 500),
        stones: round2(clamp(stones, 0, 20000)),
        accountId: typeof o.accountId === 'string' && accountIdMap.has(o.accountId) ? accountIdMap.get(o.accountId) : null,
        excluded: boolOr(o.excluded, false),
        consumption: consumption,
      };
      if (o.full === true) rec.full = true;   // bag was full when settled: the rate is only a lower bound
      observations.push(rec);
    });
    if (observations.length > LIMITS.observations) {
      var idx = observations.map(function (o, i) { return i; }).sort(function (x, y) {
        return (observations[y].at - observations[x].at) || (y - x);
      });
      var keep = new Set(idx.slice(0, LIMITS.observations));
      drop('observations: more than ' + LIMITS.observations + ' records, oldest dropped');
      observations = observations.filter(function (o, i) { return keep.has(i); });
    }

    // ---- usage ----
    var u = isObj(src.usage) ? src.usage : {};
    var recent = [];
    (Array.isArray(u.recent) ? u.recent : []).forEach(function (r, ri) {
      if (!isObj(r) || !isSafeKey(r.key) || !RE_USAGE_KEY.test(r.key)) { drop('usage.recent[' + ri + '] dropped'); return; }
      var at = ts(r.at);
      if (at === null) { drop('usage.recent[' + ri + '] has a bad timestamp and was dropped'); return; }
      recent.push({ key: r.key, at: at });
    });
    recent.sort(function (x, y) { return y.at - x.at; });
    var seenRecent = new Set();
    recent = recent.filter(function (r) { if (seenRecent.has(r.key)) return false; seenRecent.add(r.key); return true; });
    if (recent.length > LIMITS.usageRecent) recent = recent.slice(0, LIMITS.usageRecent);
    var freqEntries = [];
    if (isObj(u.freq)) {
      Object.keys(u.freq).forEach(function (k) {
        var n = toNum(u.freq[k]);
        if (!isSafeKey(k) || !RE_USAGE_KEY.test(k) || isNaN(n) || n < 1) { drop('usage.freq: bad entry dropped'); return; }
        freqEntries.push([k, Math.floor(n)]);
      });
    }
    if (freqEntries.length > LIMITS.usageKeys) {
      drop('usage.freq: more than ' + LIMITS.usageKeys + ' keys, lowest dropped');
      freqEntries.sort(function (x, y) { return (y[1] - x[1]) || (x[0] < y[0] ? -1 : 1); });
      freqEntries = freqEntries.slice(0, LIMITS.usageKeys);
    }
    var freq = {};
    freqEntries.forEach(function (e) { freq[e[0]] = e[1]; });
    var lastSpot = {};
    var lastCount = 0;
    if (isObj(u.lastSpot)) {
      Object.keys(u.lastSpot).forEach(function (k) {
        var v = u.lastSpot[k];
        if (!isSafeKey(k) || !RE_ITEM_KEY.test(k) || typeof v !== 'string' || !RE_SPOT_KEY.test(v)) { drop('usage.lastSpot: bad entry dropped'); return; }
        if (lastCount >= LIMITS.usageKeys) { drop('usage.lastSpot: too many entries, extra dropped'); return; }
        lastSpot[k] = v;
        lastCount++;
      });
    }

    // ---- meta ----
    var meta = isObj(src.meta) ? src.meta : {};
    var seen = ts(meta.lastSeenAt);
    var savedAt = ts(src.savedAt);

    return {
      state: {
        schema: SCHEMA,
        rev: intIn(src.rev, 0, 9007199254740991, 0),
        savedAt: savedAt === null ? 0 : savedAt,
        settings: settings,
        spots: spots,
        accounts: accounts,
        observations: observations,
        usage: { recent: recent, freq: freq, lastSpot: lastSpot },
        meta: { lastSeenAt: seen === null ? nowMs : seen },
      },
      warnings: warnings,
      dropped: dropped,
    };
  }

  // ---------- migrate / load / import / export ----------
  var MIGRATIONS = {}; // MIGRATIONS[n] = pure function turning a schema n object into schema n + 1

  function migrate(raw) {
    if (!isObj(raw)) return { ok: false, error: 'not-object' };
    var schema = raw.schema;
    if (!isNum(schema) || Math.floor(schema) !== schema || schema < 1) return { ok: false, error: 'schema-missing' };
    if (schema > SCHEMA) return { ok: false, error: 'schema-too-new' };
    var data = raw;
    var v = schema;
    var steps = 0;
    while (v < SCHEMA) {
      var fn = MIGRATIONS[v];
      if (typeof fn !== 'function') return { ok: false, error: 'schema-missing' };
      data = fn(data);
      v++;
      steps++;
    }
    return { ok: true, data: data, from: schema, to: v, steps: steps };
  }

  function loadState(raw, now) {
    if (raw === null || raw === undefined || raw === '') {
      return { state: defaultState(now), status: 'default', readOnly: false, warnings: [], dropped: 0 };
    }
    var obj = raw;
    if (typeof raw === 'string') {
      try { obj = JSON.parse(raw); } catch (e) { obj = undefined; }
    }
    if (!isObj(obj)) {
      return { state: defaultState(now), status: 'corrupt', readOnly: false, warnings: ['stored value is not valid JSON or not an object'], dropped: 0 };
    }
    var m = migrate(obj);
    if (!m.ok && m.error === 'schema-too-new') {
      // best-effort read-only view; the caller must never write this back
      var view = sanitizeState(obj, now);
      return { state: view.state, status: 'too-new', readOnly: true, warnings: ['schema-too-new'].concat(view.warnings), dropped: view.dropped };
    }
    var res = sanitizeState(m.ok ? m.data : obj, now);
    var warnings = m.ok ? res.warnings : ['schema is missing; treated as version 1'].concat(res.warnings);
    return { state: res.state, status: 'ok', readOnly: false, warnings: warnings, dropped: res.dropped };
  }

  function utf8Length(str) {
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  function validateImport(textOrObject, now) {
    var obj = textOrObject;
    if (typeof textOrObject === 'string') {
      if (utf8Length(textOrObject) > LIMITS.importBytes) return { ok: false, code: 'too-large' };
      try { obj = JSON.parse(textOrObject); } catch (e) { return { ok: false, code: 'parse' }; }
    }
    if (!isObj(obj)) return { ok: false, code: 'not-object' };
    var schema = obj.schema;
    if (!isNum(schema) || Math.floor(schema) !== schema || schema < 1) return { ok: false, code: 'schema-missing' };
    if (schema > SCHEMA) return { ok: false, code: 'schema-too-new' };
    var hasAccounts = Array.isArray(obj.accounts) && obj.accounts.length > 0;
    if (!hasAccounts && !isObj(obj.settings)) return { ok: false, code: 'empty' };
    var m = migrate(obj);
    if (!m.ok) return { ok: false, code: m.error };
    var res = sanitizeState(m.data, now);
    return { ok: true, state: res.state, warnings: res.warnings, dropped: res.dropped };
  }

  function exportState(state, now, opts) {
    var src = isObj(state) ? state : defaultState(now);
    var out = Object.assign({}, src, { savedAt: isNum(now) ? now : num(src.savedAt, 0) });
    if (opts && opts.omitAccountId && Array.isArray(src.accounts)) {
      out.accounts = src.accounts.map(function (a) { return isObj(a) ? Object.assign({}, a, { accountId: '' }) : a; });
    }
    return JSON.stringify(out, null, 2);
  }

  // ===================================================================
  // 6.10 Page-support helpers (pure; used by the page, tested here)
  // ===================================================================

  /**
   * Checks one calibration record BEFORE it is saved, so the preview and the stored value can never disagree
   * (the page used to clamp silently). input = {hours, stonesPerChar, at?, amountPerChar?, capacityPerChar?, currentRate?}.
   * Returns {errors:{hours?,stones?,at?,amount?}, impliedRate, full, overCapacity, fastRate, odd}:
   *  - errors hold codes: hours 'missing'|'too-short'|'too-long', stones 'missing'|'too-many',
   *    at 'future'|'too-old', amount 'too-big'; any error means "do not save".
   *  - full: stones reached the bag capacity, so the record is right-censored (a lower bound on the rate).
   *  - odd: more than the bag can hold, or an implied rate far above the current one; ask before saving.
   */
  function assessObservation(input, now) {
    var o = isObj(input) ? input : {};
    var errors = {};
    var hours = o.hours;
    var stones = o.stonesPerChar;
    if (!isNum(hours) || hours <= 0) errors.hours = 'missing';
    else if (hours < OBS_LIMITS.minHours) errors.hours = 'too-short';
    else if (hours > OBS_LIMITS.maxHours) errors.hours = 'too-long';
    if (!isNum(stones) || stones < 0) errors.stones = 'missing';
    else if (stones > OBS_LIMITS.maxStones) errors.stones = 'too-many';
    if (isNum(o.at)) {
      if (isNum(now) && o.at > now + OBS_LIMITS.futureSlackMs) errors.at = 'future';
      else if (o.at < OBS_LIMITS.minAt) errors.at = 'too-old';
    }
    if (isNum(o.amountPerChar) && o.amountPerChar > OBS_LIMITS.maxAmount) errors.amount = 'too-big';
    var usable = !errors.hours && !errors.stones;
    var implied = usable ? stones / hours : null;
    var cap = isNum(o.capacityPerChar) && o.capacityPerChar > 0 ? o.capacityPerChar : 0;
    var cur = isNum(o.currentRate) && o.currentRate > 0 ? o.currentRate : 0;
    var full = usable && cap > 0 && stones >= cap - 0.5;
    var over = usable && cap > 0 && stones > cap + 0.5;
    var fast = usable && cur > 0 && implied > OBS_LIMITS.oddRateFactor * cur;
    return { errors: errors, impliedRate: implied, full: full, overCapacity: over, fastRate: fast, odd: over || fast };
  }

  /**
   * Quota policy as a pure function: the OLDEST HALF of the calibration records and of the closed online
   * sessions is dropped; runs and open sessions are never touched. Returns a new state and what was dropped.
   * The caller must only adopt the trimmed copy after a write of it succeeded.
   */
  function trimForQuota(state) {
    if (!isObj(state)) return { state: state, droppedObservations: 0, droppedSessions: 0 };
    var obs = Array.isArray(state.observations) ? state.observations : [];
    var sorted = obs.map(function (x, i) { return { x: x, i: i }; }).sort(function (a, b) {
      return (num(a.x && a.x.at, 0) - num(b.x && b.x.at, 0)) || (a.i - b.i);
    }).map(function (p) { return p.x; });
    var dropObs = Math.floor(sorted.length / 2);
    var droppedSessions = 0;
    var accounts = (Array.isArray(state.accounts) ? state.accounts : []).map(function (a) {
      if (!isObj(a) || !Array.isArray(a.onlineSessions)) return a;
      var closed = a.onlineSessions.filter(function (s) { return s && s.end != null; });
      var open = a.onlineSessions.filter(function (s) { return !s || s.end == null; });
      var cut = Math.floor(closed.length / 2);
      droppedSessions += cut;
      return Object.assign({}, a, { onlineSessions: closed.slice(cut).concat(open) });
    });
    return {
      state: Object.assign({}, state, { observations: sorted.slice(dropObs), accounts: accounts }),
      droppedObservations: dropObs,
      droppedSessions: droppedSessions,
    };
  }

  /** The `rev` of a stored state string, 0 when the field is missing, null when the text is not a state. */
  function storedRev(raw) {
    if (typeof raw !== 'string' || raw === '') return null;
    var obj;
    try { obj = JSON.parse(raw); } catch (e) { return null; }
    if (!isObj(obj)) return null;
    return isNum(obj.rev) && obj.rev >= 0 ? Math.floor(obj.rev) : 0;
  }

  // ---- undo helpers: each puts back ONE thing and leaves the rest of the account as it is now ----
  // A run's pause state must match the account (online -> running, offline -> paused unless the setting is off).
  function settleRun(account, run, now, settings) {
    if (!run || !isNum(now)) return run;
    if (isOnline(account)) return run.pausedAt != null ? resumeRun(run, now) : run;
    if (settings && settings.pauseRunsOnOffline === false) return run;
    return run.pausedAt == null ? pauseRun(run, now) : run;
  }

  function restoreStoneRun(account, prevRun, now, settings) {
    if (!account) return account;
    return Object.assign({}, account, { stoneRun: prevRun ? settleRun(account, prevRun, now, settings) : null });
  }

  function restoreGatherRun(account, charId, prevRun, now, settings) {
    if (!account || !Array.isArray(account.characters)) return account;
    var hit = false;
    var chars = account.characters.map(function (c) {
      if (c && c.id === charId) { hit = true; return Object.assign({}, c, { gatherRun: prevRun ? settleRun(account, prevRun, now, settings) : null }); }
      return c;
    });
    return hit ? Object.assign({}, account, { characters: chars }) : account;
  }

  /**
   * Undo of goOffline(account, offlineAt): reopens the session that was closed at that moment and un-pauses the
   * runs that were paused by it WITHOUT shifting their start (as if the offline press never happened). Runs
   * paused at another moment (restarted while offline) are resumed normally. Returns the same reference when
   * there is nothing to undo (already online, or that session is no longer the one that was closed).
   */
  function undoGoOffline(account, offlineAt, now) {
    if (!account || !isNum(offlineAt) || isOnline(account) || !Array.isArray(account.onlineSessions)) return account;
    // only the MOST RECENT session can be the one that press closed; an older closed session means the account
    // went online and offline again since, and that history must not be rewritten
    var idx = account.onlineSessions.length - 1;
    var last = account.onlineSessions[idx];
    if (!last || last.end == null || last.end !== Math.max(offlineAt, last.start)) return account;
    var sessions = account.onlineSessions.map(function (s, k) { return k === idx ? { start: s.start, end: null } : s; });
    var reopened = Object.assign({}, account, { onlineSessions: sessions });
    return mapRuns(reopened, function (r) {
      if (!r || r.pausedAt == null) return r;
      return r.pausedAt === offlineAt ? Object.assign({}, r, { pausedAt: null }) : resumeRun(r, now);
    });
  }

  /** Undo of clearRuns: puts back only the runs that are still missing (a run started since is kept). */
  function restoreClearedRuns(account, prevAccount, now, settings) {
    if (!account || !prevAccount) return account;
    var changed = false;
    var out = Object.assign({}, account);
    if (!account.stoneRun && prevAccount.stoneRun) { out.stoneRun = settleRun(account, prevAccount.stoneRun, now, settings); changed = true; }
    var prevChars = Array.isArray(prevAccount.characters) ? prevAccount.characters : [];
    if (Array.isArray(account.characters)) {
      out.characters = account.characters.map(function (c) {
        if (!c || c.gatherRun) return c;
        for (var i = 0; i < prevChars.length; i++) {
          if (prevChars[i] && prevChars[i].id === c.id && prevChars[i].gatherRun) {
            changed = true;
            return Object.assign({}, c, { gatherRun: settleRun(account, prevChars[i].gatherRun, now, settings) });
          }
        }
        return c;
      });
    }
    return changed ? out : account;
  }

  function gatherPlanSig(p) {
    return p ? [p.itemKey, p.spotKey, p.baseMinutes, p.slots, p.speed, p.bufferMin, p.workHoursAtStart].join('|') : '';
  }

  /**
   * Which edits of the plan are not in the running timers yet (a run keeps the numbers it started with
   * until it is restarted). {stone, gather:[charId], any}.
   */
  function pendingChanges(account) {
    var out = { stone: false, gather: [], any: false };
    if (!isObj(account)) return out;
    var plan = isObj(account.stone) ? account.stone : {};
    var chars = Array.isArray(account.characters) ? account.characters : [];
    var run = account.stoneRun;
    if (run) {
      var slots = Array.isArray(run.freeSlotsAtStart) ? run.freeSlotsAtStart : [];
      var same = run.spotId === (plan.spotId != null ? plan.spotId : null) && slots.length === chars.length &&
        num(run.droppedAtStart, 0) === num(plan.droppedToday, 0);
      for (var i = 0; same && i < chars.length; i++) if (slots[i] !== slotsFor(account, chars[i])) same = false;
      out.stone = !same;
    }
    chars.forEach(function (c) {
      if (c && c.gatherRun && gatherPlanSig(c.gather) !== gatherPlanSig(c.gatherRun)) out.gather.push(c.id);
    });
    out.any = out.stone || out.gather.length > 0;
    return out;
  }

  // ===================================================================
  // 6.11 Gather groups: the characters of one account usually gather the same thing at the same time, so the
  // page shows ONE timer box for them. Stored data stays per character (schema 1, old saves load unchanged);
  // a group is derived: same plan (item, spot, minutes, slots, speed, buffer, work hours) AND same startedAt AND
  // same pausedAt. A character that differs in any of these is simply in a group of its own.
  // ===================================================================
  function fnv1a(str, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function hex8(n) { return ('00000000' + (n >>> 0).toString(16)).slice(-8); }

  /** The part of a gather run / plan that decides whether two characters share a timer (a JSON array, so unambiguous). */
  function gatherIdentity(src) {
    if (!isObj(src)) return '';
    var isRun = isNum(src.startedAt);
    try {
      return JSON.stringify([
        src.itemKey, src.spotKey, src.baseMinutes, src.slots === 6 ? 6 : 5, num(src.speed, 1), src.bufferMin, src.workHoursAtStart,
        isRun ? src.startedAt : null, isRun && src.pausedAt != null ? src.pausedAt : null,
      ]);
    } catch (e) {
      return '';
    }
  }

  /**
   * Stable key of a group: accountId + ':g:' + startedAt (or 'plan') + ':' + 64-bit hash of the full identity.
   * Only [A-Za-z0-9_:] and the account id: safe in attributes and selectors. The same run gives the same key forever.
   */
  function gatherGroupKey(accountId, src) {
    var id = gatherIdentity(src);
    var when = isObj(src) && isNum(src.startedAt) ? String(Math.floor(src.startedAt)) : 'plan';
    return (accountId == null ? '' : String(accountId)) + ':g:' + when + ':' + hex8(fnv1a(id, 0x811c9dc5)) + hex8(fnv1a(id, 0x9747b28c));
  }

  // buckets items by their groupKey in order of first appearance; an item without a key is never merged
  function bucketGathers(items) {
    var order = [];
    var map = new Map();
    items.forEach(function (it, i) {
      var k = typeof it.groupKey === 'string' && it.groupKey !== '' ? it.groupKey : 'solo:' + i;
      var b = map.get(k);
      if (!b) { b = { key: k, items: [] }; map.set(k, b); order.push(b); }
      b.items.push(it);
    });
    return order;
  }

  /**
   * Groups the items of accountView(...).gathers (each carries groupKey). The representative is the first member;
   * members of a group have identical plan, start and pause, so its timer and urgency are the group's.
   * characterCount (optional) is only used to set `all` (the group covers every character of an account that has several).
   * Returns [{key, count, all, members:[charIndex], memberIds:[charId], charNames, charIndex, charId, charName, plan,
   *   itemName, placeLabel, category, planStatus, hasRun, run, status, urgency, paused}] in order of first member.
   */
  function groupGathers(gathers, characterCount) {
    var items = (Array.isArray(gathers) ? gathers : []).filter(isObj);
    var total = isNum(characterCount) ? characterCount : 0;
    return bucketGathers(items).map(function (b) {
      var rep = b.items[0];
      var run = isObj(rep.run) ? rep.run : null;
      return {
        key: b.key,
        count: b.items.length,
        all: total > 1 && b.items.length === total,
        members: b.items.map(function (x) { return x.charIndex; }),
        memberIds: b.items.map(function (x) { return x.charId; }),
        charNames: b.items.map(function (x) { return typeof x.charName === 'string' ? x.charName : ''; }),
        charIndex: rep.charIndex,
        charId: rep.charId,
        charName: rep.charName,
        plan: rep.plan || null,
        itemName: rep.itemName,
        placeLabel: rep.placeLabel,
        category: rep.category,
        planStatus: rep.planStatus || null,
        hasRun: !!run,
        run: run,
        status: run ? run.status : null,
        urgency: run ? run.urgency : null,
        paused: run ? !!run.paused : false,
      };
    });
  }

  /** The groups straight from an account (no clock needed): [{key, count, members, memberIds, charNames, hasRun}]. */
  function gatherGroupsOf(account) {
    var chars = isObj(account) && Array.isArray(account.characters) ? account.characters : [];
    var items = [];
    chars.forEach(function (c, i) {
      if (!isObj(c)) return;
      var src = c.gatherRun || c.gather;
      if (!src) return;
      items.push({ charIndex: i, charId: c.id, charName: c.name, groupKey: gatherGroupKey(account.id, src), hasRun: !!c.gatherRun });
    });
    return bucketGathers(items).map(function (b) {
      return {
        key: b.key,
        count: b.items.length,
        members: b.items.map(function (x) { return x.charIndex; }),
        memberIds: b.items.map(function (x) { return x.charId; }),
        charNames: b.items.map(function (x) { return typeof x.charName === 'string' ? x.charName : ''; }),
        hasRun: b.items.every(function (x) { return x.hasRun; }),
      };
    });
  }

  // indexes of the characters that belong to a group (by run if they have one, else by plan)
  function groupMemberIndexes(account, groupKey) {
    var out = [];
    if (!isObj(account) || !Array.isArray(account.characters) || typeof groupKey !== 'string') return out;
    account.characters.forEach(function (c, i) {
      if (!isObj(c)) return;
      var src = c.gatherRun || c.gather;
      if (src && gatherGroupKey(account.id, src) === groupKey) out.push(i);
    });
    return out;
  }

  /** The fired flags of a group: a level counts as fired when ANY member run has it (older saves flagged one by one). */
  function groupFiredFlags(account, groupKey) {
    var f = { now: false, overdue: false };
    groupMemberIndexes(account, groupKey).forEach(function (i) {
      var run = account.characters[i].gatherRun;
      if (!isObj(run) || !isObj(run.fired)) return;
      if (run.fired.now === true) f.now = true;
      if (run.fired.overdue === true) f.overdue = true;
    });
    return f;
  }

  /**
   * nextNotification for a whole group: the group's status, the merged flags, ONE result for all members.
   * `group` is an item of accountView(...).gatherGroups. Paused groups and groups without a valid run never fire.
   * Returns {fire, fired, missed} like nextNotification; apply `fired` with markGroupFired.
   */
  function nextGroupNotification(account, group, now, opts) {
    var flags = group && typeof group.key === 'string' ? groupFiredFlags(account, group.key) : { now: false, overdue: false };
    var run = group && group.run;
    if (!run || run.paused || !run.status) return { fire: null, fired: flags, missed: false };
    return nextNotification(run.status, flags, now, opts);
  }

  /**
   * Sets the fired flags on EVERY member run of a group. level = 'now' | 'overdue' (overdue implies now) or a
   * {now, overdue} object such as nextNotification's `fired`. Flags are only ever raised, never lowered. Paused
   * members are marked too. Characters outside the group are not touched. Same reference when nothing changes.
   */
  function markGroupFired(account, groupKey, level) {
    var patch = null;
    if (level === 'now') patch = { now: true, overdue: false };
    else if (level === 'overdue') patch = { now: true, overdue: true };
    else if (isObj(level)) patch = { now: level.now === true, overdue: level.overdue === true };
    if (!patch || !isObj(account) || !Array.isArray(account.characters)) return account;
    var hit = {};
    groupMemberIndexes(account, groupKey).forEach(function (i) { hit[i] = true; });
    var changed = false;
    var chars = account.characters.map(function (c, i) {
      if (!hit[i] || !isObj(c.gatherRun)) return c;
      var had = isObj(c.gatherRun.fired);
      var f = had ? c.gatherRun.fired : {};
      var nowF = f.now === true || patch.now;
      var overF = f.overdue === true || patch.overdue;
      if (nowF === (f.now === true) && overF === (f.overdue === true) && (had || (!nowF && !overF))) return c;
      changed = true;
      return Object.assign({}, c, { gatherRun: Object.assign({}, c.gatherRun, { fired: { now: nowF, overdue: overF } }) });
    });
    return changed ? Object.assign({}, account, { characters: chars }) : account;
  }

  var PLAN_FIELDS = ['category', 'itemKey', 'spotKey', 'itemName', 'placeLabel', 'baseMinutes', 'slots', 'speed', 'bufferMin', 'workHoursAtStart'];

  /**
   * One pick for the whole account: every character's gather PLAN is set to a copy of `plan` (only the plan fields are
   * copied, never run state). Running timers are not touched: like a per-character edit, the new plan is pending
   * until the group is restarted (restartGatherGroup) or the account is started (startAccount). A null / non-object
   * plan clears the plans.
   */
  function setAccountGather(account, plan) {
    if (!isObj(account) || !Array.isArray(account.characters)) return account;
    if (!isObj(plan)) return clearAccountGather(account);
    return Object.assign({}, account, {
      characters: account.characters.map(function (c) {
        if (!isObj(c)) return c;
        var copy = {};
        PLAN_FIELDS.forEach(function (k) { copy[k] = plan[k] === undefined ? null : plan[k]; });
        return Object.assign({}, c, { gather: copy });
      }),
    });
  }

  /** Clears every character's gather plan; with opts.runs === true the running gather timers too (the stone timer never). */
  function clearAccountGather(account, opts) {
    if (!isObj(account) || !Array.isArray(account.characters)) return account;
    var runs = !!(opts && opts.runs === true);
    return Object.assign({}, account, {
      characters: account.characters.map(function (c) {
        if (!isObj(c)) return c;
        return Object.assign({}, c, runs ? { gather: null, gatherRun: null } : { gather: null });
      }),
    });
  }

  /**
   * 已存入銀行 - 重新計時 for a whole group: every member run restarts at `at` (restartCharGather: picks up the
   * character's current plan, resets the fired flags, keeps a paused run paused; a member whose plan was cleared
   * loses its run, which is how a cleared plan gets applied). Characters outside the group keep
   * their runs. Same reference when the key is unknown, the group has no run, or `at` is not a number.
   */
  function restartGatherGroup(account, groupKey, at) {
    if (!isObj(account) || !Array.isArray(account.characters) || !isNum(at)) return account;
    var hit = {};
    groupMemberIndexes(account, groupKey).forEach(function (i) { if (account.characters[i].gatherRun) hit[i] = true; });
    if (!Object.keys(hit).length) return account;
    return Object.assign({}, account, {
      characters: account.characters.map(function (c, i) { return hit[i] ? restartCharGather(c, at) : c; }),
    });
  }

  /** Undo of a group restart: prevRuns = [{charId, run}] (run null removes the timer); each run is settled to the account state. */
  function restoreGatherRuns(account, prevRuns, now, settings) {
    if (!isObj(account) || !Array.isArray(prevRuns) || !prevRuns.length) return account;
    var out = account;
    prevRuns.forEach(function (p) {
      if (isObj(p)) out = restoreGatherRun(out, p.charId, p.run, now, settings);
    });
    return out;
  }

  /** Keys of the gather groups whose plan was edited but not yet applied to the running timer (see pendingChanges). */
  function pendingGatherGroups(account) {
    var out = [];
    if (!isObj(account) || !Array.isArray(account.characters)) return out;
    account.characters.forEach(function (c) {
      if (!isObj(c) || !c.gatherRun || gatherPlanSig(c.gather) === gatherPlanSig(c.gatherRun)) return;
      var k = gatherGroupKey(account.id, c.gatherRun);
      if (out.indexOf(k) < 0) out.push(k);
    });
    return out;
  }

  // ===================================================================
  return {
    SCHEMA: SCHEMA, STORAGE_KEY: STORAGE_KEY, BACKUP_KEY: BACKUP_KEY, CORRUPT_KEY: CORRUPT_KEY,
    MS: MS, LIMITS: LIMITS, num: num, clamp: clamp,
    stoneCapacity: stoneCapacity, hoursToFull: hoursToFull, resolveRate: resolveRate,
    stoneRunStatus: stoneRunStatus, estimatedStonesAt: estimatedStonesAt,
    goldValue: goldValue, accountGold: accountGold, netGoldPerHour: netGoldPerHour, consumptionPerHour: consumptionPerHour, mpStats: mpStats, mpForRun: mpForRun, mpGoldPerHour: mpGoldPerHour,
    gatherFillMs: gatherFillMs, gatherRunStatus: gatherRunStatus, restartGather: restartGather,
    restartCharGather: restartCharGather, makeGatherRun: makeGatherRun, bestSpot: bestSpot,
    spotMinutes: spotMinutes, lookupGather: lookupGather,
    calibrate: calibrate, spotRate: spotRate,
    effectiveNow: effectiveNow, pauseRun: pauseRun, resumeRun: resumeRun, isOnline: isOnline,
    goOnline: goOnline, goOffline: goOffline, makeStoneRun: makeStoneRun, startAccount: startAccount,
    restartStone: restartStone, clearRuns: clearRuns,
    onlineStats: onlineStats, recordPick: recordPick, quickPicks: quickPicks, urgencySort: urgencySort,
    accountView: accountView, attentionItems: attentionItems, summarize: summarize,
    nextNotification: nextNotification,
    formatDuration: formatDuration, formatCountdown: formatCountdown, formatEta: formatEta, detectClockJump: detectClockJump,
    sanitizeText: sanitizeText, escapeHtml: escapeHtml, newId: newId,
    defaultSettings: defaultSettings, defaultState: defaultState, sanitizeState: sanitizeState,
    migrate: migrate, loadState: loadState, validateImport: validateImport, exportState: exportState,
    MAX_FILL_HOURS: MAX_FILL_HOURS, OBS_LIMITS: OBS_LIMITS,
    assessObservation: assessObservation, trimForQuota: trimForQuota, storedRev: storedRev,
    restoreStoneRun: restoreStoneRun, restoreGatherRun: restoreGatherRun, undoGoOffline: undoGoOffline,
    restoreClearedRuns: restoreClearedRuns, pendingChanges: pendingChanges,
    // v2: manual MP rate and account-level gather groups
    MP_DEFAULTS: MP_DEFAULTS,
    mpPerHourFrom12h: mpPerHourFrom12h, mpPer12hFromHour: mpPer12hFromHour, resolveMpManual: resolveMpManual,
    mpEstimate: mpEstimate, mpForAccount: mpForAccount, mpPerCharFromEntry: mpPerCharFromEntry, mpEntryFromPerChar: mpEntryFromPerChar,
    mpSourceLabel: mpSourceLabel,
    mpHeadline: mpHeadline, mpNeedBrief: mpNeedBrief, formatWan: formatWan, sanitizeUi: sanitizeUi, rowsOpenState: rowsOpenState,
    gatherGroupKey: gatherGroupKey, gatherGroupsOf: gatherGroupsOf, groupGathers: groupGathers, groupFiredFlags: groupFiredFlags,
    nextGroupNotification: nextGroupNotification, markGroupFired: markGroupFired,
    setAccountGather: setAccountGather, clearAccountGather: clearAccountGather, restartGatherGroup: restartGatherGroup,
    restoreGatherRuns: restoreGatherRuns, pendingGatherGroups: pendingGatherGroups,
  };
});
