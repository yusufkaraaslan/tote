#!/usr/bin/env node
// Dependency-free tests for the pure tiling layout module.
// Run: node scripts/test-layout.js   (exits non-zero on failure)
const assert = require('assert');
const T = require('../src/renderer/layout.js');

let pass = 0, fail = 0, group = '';
const describe = (name, fn) => { group = name; console.log('\n' + name); fn(); };
const test = (name, fn) => {
  try { fn(); pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); }
};
const R = (x, y, w, h) => ({ x, y, w, h });

describe('rectsFor: a single leaf', () => {
  test('fills the whole container', () => {
    const tree = T.leaf('L1', 'files');
    const rects = T.rectsFor(tree, R(0, 0, 1000, 600));
    assert.deepStrictEqual(rects.get('L1'), R(0, 0, 1000, 600));
  });
});

describe('rectsFor: splits', () => {
  test('a row split divides left/right by ratio', () => {
    const tree = T.split('row', 0.3, T.leaf('A', 'files'), T.leaf('B', 'web'));
    const r = T.rectsFor(tree, R(0, 0, 1000, 600));
    assert.deepStrictEqual(r.get('A'), R(0, 0, 300, 600));
    assert.deepStrictEqual(r.get('B'), R(300, 0, 700, 600));
  });

  test('a col split divides top/bottom by ratio', () => {
    const tree = T.split('col', 0.25, T.leaf('A', 'web'), T.leaf('B', 'term'));
    const r = T.rectsFor(tree, R(0, 0, 800, 400));
    assert.deepStrictEqual(r.get('A'), R(0, 0, 800, 100));
    assert.deepStrictEqual(r.get('B'), R(0, 100, 800, 300));
  });

  test('the gutter is taken between siblings, never at the container edge', () => {
    const tree = T.split('row', 0.5, T.leaf('A', 'web'), T.leaf('B', 'web'));
    const r = T.rectsFor(tree, R(0, 0, 1000, 600), { gutter: 10 });
    // 10px of gutter between them; the pair still spans the full width
    assert.deepStrictEqual(r.get('A'), R(0, 0, 495, 600));
    assert.deepStrictEqual(r.get('B'), R(505, 0, 495, 600));
  });

  test('nested splits compose', () => {
    const tree = T.split('row', 0.2,
      T.leaf('files', 'files'),
      T.split('col', 0.5, T.leaf('web', 'web'), T.leaf('term', 'term')));
    const r = T.rectsFor(tree, R(0, 0, 1000, 600));
    assert.deepStrictEqual(r.get('files'), R(0, 0, 200, 600));
    assert.deepStrictEqual(r.get('web'), R(200, 0, 800, 300));
    assert.deepStrictEqual(r.get('term'), R(200, 300, 800, 300));
  });

  test('a rect offset from the origin is respected', () => {
    const tree = T.split('row', 0.5, T.leaf('A', 'web'), T.leaf('B', 'web'));
    const r = T.rectsFor(tree, R(40, 25, 200, 100));
    assert.deepStrictEqual(r.get('A'), R(40, 25, 100, 100));
    assert.deepStrictEqual(r.get('B'), R(140, 25, 100, 100));
  });

  test('an empty tree produces no rects', () => {
    assert.strictEqual(T.rectsFor(null, R(0, 0, 100, 100)).size, 0);
  });
});

describe('dirFor: auto-placement picks the longer axis', () => {
  test('a wide pane splits left/right', () => {
    assert.strictEqual(T.dirFor(R(0, 0, 800, 400)), 'row');
  });
  test('a tall pane splits top/bottom', () => {
    assert.strictEqual(T.dirFor(R(0, 0, 400, 800)), 'col');
  });
  test('a square pane splits left/right', () => {
    assert.strictEqual(T.dirFor(R(0, 0, 500, 500)), 'row');
  });
});

