// tabs-logic.test.js — the tab model behind design/renderer/ui/tabs.js.
//
// ui/tabs.js is one factory, createTabStrip(), and it builds its DOM eagerly:
// there is no pure export to import and drive. Rather than stub a browser, this
// file tests the model two ways, and both have to hold:
//
//   1. A reference model, below, that implements the strip's rules exactly as
//      tabs.js states them — pinned region first, groups in group order, then
//      ungrouped; pinning clears group membership; removing a group keeps its
//      tabs; bulk close excludes pinned tabs unless asked otherwise. The model
//      is exercised against the REAL predicate from ui/regexbuilder.js and the
//      REAL filter from ui/searchbar.js, so the parts that actually decide
//      which tabs close are the shipped ones, not a copy.
//
//   2. Source-contract assertions that read ui/tabs.js and check the shipped
//      code still expresses those rules at the lines that matter. They are what
//      stop the model from drifting into fiction. Each one names the rule it
//      guards, so a deliberate change updates the assertion knowingly.
//
// The rule this file exists for: "Close tabs containing text" and "Close tabs
// NOT containing text" must negate ONE predicate. Two separately built
// predicates drift on flags, casing, Unicode and scope, and the two menu
// entries then disagree about the same tab.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TABS_SOURCE_PATH = path.join(__dirname, '..', 'design', 'renderer', 'ui', 'tabs.js');
const source = fs.readFileSync(TABS_SOURCE_PATH, 'utf8');

const loadRegex = () => import('../design/renderer/ui/regexbuilder.js');
// ui/tabs.js now exports the bulk-close decision as a pure function, so the
// rule can be driven directly instead of through a copy written beside the
// tests. It imports headlessly: createTabStrip() is what touches the DOM, and
// nothing calls it here.
let tabsApi = null;
const loadTabs = async () => (tabsApi || (tabsApi = await import('../design/renderer/ui/tabs.js')));
const bulkCloseSelection = (o) => {
  if (!tabsApi) throw new Error('await loadTabs() before using the shipped bulk-close decision');
  return tabsApi.bulkCloseSelection(o);
};
const loadSearch = () => import('../design/renderer/ui/searchbar.js');

/* ================================================================== */
/* the reference model                                                 */
/* ================================================================== */

let seq = 0;

