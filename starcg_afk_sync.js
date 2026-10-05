/**
 * 掛機追蹤 cloud sync: the wire protocol, the sync-code format and the conflict policy.
 * No DOM. UMD: window.StarCG_AfkSync in the browser, module.exports in Node (see test/afk-sync.test.mjs).
 *
 * Server side: supabase migration 20261003061501_afk_tracker_sync.sql in the starcg-market-tracker repo.
 * The table cannot be read through the API; only afk_state_get / afk_state_put / afk_state_delete can touch it,
 * and each needs the sync code. The code is 25 random base32 characters (125 bits) made in the browser; the
 * server stores only its SHA-256.
 *
 * SUPABASE_URL and SUPABASE_KEY below are the project URL and its *publishable* (anon) key. That key is public
 * by design (the tracker web app ships the same one in its client bundle); it grants nothing the migration did not.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StarCG_AfkSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SUPABASE_URL = 'https://rlljvimsrfthejpkofxo.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_oS1dTipH_d3k0HHjMDXPnQ_Axm2Ge-i';

  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  var CODE_LEN = 25;
  var TIMEOUT_MS = 20000;

  function SyncError(kind, message, status) {
    this.name = 'SyncError';
    this.kind = kind;
    this.message = message || kind;
    this.status = status || 0;
  }
  SyncError.prototype = Object.create(Error.prototype);
  SyncError.prototype.constructor = SyncError;

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

  /** 25 chars of A-Z2-7. 256 is a multiple of 32, so (byte & 31) is uniform: no modulo bias. */
  function generateCode(fillRandom) {
    var fill = fillRandom;
    if (!fill) {
      var c = typeof crypto !== 'undefined' ? crypto : null;
      if (!c || typeof c.getRandomValues !== 'function') throw new SyncError('no-crypto', '這個瀏覽器不支援安全亂數，無法產生同步代碼。');
      fill = function (b) { return c.getRandomValues(b); };
    }
    var bytes = new Uint8Array(CODE_LEN);
    fill(bytes);
    var s = '';
    for (var i = 0; i < CODE_LEN; i++) s += ALPHABET.charAt(bytes[i] & 31);
    return s;
  }

  /** XXXXX-XXXXX-XXXXX-XXXXX-XXXXX, for showing and copying */
  function formatCode(code) {
    var s = String(code || '');
    var parts = [];
    for (var i = 0; i < s.length; i += 5) parts.push(s.slice(i, i + 5));
    return parts.join('-');
  }

  /** accepts any case, spaces and hyphens; returns the bare 25-char code or null */
  function normalizeCode(input) {
    var s = String(input == null ? '' : input).toUpperCase().replace(/[\s\-_]/g, '');
    return /^[A-Z2-7]{25}$/.test(s) ? s : null;
  }

  function maskCode(code) {
    var s = String(code || '');
    if (s.length < 5) return '';
    return formatCode(s.slice(0, s.length - 5).replace(/./g, '•') + s.slice(-5));
  }

  function classify(status, body, text) {
    var msg = body && typeof body.message === 'string' ? body.message : '';
    if (msg === 'invalid_code') return new SyncError('invalid-code', '同步代碼格式不正確。', status);
    if (msg === 'state_too_large') return new SyncError('too-large', '資料太大，無法上傳（上限約 2 MB）。', status);
    if (msg === 'invalid_state') return new SyncError('invalid-state', '資料格式不正確，無法上傳。', status);
    if (msg === 'capacity_reached') return new SyncError('capacity', '雲端暫時額滿，請稍後再試。', status);
    if (status === 401 || status === 403) return new SyncError('auth', '雲端拒絕存取（金鑰或權限設定有問題）。', status);
    if (status === 404) return new SyncError('server', '雲端功能還沒有安裝（找不到同步函式）。', status);
    if (status === 429) return new SyncError('rate-limit', '請求太頻繁，稍後會自動重試。', status);
    return new SyncError('server', '雲端暫時無法使用（' + status + '）。', status);
  }

  /**
   * opts: { url, key, fetchImpl, timeoutMs }. Every method returns a Promise and rejects with a SyncError
   * whose .kind is one of network | timeout | invalid-code | too-large | invalid-state | capacity | auth | rate-limit | server | bad-response.
   */
  function createClient(opts) {
    opts = opts || {};
    var url = String(opts.url || SUPABASE_URL).replace(/\/+$/, '');
    var key = opts.key || SUPABASE_KEY;
    var timeoutMs = isNum(opts.timeoutMs) ? opts.timeoutMs : TIMEOUT_MS;
    var doFetch = opts.fetchImpl || (typeof fetch === 'function' ? function (u, o) { return fetch(u, o); } : null);

    function rpc(name, args) {
      if (!doFetch) return Promise.reject(new SyncError('network', '這個瀏覽器無法連線到雲端。'));
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timedOut = false;
      var timer = ctrl ? setTimeout(function () { timedOut = true; ctrl.abort(); }, timeoutMs) : null;
      var done = function () { if (timer) clearTimeout(timer); };
      var req;
      try {
        req = doFetch(url + '/rest/v1/rpc/' + name, {
          method: 'POST',
          headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
          signal: ctrl ? ctrl.signal : undefined,
        });
      } catch (e) { done(); return Promise.reject(new SyncError('network', '無法連線到雲端。')); }
      return Promise.resolve(req).then(function (res) {
        return res.text().then(function (text) {
          done();
          var body = null;
          try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
          if (res.ok) return body;
          throw classify(res.status, body, text);
        });
      }, function () {
        done();
        throw timedOut ? new SyncError('timeout', '連線雲端逾時。') : new SyncError('network', '無法連線到雲端，請檢查網路。');
      });
    }

    function shaped(ok, body) {
      if (!ok) throw new SyncError('bad-response', '雲端回傳了無法理解的內容。');
      return body;
    }

    return {
      /** -> {found:false} | {found:true, state, revision, updatedAt} */
      pull: function (code) {
        return rpc('afk_state_get', { p_code: code }).then(function (b) {
          if (b && b.found === false) return { found: false };
          return shaped(!!b && b.found === true && isObj(b.state) && isNum(b.revision),
            { found: true, state: b && b.state, revision: b && b.revision, updatedAt: b && b.updatedAt });
        });
      },
      /** -> {ok:true, revision, updatedAt} | {ok:false, conflict:true, state, revision, updatedAt} */
      push: function (code, state, baseRevision) {
        return rpc('afk_state_put', { p_code: code, p_state: state, p_base_revision: baseRevision }).then(function (b) {
          if (b && b.ok === true && isNum(b.revision)) return { ok: true, revision: b.revision, updatedAt: b.updatedAt };
          return shaped(!!b && b.ok === false && b.conflict === true && isObj(b.state) && isNum(b.revision),
            { ok: false, conflict: true, state: b && b.state, revision: b && b.revision, updatedAt: b && b.updatedAt });
        });
      },
      /** -> {deleted: boolean} */
      remove: function (code) {
        return rpc('afk_state_delete', { p_code: code }).then(function (b) {
          return shaped(!!b && typeof b.deleted === 'boolean', { deleted: !!(b && b.deleted) });
        });
      },
    };
  }

  /**
   * What to do after looking at the cloud copy.
   *   cloud : the pull() result
   *   meta  : { revision } = the cloud revision this browser last synced with (0 = never)
   *   dirty : true when this browser has changes the cloud has not seen (for a never-synced browser: it has any data)
   * Returns { action: 'noop' | 'push' | 'pull' | 'conflict', base?: number }.
   * Nothing is ever overwritten silently: a push only happens when the cloud is exactly where we left it
   * (or does not exist), a pull only when we have nothing unsent, and everything else is a conflict for the user.
   */
  function planSync(cloud, meta, dirty) {
    var mr = meta && isNum(meta.revision) && meta.revision > 0 ? meta.revision : 0;
    if (!cloud || !cloud.found) return { action: 'push', base: 0 };
    var cr = cloud.revision;
    if (!isNum(cr)) return { action: 'conflict' };
    if (cr === mr) return dirty ? { action: 'push', base: cr } : { action: 'noop' };
    if (cr > mr) return dirty ? { action: 'conflict' } : { action: 'pull' };
    return { action: 'conflict' }; // the cloud went backwards (restored from a backup, or a different history)
  }

  /** seconds to wait before retrying after the n-th consecutive failure (n starts at 1), capped at 5 minutes */
  function retryDelayMs(failures) {
    var n = Math.max(1, Math.floor(isNum(failures) ? failures : 1));
    return Math.min(300000, 15000 * Math.pow(2, n - 1));
  }

  return {
    ALPHABET: ALPHABET, CODE_LEN: CODE_LEN,
    SyncError: SyncError, generateCode: generateCode, formatCode: formatCode, normalizeCode: normalizeCode, maskCode: maskCode,
    createClient: createClient, planSync: planSync, retryDelayMs: retryDelayMs,
  };
});