describe('splitLeaf: opening a pane', () => {
  test('replaces the target with a split holding it and the newcomer', () => {
    const tree = T.leaf('A', 'web');
    const out = T.splitLeaf(tree, 'A', T.leaf('B', 'term'), 'row');
    assert.strictEqual(out.type, 'split');
    assert.strictEqual(out.dir, 'row');
    assert.strictEqual(out.ratio, 0.5);
    assert.strictEqual(out.a.id, 'A');
    assert.strictEqual(out.b.id, 'B');
  });

  test('splits a nested target and leaves its siblings alone', () => {
    const tree = T.split('row', 0.2, T.leaf('files', 'files'), T.leaf('web', 'web'));
    const out = T.splitLeaf(tree, 'web', T.leaf('term', 'term'), 'col');
    assert.strictEqual(out.a.id, 'files');
    assert.strictEqual(out.ratio, 0.2);
    assert.strictEqual(out.b.type, 'split');
    assert.strictEqual(out.b.a.id, 'web');
    assert.strictEqual(out.b.b.id, 'term');
  });

  test('into an empty tree, the newcomer becomes the whole tree', () => {
    const out = T.splitLeaf(null, null, T.leaf('A', 'web'), 'row');
    assert.deepStrictEqual(out, T.leaf('A', 'web'));
  });

  test('does not mutate the original tree', () => {
    const tree = T.leaf('A', 'web');
    T.splitLeaf(tree, 'A', T.leaf('B', 'web'), 'row');
    assert.strictEqual(tree.type, 'leaf');
  });
});

describe('removeLeaf: closing a pane', () => {
  test('lifts the sibling into the parent\'s place', () => {
    const tree = T.split('row', 0.3, T.leaf('A', 'web'), T.leaf('B', 'term'));
    const out = T.removeLeaf(tree, 'A');
    assert.deepStrictEqual(out, T.leaf('B', 'term'));
  });

  test('removing the only pane leaves an empty tree', () => {
    assert.strictEqual(T.removeLeaf(T.leaf('A', 'web'), 'A'), null);
  });

  test('a nested removal keeps the rest of the tree intact', () => {
    const tree = T.split('row', 0.2,
      T.leaf('files', 'files'),
      T.split('col', 0.5, T.leaf('web', 'web'), T.leaf('term', 'term')));
    const out = T.removeLeaf(tree, 'term');
    assert.strictEqual(out.a.id, 'files');
    assert.strictEqual(out.ratio, 0.2);
    assert.strictEqual(out.b.id, 'web');   // the col split collapsed away
  });

  test('removing an id that is not present returns the tree unchanged', () => {
    const tree = T.split('row', 0.5, T.leaf('A', 'web'), T.leaf('B', 'web'));
    assert.deepStrictEqual(T.removeLeaf(tree, 'nope'), tree);
  });
});

describe('leaves / findLeaf', () => {
  test('leaves lists every pane in layout order', () => {
    const tree = T.split('row', 0.2,
      T.leaf('files', 'files'),
      T.split('col', 0.5, T.leaf('web', 'web'), T.leaf('term', 'term')));
    assert.deepStrictEqual(T.leaves(tree).map((l) => l.id), ['files', 'web', 'term']);
  });
  test('findLeaf returns the node, or null when absent', () => {
    const tree = T.split('row', 0.5, T.leaf('A', 'web', 'tab-7'), T.leaf('B', 'term', 4));
    assert.strictEqual(T.findLeaf(tree, 'A').ref, 'tab-7');
    assert.strictEqual(T.findLeaf(tree, 'zz'), null);
  });
  test('leaves of an empty tree is empty', () => {
    assert.deepStrictEqual(T.leaves(null), []);
  });
});

describe('dividersFor: the draggable strips between panes', () => {
  test('one divider per split, sitting in the gutter', () => {
    const tree = T.split('row', 0.5, T.leaf('A', 'web'), T.leaf('B', 'web'));
    const d = T.dividersFor(tree, R(0, 0, 1000, 600), { gutter: 6 });
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].dir, 'row');
    assert.deepStrictEqual(d[0].rect, R(497, 0, 6, 600));
    assert.deepStrictEqual(d[0].path, []);
  });

  test('nested splits get addressable paths', () => {
    const tree = T.split('row', 0.2,
      T.leaf('files', 'files'),
      T.split('col', 0.5, T.leaf('web', 'web'), T.leaf('term', 'term')));
    const d = T.dividersFor(tree, R(0, 0, 1000, 600), { gutter: 0 });
    assert.strictEqual(d.length, 2);
    assert.deepStrictEqual(d.map((x) => x.path), [[], ['b']]);
    assert.strictEqual(d[1].dir, 'col');
    assert.deepStrictEqual(d[1].rect, R(200, 300, 800, 0));
  });

  test('a lone leaf has no dividers', () => {
    assert.deepStrictEqual(T.dividersFor(T.leaf('A', 'web'), R(0, 0, 100, 100)), []);
  });
});