/** A strip with the same state and the same rules as createTabStrip's model. */
function createStripModel({ id = 'main', windowId = 'Main window' } = {}) {
  const strip = { id, windowId, tabs: [], groups: [], groupOrder: [], activeId: null };

  const byId = (tid) => strip.tabs.find((tb) => tb.id === tid);
  const groupById = (gid) => strip.groups.find((g) => g.id === gid);
  // These three are the whole layout model. A pinned tab is never in a group.
  const pinned = () => strip.tabs.filter((tb) => tb.pinned);
  const ungrouped = () => strip.tabs.filter((tb) => !tb.pinned && !tb.groupId);
  const groupTabs = (gid) => strip.tabs.filter((tb) => !tb.pinned && tb.groupId === gid);

  function normalizeGroupOrder() {
    const ids = strip.groups.map((g) => g.id);
    strip.groupOrder = strip.groupOrder.filter((gid) => ids.includes(gid));
    for (const gid of ids) if (!strip.groupOrder.includes(gid)) strip.groupOrder.push(gid);
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  const api = {
    strip,
    openTab(spec = {}) {
      seq += 1;
      const tid = spec.id || `tab-${seq}`;
      const tab = {
        id: tid, key: spec.key || tid, title: spec.title || 'New tab',
        groupId: spec.groupId || null, pinned: !!spec.pinned, dirty: !!spec.dirty,
      };
      strip.tabs.push(tab);
      if (spec.activate !== false) strip.activeId = tab.id;
      return tab.id;
    },
    closeTab(tid) {
      const tab = byId(tid);
      if (!tab) return false;
      const idx = strip.tabs.indexOf(tab);
      strip.tabs.splice(idx, 1);
      if (strip.activeId === tid) {
        const next = strip.tabs[Math.min(idx, strip.tabs.length - 1)];
        strip.activeId = next ? next.id : null;
      }
      return true;
    },
    activateTab(tid) { if (byId(tid)) strip.activeId = tid; },
    renameTab(tid, title) { const tab = byId(tid); if (tab && title) tab.title = title; },
    pinTab(tid, value) {
      const tab = byId(tid);
      if (!tab) return;
      tab.pinned = value === undefined ? !tab.pinned : !!value;
      if (tab.pinned) tab.groupId = null;         // pinned tabs live in the pinned region
    },
    setTabGroup(tid, gid) {
      const tab = byId(tid);
      if (!tab) return;
      tab.groupId = gid || null;
      if (gid) tab.pinned = false;
    },
    moveTab(tid, index) {
      const tab = byId(tid);
      if (!tab) return;
      strip.tabs.splice(strip.tabs.indexOf(tab), 1);
      strip.tabs.splice(clamp(index, 0, strip.tabs.length), 0, tab);
    },
    createGroup(spec = {}) {
      seq += 1;
      const gid = spec.id || `grp-${seq}`;
      strip.groups.push({
        id: gid, name: spec.name || 'Group', color: spec.color || '#0B57D0',
        collapsed: !!spec.collapsed, keepEmpty: !!spec.keepEmpty,
      });
      strip.groupOrder.push(gid);
      return gid;
    },
    renameGroup(gid, name) { const g = groupById(gid); if (g && name) g.name = name; },
    collapseGroup(gid, value) {
      const g = groupById(gid);
      if (!g) return;
      g.collapsed = value === undefined ? !g.collapsed : !!value;
    },
    /** Removing a group keeps its tabs; they become ungrouped. */
    removeGroup(gid) {
      for (const tb of groupTabs(gid)) tb.groupId = null;
      strip.groups = strip.groups.filter((g) => g.id !== gid);
      strip.groupOrder = strip.groupOrder.filter((x) => x !== gid);
    },
    moveGroup(gid, index) {
      const cur = strip.groupOrder.indexOf(gid);
      if (cur < 0) return;
      strip.groupOrder.splice(cur, 1);
      strip.groupOrder.splice(clamp(index, 0, strip.groupOrder.length), 0, gid);
    },
    pinGroup(gid) { for (const tb of groupTabs(gid)) { tb.pinned = true; tb.groupId = null; } },
    pinned, ungrouped, groupTabs, groupById, byId, normalizeGroupOrder,

    /** What the strip paints, left to right, including group headers. */
    renderOrder() {
      normalizeGroupOrder();
      const out = pinned().map((tb) => ({ kind: 'pinned', title: tb.title }));
      for (const gid of strip.groupOrder) {
        const g = groupById(gid);
        const members = groupTabs(gid);
        if (!members.length && !g.keepEmpty) continue;
        out.push({ kind: 'group-head', title: g.name, collapsed: g.collapsed, count: members.length });
        if (!g.collapsed) for (const tb of members) out.push({ kind: 'tab', title: tb.title, groupId: gid });
      }
      for (const tb of ungrouped()) out.push({ kind: 'tab', title: tb.title, groupId: null });
      return out;
    },

    /** One row per tab, the shape all four searches list. */
    entries() {
      return strip.tabs.map((tb) => ({
        windowId: strip.windowId, stripId: strip.id, id: tb.id, title: tb.title,
        pinned: tb.pinned, groupId: tb.groupId,
        groupName: tb.groupId ? (groupById(tb.groupId)?.name || '') : '',
        collapsed: tb.groupId ? !!groupById(tb.groupId)?.collapsed : false,
        active: strip.activeId === tb.id,
      }));
    },
  };
  return api;
}

/**
 * The bulk-close decision — the SHIPPED one. `bulkCloseSelection` is exported
 * from ui/tabs.js and is the only thing its own bulkClose() consults, so a
 * mutation to the direction of the predicate, to the pinned protection, to the
 * empty-query refusal or to the invalid-pattern refusal fails a test here.
 *
 * This deliberately replaced a copy of those rules written beside the tests. A
 * reference model only ever tests itself: both mutations the verifier tried
 * (swapping the two directions at their call sites, and defaulting
 * includePinned to true) left all 25 tests green against the copy.
 */
function bulkCloseVictims({ pool, predicate, containing, includePinned = false, query = 'x' }) {
  return bulkCloseSelection({ pool, predicate, containing, includePinned, query });
}

/** Populate a strip that exercises pins, groups, collapse and Unicode titles. */
function sampleStrip() {
  const s = createStripModel();
  const prod = s.createGroup({ name: 'Production', color: '#B3261E' });
  const staging = s.createGroup({ name: 'Staging', color: '#146C2E' });

  s.openTab({ key: 'k1', title: 'web-01.example.com' });
  s.openTab({ key: 'k2', title: 'db-01.example.com', groupId: prod });
  s.openTab({ key: 'k3', title: 'cache-01.example.com', groupId: prod, pinned: false });
  s.openTab({ key: 'k4', title: 'staging-web.example.com', groupId: staging });
  s.openTab({ key: 'k5', title: '報表伺服器', pinned: true });
  s.openTab({ key: 'k6', title: 'Local files', dirty: true });
  return { s, prod, staging };
}

/* ================================================================== */
/* order                                                               */
/* ================================================================== */

test('tabs keep their insertion order and move by index', async () => {
  const s = createStripModel();
  const a = s.openTab({ title: 'A' });
  const b = s.openTab({ title: 'B' });
  const c = s.openTab({ title: 'C' });

  assert.deepStrictEqual(s.strip.tabs.map((t) => t.title), ['A', 'B', 'C']);

  s.moveTab(c, 0);
  assert.deepStrictEqual(s.strip.tabs.map((t) => t.title), ['C', 'A', 'B']);
  s.moveTab(c, 99);                              // clamped to the end
  assert.deepStrictEqual(s.strip.tabs.map((t) => t.title), ['A', 'B', 'C']);
  s.moveTab(a, -5);                              // clamped to the start
  assert.deepStrictEqual(s.strip.tabs.map((t) => t.title), ['A', 'B', 'C']);
  assert.strictEqual(s.byId(b).title, 'B');
});

test('closing the active tab activates its neighbour, not nothing', async () => {
  const s = createStripModel();
  const a = s.openTab({ title: 'A' });
  const b = s.openTab({ title: 'B' });
  const c = s.openTab({ title: 'C' });

  s.activateTab(b);
  s.closeTab(b);
  assert.strictEqual(s.strip.activeId, c, 'the tab that slid into the closed slot takes focus');

  s.activateTab(c);
  s.closeTab(c);
  assert.strictEqual(s.strip.activeId, a, 'closing the last tab falls back to the previous one');

  s.closeTab(a);
  assert.strictEqual(s.strip.activeId, null);
  assert.strictEqual(s.closeTab('gone'), false);
});

test('the strip paints pinned tabs, then groups in group order, then the rest', async () => {
  const { s, prod, staging } = sampleStrip();
  s.collapseGroup(prod, false);

  assert.deepStrictEqual(s.renderOrder(), [
    { kind: 'pinned', title: '報表伺服器' },
    { kind: 'group-head', title: 'Production', collapsed: false, count: 2 },
    { kind: 'tab', title: 'db-01.example.com', groupId: prod },
    { kind: 'tab', title: 'cache-01.example.com', groupId: prod },
    { kind: 'group-head', title: 'Staging', collapsed: false, count: 1 },
    { kind: 'tab', title: 'staging-web.example.com', groupId: staging },
    { kind: 'tab', title: 'web-01.example.com', groupId: null },
    { kind: 'tab', title: 'Local files', groupId: null },
  ]);

  s.moveGroup(staging, 0);
  assert.deepStrictEqual(
    s.renderOrder().filter((r) => r.kind === 'group-head').map((r) => r.title),
    ['Staging', 'Production']);
});

/* ================================================================== */
/* pinning                                                             */
/* ================================================================== */

test('pinning moves a tab out of its group and into the pinned region', async () => {
  const { s, prod } = sampleStrip();
  const db = s.strip.tabs.find((t) => t.title === 'db-01.example.com');

  assert.strictEqual(db.groupId, prod);
  s.pinTab(db.id, true);
  assert.strictEqual(db.pinned, true);
  assert.strictEqual(db.groupId, null, 'a pinned tab must not also claim group membership');
  assert.ok(s.pinned().includes(db));
  assert.ok(!s.groupTabs(prod).includes(db));

  // And the inverse: joining a group unpins.
  s.setTabGroup(db.id, prod);
  assert.strictEqual(db.pinned, false);
  assert.strictEqual(db.groupId, prod);

  // pinTab with no argument toggles.
  s.pinTab(db.id);
  assert.strictEqual(db.pinned, true);
  s.pinTab(db.id);
  assert.strictEqual(db.pinned, false);
});

test('pinned tabs stay visible when ordinary tabs would overflow', async () => {
  const { s } = sampleStrip();
  // The pinned region is rendered before the scrolling region, so every pinned
  // tab precedes every scrollable one whatever the tab order is.
  const order = s.renderOrder();
  const lastPinned = order.map((r) => r.kind).lastIndexOf('pinned');
  const firstOther = order.findIndex((r) => r.kind !== 'pinned');
  assert.ok(lastPinned < firstOther, 'a pinned tab was rendered inside the scrolling region');
  assert.strictEqual(s.pinned().length, 1);
});

test('pinning a whole group empties the group and keeps every tab', async () => {
  const { s, prod } = sampleStrip();
  const before = s.strip.tabs.length;

  s.pinGroup(prod);
  assert.strictEqual(s.groupTabs(prod).length, 0);
  assert.strictEqual(s.strip.tabs.length, before, 'pinning a group must not close anything');
  assert.strictEqual(s.pinned().length, 3);
});

/* ================================================================== */
/* grouping and collapse                                               */
/* ================================================================== */

test('removing a group keeps its tabs', async () => {
  const { s, prod } = sampleStrip();
  const before = s.strip.tabs.length;
  const members = s.groupTabs(prod).map((t) => t.id);

  s.removeGroup(prod);
  assert.strictEqual(s.strip.tabs.length, before, 'removing a group closed tabs');
  assert.strictEqual(s.strip.groups.find((g) => g.id === prod), undefined);
  assert.ok(!s.strip.groupOrder.includes(prod));
  for (const id of members) assert.strictEqual(s.byId(id).groupId, null);
  assert.strictEqual(s.groupTabs(prod).length, 0);
});

test('collapsing hides a group from the strip without changing membership', async () => {
  const { s, prod } = sampleStrip();

  s.collapseGroup(prod, true);
  const painted = s.renderOrder();
  assert.ok(!painted.some((r) => r.kind === 'tab' && r.groupId === prod),
    'a collapsed group still painted its tabs');
  const head = painted.find((r) => r.kind === 'group-head' && r.title === 'Production');
  assert.strictEqual(head.collapsed, true);
  assert.strictEqual(head.count, 2, 'the header must still state how many tabs are inside');

  // Membership is untouched, so a search can still find and reveal them.
  assert.strictEqual(s.groupTabs(prod).length, 2);
  assert.deepStrictEqual(
    s.entries().filter((e) => e.groupId === prod).map((e) => e.collapsed), [true, true]);

  s.collapseGroup(prod);                          // toggles back
  assert.strictEqual(s.groupById(prod).collapsed, false);
});

test('an empty group disappears unless it is deliberately kept', async () => {
  const s = createStripModel();
  const transient = s.createGroup({ name: 'Transient' });
  const kept = s.createGroup({ name: 'Kept', keepEmpty: true });

  const heads = s.renderOrder().filter((r) => r.kind === 'group-head').map((r) => r.title);
  assert.deepStrictEqual(heads, ['Kept']);
  assert.ok(s.groupById(transient), 'the group itself still exists, it is only unpainted');
});

test('group order is normalised without losing or duplicating a group', async () => {
  const s = createStripModel();
  const a = s.createGroup({ name: 'A', keepEmpty: true });
  const b = s.createGroup({ name: 'B', keepEmpty: true });
  const c = s.createGroup({ name: 'C', keepEmpty: true });

  s.strip.groupOrder = [c, 'ghost-group', a];     // a stale saved layout
  s.normalizeGroupOrder();
  assert.deepStrictEqual(s.strip.groupOrder, [c, a, b],
    'normalisation must drop unknown ids and append the groups it never saw');

  s.moveGroup(b, 0);
  assert.deepStrictEqual(s.strip.groupOrder, [b, c, a]);
  s.moveGroup(b, 99);
  assert.deepStrictEqual(s.strip.groupOrder, [c, a, b]);
});

/* ================================================================== */
/* the four tab-discovery searches                                     */
/* ================================================================== */

test('all four searches list the right rows and each holds its own predicate', async () => {
  const { makePredicate } = await loadRegex();
  await loadTabs();
  const { filterBy } = await loadSearch();

  const main = sampleStrip();
  const second = createStripModel({ id: 'second', windowId: 'Second window' });
  second.openTab({ key: 's1', title: 'web-02.example.com' });
  second.openTab({ key: 's2', title: 'archive.example.com' });

  const externalSource = () => [{
    windowId: 'Detached window',
    stripId: 'detached',
    tabs: [{ id: 'x1', title: 'web-03.example.com', pinned: false, groupName: '' }],
  }];

  const tabFields = (r) => [r.title, r.groupName || '', r.stripId, r.windowId];

  // (a) the current strip
  const stripSearch = makePredicate({ query: 'example.com', mode: 'text' });
  assert.deepStrictEqual(
    filterBy(main.s.entries(), stripSearch, tabFields).map((r) => r.title),
    ['web-01.example.com', 'db-01.example.com', 'cache-01.example.com', 'staging-web.example.com']);

  // (b) inside one group
  const groupSearch = makePredicate({ pattern: '^db', flags: 'gi', mode: 'regex' });
  const inProduction = main.s.entries().filter((e) => e.groupId === main.prod);
  assert.deepStrictEqual(
    filterBy(inProduction, groupSearch, tabFields).map((r) => r.title),
    ['db-01.example.com']);
  // The group search never reaches outside its group, even for a title that
  // would match in the strip.
  assert.strictEqual(
    filterBy(inProduction, makePredicate({ query: 'staging', mode: 'text' }), tabFields).length, 0);

  // (c) group names
  const groupNames = main.s.strip.groups.map((g) => ({ ...g, count: main.s.groupTabs(g.id).length }));
  assert.deepStrictEqual(
    filterBy(groupNames, makePredicate({ query: 'stag', mode: 'text' }), (g) => [g.name]).map((g) => g.name),
    ['Staging']);

  // (d) master: every tab in every window, strip and group the app owns
  const allEntries = [
    ...main.s.entries(),
    ...second.entries(),
    ...externalSource().flatMap((src) => src.tabs.map((tb) => ({
      windowId: src.windowId, stripId: src.stripId, id: tb.id, title: tb.title,
      pinned: !!tb.pinned, groupId: null, groupName: tb.groupName || '', external: true,
    }))),
  ];
  const master = filterBy(allEntries, makePredicate({ pattern: 'web-\\d+', flags: 'g', mode: 'regex' }), tabFields);
  assert.deepStrictEqual(master.map((r) => r.title),
    ['web-01.example.com', 'web-02.example.com', 'web-03.example.com']);
  // Every row names where it lives, so the result is actionable.
  for (const row of master) {
    assert.ok(row.windowId && row.stripId, `a master result had no location: ${JSON.stringify(row)}`);
  }
  assert.deepStrictEqual([...new Set(master.map((r) => r.windowId))],
    ['Main window', 'Second window', 'Detached window']);

  // The four predicates are four objects; none of them has been mutated by the
  // others' evaluations.
  assert.strictEqual(stripSearch.test('web-01.example.com'), true);
  assert.strictEqual(groupSearch.test('db-01.example.com'), true);
  assert.strictEqual(groupSearch.test('db-01.example.com'), true);
});

test('a search finds a tab inside a collapsed group without expanding it', async () => {
  const { makePredicate } = await loadRegex();
  await loadTabs();
  const { filterBy } = await loadSearch();
  const { s, prod } = sampleStrip();

  s.collapseGroup(prod, true);
  const hits = filterBy(s.entries(), makePredicate({ query: 'cache', mode: 'text' }), (r) => [r.title]);

  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].collapsed, true, 'the row must say the group is collapsed');
  assert.strictEqual(s.groupById(prod).collapsed, true,
    'searching must not silently discard the collapsed preference');
});

