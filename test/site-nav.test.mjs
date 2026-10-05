// The site menu (starcg_afk_nav.js) and the Vercel stage (scripts/deploy-vercel.sh) are only wired by file name,
// so these checks catch a renamed/missing page or a rewrite pointing nowhere before a deploy does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

const nav = read('starcg_afk_nav.js');
const deploy = read('scripts/deploy-vercel.sh');
const internalHrefs = [...nav.matchAll(/href: '([^']+)'/g)].map((m) => m[1]).filter((h) => !h.startsWith('http'));

test('N1 menu lists the five tools and every target file exists', () => {
  assert.deepEqual(
    internalHrefs.sort(),
    ['StarCG_AfkTracker.html', 'StarCG_CharacterCalculator.html', 'StarCG_PetCalculator.html', 'StarCG_PriceChecker.html', 'index.html'],
  );
  for (const h of internalHrefs) assert.ok(existsSync(join(root, h)), `${h} is missing`);
});

test('N2 each page that shows the menu loads the script exactly once', () => {
  for (const f of ['index.html', 'StarCG_PriceChecker.html', 'StarCG_PetCalculator.html', 'StarCG_CharacterCalculator.html']) {
    const n = (read(f).match(/<script src="starcg_afk_nav\.js"><\/script>/g) || []).length;
    assert.equal(n, 1, `${f} loads starcg_afk_nav.js ${n} times`);
  }
});

test('N3 the AFK page links to the other tools itself (it does not load the script)', () => {
  const afk = read('StarCG_AfkTracker.html');
  assert.ok(!afk.includes('starcg_afk_nav.js'));
  for (const h of ['StarCG_PriceChecker.html', 'StarCG_PetCalculator.html', 'StarCG_CharacterCalculator.html', 'index.html']) {
    assert.ok(afk.includes(`href="${h}"`), `AFK header lacks a link to ${h}`);
  }
});

test('N4 deploy stage: "/" is the marketplace and every rewrite destination exists in the stage', () => {
  const json = JSON.parse(/cat > "\$STAGE\/vercel\.json" <<'JSON'\n([\s\S]*?)\nJSON/.exec(deploy)[1]);
  const bySource = Object.fromEntries(json.rewrites.map((r) => [r.source, r.destination]));
  assert.equal(bySource['/'], '/StarCG_PriceChecker.html');
  assert.equal(bySource['/index.html'], '/StarCG_DamageCalculator.html');
  // the stage renames index.html -> StarCG_DamageCalculator.html (so a static index.html cannot shadow "/")
  assert.match(deploy, /mv "\$STAGE\/index\.html" "\$STAGE\/StarCG_DamageCalculator\.html"/);
  const stageFiles = new Set(['StarCG_DamageCalculator.html']);
  for (const [src, dest] of Object.entries(bySource)) {
    const file = dest.slice(1);
    assert.ok(stageFiles.has(file) || existsSync(join(root, file)), `${src} -> ${dest} has no file`);
  }
});
