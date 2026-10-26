import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1]
  .replace(/initTheme\(\);\s*boot\(\)\.catch\([\s\S]*\);\s*$/, '');
const shipped = JSON.parse(fs.readFileSync(path.join(root, 'data.json'), 'utf8'));

function element() {
  return {
    innerHTML: '',
    textContent: '',
    hidden: false,
    className: '',
    style: { setProperty() {}, width: '' },
    classList: { add() {}, remove() {} },
    dataset: {},
    setAttribute() {},
    addEventListener() {},
  };
}

async function render(data) {
  const ids = {};
  const document = {
    title: '',
    documentElement: {
      setAttribute() {},
      getAttribute() { return 'night'; },
    },
    querySelector() { return { setAttribute() {} }; },
    querySelectorAll() { return []; },
    getElementById(id) { return ids[id] || (ids[id] = element()); },
  };
  const context = {
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    JSON,
    Intl,
    performance: { now: () => 0 },
    requestAnimationFrame: (fn) => fn(0),
    setTimeout,
    document,
    window: {
      matchMedia(query) { return { matches: String(query).includes('reduce') }; },
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    navigator: {},
    fetch: async () => ({ ok: true, json: async () => structuredClone(data) }),
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  vm.runInContext('initTheme()', context);
  await vm.runInContext('boot()', context);
  return {
    nohits: ids.nohits.innerHTML,
    trend: ids['score-trend'].innerHTML,
    context,
    ids,
  };
}

function board(overrides = {}) {
  return { ...structuredClone(shipped), ...overrides };
}

test('shipped empty board waits for a scrape and does not fake a previous day', async () => {
  assert.equal(shipped.no_hits, null);
  assert.equal(shipped.previous_day, null);
  assert.equal(shipped.date, null);
  const view = await render(shipped);
  assert.match(view.nohits, /No scrape yet/);
  assert.doesNotMatch(view.nohits, /cleared the 5k floor/);
  assert.match(view.trend, /vs target/);
  assert.doesNotMatch(view.trend, /vs prev day/);
  assert.doesNotMatch(view.trend, /on pace/);
});

test('null no_hits is unknown and an empty list means the floor was cleared', async () => {
  const view = await render(board());
  assert.equal(vm.runInContext('normalizeNoHits(null) === null', view.context), true);
  assert.equal(vm.runInContext('JSON.stringify(normalizeNoHits([]))', view.context), '[]');
  vm.runInContext('renderNoHits(null)', view.context);
  assert.match(view.ids.nohits.innerHTML, /No scrape yet/);
  vm.runInContext('renderNoHits([])', view.context);
  assert.match(view.ids.nohits.innerHTML, /cleared the 5k floor/);

  const cleared = await render(board({
    date: '2026-10-25',
    no_hits: [],
    previous_day: null,
  }));
  assert.match(cleared.nohits, /cleared the 5k floor/);
  assert.doesNotMatch(cleared.nohits, /No scrape yet/);
});

test('a listed miss renders the handle', async () => {
  const view = await render(board({
    date: '2026-10-25',
    no_hits: [{ handle: '@quiet', reason: 'Below floor', max_views: 1200 }],
  }));
  assert.match(view.nohits, /@quiet/);
  assert.match(view.nohits, /Below floor/);
  assert.doesNotMatch(view.nohits, /cleared the 5k floor/);
});

test('a zeroed previous day is not a comparison, a dated score is', async () => {
  const placeholder = await render(board({
    previous_day: { date: null, hits_count: 0, total_views: 0, x_score: 0 },
  }));
  assert.match(placeholder.trend, /vs target/);
  assert.doesNotMatch(placeholder.trend, /vs prev day/);
  assert.doesNotMatch(placeholder.trend, /on pace/);

  const scored = await render(board({
    previous_day: { date: '2026-10-25', hits_count: 1, total_views: 8000, x_score: 40 },
  }));
  assert.match(scored.trend, /vs prev day/);
  assert.doesNotMatch(scored.trend, /vs target/);

  const zeroDay = await render(board({
    previous_day: { date: '2026-10-25', hits_count: 0, total_views: 0, x_score: 0 },
  }));
  assert.match(zeroDay.trend, /on pace/);
  assert.match(zeroDay.trend, /vs prev day/);
});