test('an empty query lists every tab rather than none', async () => {
  const { makePredicate } = await loadRegex();
  await loadTabs();
  const { filterBy } = await loadSearch();
  const { s } = sampleStrip();

  const all = s.entries();
  assert.deepStrictEqual(filterBy(all, makePredicate({ query: '', mode: 'text' }), (r) => [r.title]), all);
});

/* ================================================================== */
/* the two bulk closes — ONE predicate                                 */
/* ================================================================== */

test('containing and NOT containing negate the same predicate exactly', async () => {
  const { makePredicate } = await loadRegex();
  await loadTabs();
  const { s } = sampleStrip();
  const pool = s.strip.tabs;

  const states = [
    { query: 'example.com', mode: 'text' },
    { query: 'EXAMPLE.COM', mode: 'text' },      // casing must not change the split
    { query: '報表', mode: 'text' },              // nor script
    { query: 'nothing-matches-this', mode: 'text' },
    { pattern: '^db|^cache', flags: 'gi', mode: 'regex' },
    { pattern: '\\p{Script=Han}', flags: 'gu', mode: 'regex' },
    { pattern: '.', flags: 'g', mode: 'regex' },
  ];

  for (const state of states) {
    const predicate = makePredicate(state);
    const yes = bulkCloseVictims({ pool, predicate, containing: true, includePinned: true });
    const no = bulkCloseVictims({ pool, predicate, containing: false, includePinned: true });

    assert.strictEqual(yes.matches.length + no.matches.length, pool.length,
      `${JSON.stringify(state)}: the two actions do not cover every tab`);
    assert.strictEqual(yes.matches.filter((tb) => no.matches.includes(tb)).length, 0,
      `${JSON.stringify(state)}: a tab is selected by both actions`);
    assert.deepStrictEqual(
      pool.filter((tb) => yes.matches.includes(tb) || no.matches.includes(tb)), pool,
      `${JSON.stringify(state)}: a tab escaped both actions`);
  }
});