describe('setRatio: dragging a divider', () => {
  test('updates only the addressed split', () => {
    const tree = T.split('row', 0.2,
      T.leaf('files', 'files'),
      T.split('col', 0.5, T.leaf('web', 'web'), T.leaf('term', 'term')));
    const out = T.setRatio(tree, ['b'], 0.8);
    assert.strictEqual(out.ratio, 0.2);      // outer untouched
    assert.strictEqual(out.b.ratio, 0.8);    // inner moved
  });

  test('the root split is addressed by an empty path', () => {
    const tree = T.split('row', 0.5, T.leaf('A', 'web'), T.leaf('B', 'web'));
    assert.strictEqual(T.setRatio(tree, [], 0.75).ratio, 0.75);
  });

  test('does not mutate the original tree', () => {
    const tree = T.split('row', 0.5, T.leaf('A', 'web'), T.leaf('B', 'web'));
    T.setRatio(tree, [], 0.9);
    assert.strictEqual(tree.ratio, 0.5);
  });
});

describe('clampRatio: panes never collapse to nothing', () => {
  test('keeps the first pane at least minPx wide', () => {
    assert.strictEqual(T.clampRatio(R(0, 0, 1000, 600), 'row', 0.01, 150), 0.15);
  });
  test('keeps the second pane at least minPx wide', () => {
    assert.strictEqual(T.clampRatio(R(0, 0, 1000, 600), 'row', 0.99, 150), 0.85);
  });
  test('a comfortable ratio is left alone', () => {
    assert.strictEqual(T.clampRatio(R(0, 0, 1000, 600), 'row', 0.4, 150), 0.4);
  });
  test('clamps against height for a col split', () => {
    assert.strictEqual(T.clampRatio(R(0, 0, 1000, 400), 'col', 0.02, 100), 0.25);
  });
  test('when the container cannot fit two minimums, it settles at half', () => {
    assert.strictEqual(T.clampRatio(R(0, 0, 200, 600), 'row', 0.1, 150), 0.5);
  });
});

describe('swapLeaves: dropping a pane on the centre of another', () => {
  test('exchanges the two panes positions', () => {
    const tree = T.split('row', 0.2, T.leaf('files', 'files'), T.leaf('web', 'web'));
    const out = T.swapLeaves(tree, 'files', 'web');
    assert.strictEqual(out.a.id, 'web');
    assert.strictEqual(out.b.id, 'files');
    assert.strictEqual(out.ratio, 0.2);  // the geometry stays; the contents move
  });

  test('works across different depths', () => {
    const tree = T.split('row', 0.2,
      T.leaf('files', 'files'),
      T.split('col', 0.5, T.leaf('web', 'web'), T.leaf('term', 'term')));
    const out = T.swapLeaves(tree, 'files', 'term');
    assert.strictEqual(out.a.id, 'term');
    assert.strictEqual(out.b.b.id, 'files');
  });

  test('a pane keeps its ref when it moves', () => {
    const tree = T.split('row', 0.5, T.leaf('A', 'web', 'tab-7'), T.leaf('B', 'term', 4));
    const out = T.swapLeaves(tree, 'A', 'B');
    assert.strictEqual(out.a.ref, 4);
    assert.strictEqual(out.b.ref, 'tab-7');
  });

  test('swapping a pane with itself changes nothing', () => {
    const tree = T.split('row', 0.5, T.leaf('A', 'web'), T.leaf('B', 'web'));
    assert.deepStrictEqual(T.swapLeaves(tree, 'A', 'A'), tree);
  });

  test('an unknown id leaves the tree alone', () => {
    const tree = T.split('row', 0.5, T.leaf('A', 'web'), T.leaf('B', 'web'));
    assert.deepStrictEqual(T.swapLeaves(tree, 'A', 'nope'), tree);
  });
});