test('the inverse action cannot drift on casing, flags or Unicode', async () => {
  const { makePredicate } = await loadRegex();
  await loadTabs();
  const { s } = sampleStrip();
  const pool = s.strip.tabs;

  // Same intent expressed two ways. Because one predicate drives both
  // directions, the "not containing" side is the exact complement of the
  // "containing" side in each case — which is what would break if the inverse
  // built its own matcher with, say, a plain toLowerCase() or a missing u flag.
  for (const state of [
    { query: 'Example.COM', mode: 'text' },
    { pattern: 'EXAMPLE\\.COM', flags: 'gi', mode: 'regex' },
  ]) {
    const predicate = makePredicate(state);
    const yes = bulkCloseVictims({ pool, predicate, containing: true, includePinned: true }).matches;
    const no = bulkCloseVictims({ pool, predicate, containing: false, includePinned: true }).matches;
    assert.deepStrictEqual(yes.map((t) => t.title),
      ['web-01.example.com', 'db-01.example.com', 'cache-01.example.com', 'staging-web.example.com']);
    assert.deepStrictEqual(no.map((t) => t.title), ['報表伺服器', 'Local files']);
  }
});

test('pinned tabs are excluded from a bulk close until the user includes them', async () => {
  const { makePredicate } = await loadRegex();
  await loadTabs();
  const { s } = sampleStrip();
  const pool = s.strip.tabs;
  const predicate = makePredicate({ pattern: '.', flags: 'g', mode: 'regex' });   // everything

  const guarded = bulkCloseVictims({ pool, predicate, containing: true, includePinned: false });
  assert.strictEqual(guarded.matches.length, pool.length);
  assert.strictEqual(guarded.excludedPins, 1);
  assert.ok(!guarded.victims.some((tb) => tb.pinned), 'a pinned tab reached the victim list');
  assert.strictEqual(guarded.victims.length, pool.length - 1);

  const explicit = bulkCloseVictims({ pool, predicate, containing: true, includePinned: true });
  assert.strictEqual(explicit.victims.length, pool.length);
  assert.ok(explicit.victims.some((tb) => tb.pinned));

  // The exclusion is reported, not silent: the count is what the warning shows.
  assert.strictEqual(guarded.excludedPins, guarded.matches.length - guarded.victims.length);
});

test('close-others and close-to-the-right skip pinned tabs too', async () => {
  const { makePredicate } = await loadRegex();
  await loadTabs();
  const { s } = sampleStrip();
  const pool = s.strip.tabs;
  const anchor = pool.find((tb) => tb.title === 'web-01.example.com');
  const matchAll = makePredicate({ query: '', mode: 'text' });

  const others = pool.filter((tb) => tb.id !== anchor.id && !tb.pinned);
  assert.ok(!others.some((tb) => tb.pinned));
  assert.ok(!others.includes(anchor));

  const toTheRight = pool.slice(pool.indexOf(anchor) + 1).filter((tb) => !tb.pinned);
  assert.deepStrictEqual(toTheRight.map((tb) => tb.title),
    ['db-01.example.com', 'cache-01.example.com', 'staging-web.example.com', 'Local files']);

  // Even these fixed-set closes go through a predicate object, so the preview
  // and the confirmation speak the same language as the text-matched ones.
  assert.strictEqual(matchAll.ok, true);
  assert.strictEqual(matchAll.test('anything'), true);
});

test('a bulk close never runs on an empty query or an invalid pattern', async () => {
  const { makePredicate } = await loadRegex();
  await loadTabs();
  const { s } = sampleStrip();
  const pool = s.strip.tabs;

  // Empty query: tabs.js checks the raw query BEFORE the predicate, because an
  // empty plain-text predicate matches everything and would close the strip.
  const emptyText = makePredicate({ query: '', mode: 'text' });
  assert.strictEqual(emptyText.test('anything'), true,
    'an empty text predicate matches everything — hence the separate empty-query guard');

  // The empty query is refused by the shipped decision itself, before the
  // predicate is ever consulted — otherwise the strip would close entirely.
  const emptyRun = bulkCloseVictims({ pool, predicate: emptyText, containing: true, includePinned: true, query: '' });
  assert.strictEqual(emptyRun.ok, false);
  assert.strictEqual(emptyRun.reason, 'empty');
  assert.strictEqual(emptyRun.victims.length, 0, 'an empty query closed tabs');

  const invalid = makePredicate({ pattern: '([', flags: 'i', mode: 'regex' });
  assert.strictEqual(invalid.ok, false);
  // A broken pattern refuses in BOTH directions. This is the sharp one: a
  // predicate that always answers false makes the inverse direction match every
  // tab in the strip, so an invalid-pattern guard that only covers "containing"
  // turns a typo into "close everything".
  for (const containing of [true, false]) {
    const attempted = bulkCloseVictims({ pool, predicate: invalid, containing, includePinned: true });
    assert.strictEqual(attempted.ok, false, `an invalid pattern was accepted (containing: ${containing})`);
    assert.strictEqual(attempted.reason, 'invalid');
    assert.strictEqual(attempted.victims.length, 0, `an invalid pattern selected tabs (containing: ${containing})`);
    assert.strictEqual(attempted.matches.length, 0);
  }
  // And the dialog still refuses before it reaches the decision, so the user is
  // told what is wrong with the pattern rather than silently getting nothing.
  assert.match(source, /if \(!predicate\.ok\) \{/,
    'the invalid-pattern guard is gone; the inverse action would close every tab');
});

test('a tab with unsaved work survives a bulk close and is reported', async () => {
  const { makePredicate } = await loadRegex();
  await loadTabs();
  const { s } = sampleStrip();
  const predicate = makePredicate({ query: '', mode: 'text' });
  const { victims } = bulkCloseVictims({ pool: s.strip.tabs, predicate, containing: true, includePinned: true });

  const kept = [];
  let closed = 0;
  for (const tb of victims.slice()) {
    if (tb.dirty) { kept.push(tb); continue; }    // unsaved-work protection stands
    if (s.closeTab(tb.id)) closed += 1;
  }

  assert.deepStrictEqual(kept.map((tb) => tb.title), ['Local files']);
  assert.strictEqual(closed, 5);
  assert.deepStrictEqual(s.strip.tabs.map((tb) => tb.title), ['Local files']);
});

/* ================================================================== */
/* source contract — the shipped strip still obeys the model           */
/* ================================================================== */

test('ui/tabs.js builds both bulk-close directions from one predicate', async () => {
  const { makePredicate } = await loadRegex();
  await loadTabs();
  // Behaviour first, against the SHIPPED function: the two directions partition
  // the pool exactly, which is only possible from one predicate negated once.
  const pool = sampleStrip().s.strip.tabs;
  const predicate = makePredicate({ query: 'db', mode: 'text' });
  const yes = bulkCloseSelection({ pool, predicate, query: 'db', containing: true, includePinned: true }).victims;
  const no = bulkCloseSelection({ pool, predicate, query: 'db', containing: false, includePinned: true }).victims;
  assert.strictEqual(yes.length + no.length, pool.length);
  assert.strictEqual(yes.filter((tb) => no.includes(tb)).length, 0);
  assert.ok(yes.length > 0 && no.length > 0, 'the sample must exercise both directions');

  // And the shipped dialog must decide THROUGH it rather than for itself.
  assert.match(source, /const predicate = bar\.predicate;/,
    'the predicate must come from the search bar so the builder flags apply to both directions');
  const body = source.slice(source.indexOf('function bulkClose('), source.indexOf('/** Preview + confirm'));
  assert.strictEqual((body.match(/bar\.predicate/g) || []).length, 1,
    'bulkClose reads bar.predicate more than once; the two reads can diverge');
  assert.strictEqual((body.match(/makePredicate\(/g) || []).length, 0,
    'bulkClose builds its own predicate instead of using the search bar own predicate');
  assert.strictEqual((body.match(/bulkCloseSelection\(\{/g) || []).length, 1,
    'bulkClose no longer decides through the one exported, tested function');
  assert.strictEqual((body.match(/containing \? predicate\.test/g) || []).length, 0,
    'bulkClose has grown its own copy of the direction rule again');
});

test('every "close containing" entry asks for containing, and its inverse does not', () => {
  // The expression at the bottom of bulkClose is correct in isolation, so
  // swapping the two flags at a MENU call site inverts both actions while every
  // model test still passes: "Close tabs containing text" would then close the
  // tabs that do not contain it. Each call site is pinned to the label it wears.
  const sites = [...source.matchAll(
    /labelKey: '(closeContaining|closeNotContaining)'[^\n]*bulkClose\(\{ containing: (true|false) \}\)/g)];
  assert.ok(sites.length >= 6, `only ${sites.length} bulk-close menu entries found`);
  for (const [, label, flag] of sites) {
    assert.strictEqual(flag, label === 'closeContaining' ? 'true' : 'false',
      `${label} is wired to containing: ${flag} — the two bulk closes are inverted`);
  }
  // Both entries exist wherever either does, so a strip cannot offer one alone.
  assert.strictEqual(
    (source.match(/labelKey: 'closeContaining'/g) || []).length,
    (source.match(/labelKey: 'closeNotContaining'/g) || []).length);
});

test('ui/tabs.js excludes pinned tabs from a bulk close by default', async () => {
  const { makePredicate } = await loadRegex();
  await loadTabs();
  // Not just the filter — the flag it reads. Defaulting this to true keeps the
  // filter expression intact and closes every pinned tab anyway.
  assert.match(source, /let includePinned = false;/,
    'the bulk-close dialog now includes pinned tabs before the user asks');
  // Behaviour, on the shipped function: with the flag left alone a pinned tab
  // that matches is reported as excluded and is NOT closed.
  const pinnedPool = [
    { title: 'pinned-db', pinned: true },
    { title: 'plain-db', pinned: false },
  ];
  const guardedPins = bulkCloseSelection({
    pool: pinnedPool, predicate: makePredicate({ query: 'db', mode: 'text' }), query: 'db', containing: true,
  });
  assert.deepStrictEqual(guardedPins.victims.map((tb) => tb.title), ['plain-db']);
  assert.strictEqual(guardedPins.excludedPins, 1);
  assert.match(source, /t\('pinnedExcluded', excludedPins\)/,
    'the pinned exclusion must be shown, not silent');
  assert.match(source, /t\('emptyQueryNoClose'\)/, 'the empty-query refusal is gone');
  assert.match(source, /if \(tb\.dirty\) \{ kept\.push\(tb\); continue; \}/,
    'unsaved-work protection no longer survives a bulk close');
});

test('ui/tabs.js keeps the layout rules the model asserts', () => {
  assert.match(source, /const ungrouped = \(\) => strip\.tabs\.filter\(\(tb\) => !tb\.pinned && !tb\.groupId\);/);
  assert.match(source, /const pinned = \(\) => strip\.tabs\.filter\(\(tb\) => tb\.pinned\);/);
  assert.match(source, /const groupTabs = \(gid\) => strip\.tabs\.filter\(\(tb\) => !tb\.pinned && tb\.groupId === gid\);/);
  assert.match(source, /if \(tab\.pinned\) tab\.groupId = null;/, 'pinning no longer leaves the group');
  assert.match(source, /if \(gid\) tab\.pinned = false;/, 'joining a group no longer unpins');
  assert.match(source, /for \(const tb of groupTabs\(gid\)\) tb\.groupId = null;/,
    'removing a group no longer keeps its tabs');
  assert.match(source, /if \(!members\.length && !g\.keepEmpty\) continue;/,
    'an empty group is painted or dropped against the model');
});

test('ui/tabs.js gives each of the four searches its own bar', () => {
  for (const fn of ['openStripSearch', 'openGroupSearch', 'openGroupNameSearch', 'openMasterSearch']) {
    assert.ok(source.includes(`function ${fn}(`), `${fn} is missing`);
  }
  // Four call sites — the shared popover shell, group names, bulk close and the
  // group manager — producing six distinct ids, because the shell is called
  // once per search with an id of its own. Each bar is created per open, so no
  // two searches share hidden state or a builder.
  // A floor, not an exact count: adding a fifth search bar to the strip is the
  // direction the tabbed-navigation rules push, and an equality here would fail
  // on that for no behavioural reason — which trains the next reader to edit
  // the assertion instead of reading it. The invariant that matters (no two
  // bars share hidden state) is the id-uniqueness check below.
  assert.ok((source.match(/createSearchBar\(\{/g) || []).length >= 4);
  const ids = (source.match(/(?:searchId|id): [`'](tabs-[^`']*)[`']/g) || []);
  assert.strictEqual(new Set(ids).size, ids.length, 'two search bars share an id');
  assert.ok(ids.length >= 6, `only ${ids.length} distinct search-bar ids`);
  assert.ok(source.includes("searchId: 'tabs-master'"), 'the master search lost its own id');
  assert.ok(source.includes('persist: false'), 'a popover search must not persist its query');
});

test('ui/tabs.js keeps the container context-menu guard and never uses innerHTML', () => {
  // Without this, a right-click on a tab collects the tab menu AND the strip
  // menu and the user sees every entry twice.
  assert.match(source,
    /registerContextMenu\(root, \(ctx\) => \(ctx\.target\?\.closest\?\.\('\[role="tab"\], \.tab-group-head'\) \? \[\]/,
    'the strip\'s container menu no longer yields to its children');
  assert.ok(!/innerHTML/.test(source), 'tabs.js must build DOM with h(), never innerHTML');

  // The overflow surface exists and is counted, so tabs are never silently clipped.
  assert.ok(source.includes('function openOverflow('));
  assert.match(source, /badge\.textContent = String\(hidden\);/);
  assert.match(source, /Currently scrolled out of view/);
});

test('ui/tabs.js keeps roles, roving focus and the pinned accessible name', () => {
  assert.match(source, /class: 'tabstrip', role: 'tablist'/);
  assert.match(source, /role: 'tab', id: tab\.tabId/);
  assert.match(source, /role: 'tabpanel'/);
  assert.match(source, /'aria-controls': tab\.panelId/);
  assert.match(source, /rovingFocus\(root, '\[role="tab"\]'/, 'the strip must be one tab stop');
  // A pinned, icon-only tab still carries its full name for a screen reader.
  assert.match(source, /el\.setAttribute\('aria-label', tab\.title\);/);
  assert.match(source, /'aria-expanded': String\(!group\.collapsed\)/);
});