describe('moveLeaf: dropping a pane on the edge of another', () => {
  test('dropping on the right puts the pane after the target', () => {
    const tree = T.split('row', 0.2, T.leaf('files', 'files'), T.leaf('web', 'web'));
    const out = T.moveLeaf(tree, 'files', 'web', 'right');
    // files left its old slot, so the outer split collapsed to just the new one
    assert.strictEqual(out.dir, 'row');
    assert.strictEqual(out.a.id, 'web');
    assert.strictEqual(out.b.id, 'files');
  });

  test('dropping on the left puts the pane before the target', () => {
    const tree = T.split('col', 0.5, T.leaf('A', 'web'), T.leaf('B', 'term'));
    const out = T.moveLeaf(tree, 'A', 'B', 'left');
    assert.strictEqual(out.dir, 'row');
    assert.strictEqual(out.a.id, 'A');
    assert.strictEqual(out.b.id, 'B');
  });

  test('dropping on the bottom stacks it under the target', () => {
    const tree = T.split('row', 0.5, T.leaf('A', 'web'), T.leaf('B', 'term'));
    const out = T.moveLeaf(tree, 'A', 'B', 'bottom');
    assert.strictEqual(out.dir, 'col');
    assert.strictEqual(out.a.id, 'B');
    assert.strictEqual(out.b.id, 'A');
  });

  test('the rest of the tree survives the move', () => {
    const tree = T.split('row', 0.2,
      T.leaf('files', 'files'),
      T.split('col', 0.5, T.leaf('web', 'web'), T.leaf('term', 'term')));
    const out = T.moveLeaf(tree, 'term', 'files', 'top');
    assert.strictEqual(out.a.dir, 'col');
    assert.strictEqual(out.a.a.id, 'term');
    assert.strictEqual(out.a.b.id, 'files');
    assert.strictEqual(out.b.id, 'web');   // the inner split collapsed
    assert.strictEqual(out.ratio, 0.2);
  });

  test('dropping a pane onto itself changes nothing', () => {
    const tree = T.split('row', 0.5, T.leaf('A', 'web'), T.leaf('B', 'web'));
    assert.deepStrictEqual(T.moveLeaf(tree, 'A', 'A', 'left'), tree);
  });
});

describe('neighbour: directional focus follows what you see', () => {
  // three columns side by side
  const cols = new Map([
    ['A', R(0, 0, 300, 600)],
    ['B', R(300, 0, 300, 600)],
    ['C', R(600, 0, 300, 600)],
  ]);

  test('right of the leftmost pane is the middle one', () => {
    assert.strictEqual(T.neighbour(cols, 'A', 'right'), 'B');
  });
  test('left of the rightmost pane is the middle one', () => {
    assert.strictEqual(T.neighbour(cols, 'C', 'left'), 'B');
  });
  test('there is nothing left of the leftmost pane', () => {
    assert.strictEqual(T.neighbour(cols, 'A', 'left'), null);
  });
  test('an unknown pane has no neighbour', () => {
    assert.strictEqual(T.neighbour(cols, 'zz', 'left'), null);
  });

  test('picks the pane that actually lines up, not merely the nearest', () => {
    // files on the left; two stacked panes on the right
    const rects = new Map([
      ['files', R(0, 0, 200, 600)],
      ['top',   R(200, 0, 800, 300)],
      ['bottom', R(200, 300, 800, 300)],
    ]);
    // from the bottom-right pane, going left must land on files
    assert.strictEqual(T.neighbour(rects, 'bottom', 'left'), 'files');
    // from files, going right prefers the pane overlapping its own band
    assert.strictEqual(T.neighbour(rects, 'top', 'down'), 'bottom');
    assert.strictEqual(T.neighbour(rects, 'bottom', 'up'), 'top');
  });
});

describe('migrate: an existing space keeps its arrangement', () => {
  let n = 0;
  const mkId = () => 'L' + (++n);
  const view = { w: 1400, h: 800 };
  const reset = () => { n = 0; };

  test('files docked left becomes the left pane', () => {
    reset();
    const out = T.migrate({
      tabs: [{ id: 'tab-1', providerId: 'claude' }], active: 'tab-1',
      layout: { files: { dock: 'left', visible: true },
                terminal: { dock: 'bottom', visible: false },
                sizes: { left: 280, right: 520, bottom: 280 } },
    }, mkId, view);
    assert.strictEqual(out.tree.type, 'split');
    assert.strictEqual(out.tree.dir, 'row');
    assert.strictEqual(out.tree.a.kind, 'files');
    assert.strictEqual(out.tree.b.kind, 'web');
    assert.strictEqual(out.tree.b.ref, 'tab-1');
    assert.strictEqual(out.tree.ratio, 0.2);   // 280/1400
  });

  test('files docked right lands on the right', () => {
    reset();
    const out = T.migrate({
      tabs: [{ id: 'tab-1', providerId: 'claude' }], active: 'tab-1',
      layout: { files: { dock: 'right', visible: true },
                terminal: { dock: 'bottom', visible: false },
                sizes: { left: 280, right: 700, bottom: 280 } },
    }, mkId, view);
    assert.strictEqual(out.tree.a.kind, 'web');
    assert.strictEqual(out.tree.b.kind, 'files');
  });

  test('a visible terminal dock becomes a pane below', () => {
    reset();
    const out = T.migrate({
      tabs: [{ id: 'tab-1', providerId: 'claude' }], active: 'tab-1',
      layout: { files: { dock: 'left', visible: false },
                terminal: { dock: 'bottom', visible: true },
                sizes: { left: 280, right: 520, bottom: 200 } },
    }, mkId, view);
    assert.strictEqual(out.tree.dir, 'col');
    assert.strictEqual(out.tree.a.kind, 'web');
    assert.strictEqual(out.tree.b.kind, 'term');
    assert.strictEqual(out.tree.ratio, 0.75);  // 1 - 200/800
  });

  test('hidden panels contribute no pane', () => {
    reset();
    const out = T.migrate({
      tabs: [{ id: 'tab-1', providerId: 'claude' }], active: 'tab-1',
      layout: { files: { dock: 'left', visible: false },
                terminal: { dock: 'bottom', visible: false },
                sizes: { left: 280, right: 520, bottom: 280 } },
    }, mkId, view);
    assert.strictEqual(out.tree.type, 'leaf');
    assert.strictEqual(out.tree.kind, 'web');
  });

  test('every open tab becomes a pane, so nothing is silently dropped', () => {
    reset();
    const out = T.migrate({
      tabs: [{ id: 't1', providerId: 'claude' },
             { id: 't2', providerId: 'kimi' },
             { id: 't3', providerId: 'gpt' }],
      active: 't2',
      layout: { files: { dock: 'left', visible: false },
                terminal: { dock: 'bottom', visible: false }, sizes: {} },
    }, mkId, view);
    const refs = T.leaves(out.tree).map((l) => l.ref);
    assert.deepStrictEqual(refs.sort(), ['t1', 't2', 't3']);
  });

  test('focus lands on the tab that was active', () => {
    reset();
    const out = T.migrate({
      tabs: [{ id: 't1', providerId: 'claude' }, { id: 't2', providerId: 'kimi' }],
      active: 't2',
      layout: { files: { dock: 'left', visible: false },
                terminal: { dock: 'bottom', visible: false }, sizes: {} },
    }, mkId, view);
    assert.strictEqual(T.findLeaf(out.tree, out.focus).ref, 't2');
  });

  test('an empty space migrates to an empty tree', () => {
    reset();
    const out = T.migrate({
      tabs: [], active: null,
      layout: { files: { dock: 'left', visible: false },
                terminal: { dock: 'bottom', visible: false }, sizes: {} },
    }, mkId, view);
    assert.strictEqual(out.tree, null);
    assert.strictEqual(out.focus, null);
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
