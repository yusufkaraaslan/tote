/* Pure tiling layout: a binary tree of panes, and the geometry it implies.
 *
 * No DOM, no Electron -- everything here is data in, data out, so it can be
 * tested with `node scripts/test-layout.js`. The renderer applies the rects
 * this module produces; it never asks the DOM where anything is.
 *
 * Loaded as a plain <script> in the renderer (exposes window.TileTree) and as
 * a CommonJS module by the test script. CSP is script-src 'self', so no
 * bundler and no module syntax.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TileTree = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // A leaf is a pane: one web view, terminal or files tree.
  function leaf(id, kind, ref) {
    const node = { type: 'leaf', id: id, kind: kind };
    if (ref !== undefined) node.ref = ref;
    return node;
  }

  // A split holds exactly two children. 'row' divides left/right, 'col' divides
  // top/bottom. `ratio` is a's share of the axis, 0..1.
  function split(dir, ratio, a, b) {
    return { type: 'split', dir: dir, ratio: ratio, a: a, b: b };
  }

  // Divide a rect in two along a split, leaving `gutter` px between the halves.
  // The gutter comes out of the middle, so the pair still spans the full rect.
  function halves(node, r, gutter) {
    if (node.dir === 'row') {
      const aw = Math.round(r.w * node.ratio - gutter / 2);
      return [{ x: r.x, y: r.y, w: aw, h: r.h },
              { x: r.x + aw + gutter, y: r.y, w: r.w - aw - gutter, h: r.h }];
    }
    const ah = Math.round(r.h * node.ratio - gutter / 2);
    return [{ x: r.x, y: r.y, w: r.w, h: ah },
            { x: r.x, y: r.y + ah + gutter, w: r.w, h: r.h - ah - gutter }];
  }

  // Walk the tree, dividing each split's rect by its ratio, and collect the
  // rect every leaf ends up with.
  function rectsFor(tree, rect, opts) {
    const gutter = (opts && opts.gutter) || 0;
    const out = new Map();
    (function walk(node, r) {
      if (!node) return;
      if (node.type === 'leaf') { out.set(node.id, r); return; }
      const [ra, rb] = halves(node, r, gutter);
      walk(node.a, ra);
      walk(node.b, rb);
    })(tree, rect);
    return out;
  }

  /* ----- reading the tree ----- */

  function leaves(tree) {
    const out = [];
    (function walk(n) {
      if (!n) return;
      if (n.type === 'leaf') { out.push(n); return; }
      walk(n.a); walk(n.b);
    })(tree);
    return out;
  }

  function findLeaf(tree, id) {
    const hit = leaves(tree).filter(function (l) { return l.id === id; });
    return hit.length ? hit[0] : null;
  }

  /* ----- editing the tree -----
   * Every edit returns a NEW tree; nothing is mutated in place. The renderer
   * holds one tree per space and swaps it wholesale, so an edit can never
   * leave a half-applied layout behind. */

  // Auto-placement splits along the pane's longer axis, keeping tiles squarish.
  // Dock a node against a container edge: the whole existing tree becomes its
  // sibling, so the docked pane spans the full side no matter how the rest is
  // split. `ratio` is always the DOCKED node's share of the axis.
  function insertRoot(tree, node, edge, ratio) {
    if (!tree) return node;
    const dir = edge === 'top' || edge === 'bottom' ? 'col' : 'row';
    const first = edge === 'left' || edge === 'top';
    return first ? split(dir, ratio, node, tree) : split(dir, 1 - ratio, tree, node);
  }

  function dirFor(rect) {
    return rect.w >= rect.h ? 'row' : 'col';
  }

  // Opening a pane: the target leaf becomes a split holding the target and the
  // newcomer. The newcomer takes the b slot (dwindle).
  function splitLeaf(tree, targetId, newLeaf, dir) {
    if (!tree) return newLeaf;
    return (function walk(n) {
      if (n.type === 'leaf') {
        return n.id === targetId ? split(dir, 0.5, n, newLeaf) : n;
      }
      return split(n.dir, n.ratio, walk(n.a), walk(n.b));
    })(tree);
  }

  // Closing a pane: the leaf's sibling takes the parent split's place.
  function removeLeaf(tree, id) {
    if (!tree) return null;
    if (tree.type === 'leaf') return tree.id === id ? null : tree;
    return (function walk(n) {
      if (n.type === 'leaf') return n;
      if (n.a.type === 'leaf' && n.a.id === id) return walk(n.b);
      if (n.b.type === 'leaf' && n.b.id === id) return walk(n.a);
      return split(n.dir, n.ratio, walk(n.a), walk(n.b));
    })(tree);
  }

  /* ----- resizing ----- */

  // One divider per split, addressed by the path of 'a'/'b' steps that reaches
  // it. Paths are only used within a single drag, during which the tree shape
  // does not change.
  function dividersFor(tree, rect, opts) {
    const gutter = (opts && opts.gutter) || 0;
    const out = [];
    (function walk(n, r, path) {
      if (!n || n.type === 'leaf') return;
      const [ra, rb] = halves(n, r, gutter);
      out.push({
        path: path,
        dir: n.dir,
        host: r,        // the rect this split divides; converts a drag px to a ratio
        rect: n.dir === 'row'
          ? { x: ra.x + ra.w, y: r.y, w: gutter, h: r.h }
          : { x: r.x, y: ra.y + ra.h, w: r.w, h: gutter },
      });
      walk(n.a, ra, path.concat('a'));
      walk(n.b, rb, path.concat('b'));
    })(tree, rect, []);
    return out;
  }

  function setRatio(tree, path, ratio) {
    return (function walk(n, i) {
      if (!n || n.type === 'leaf') return n;
      if (i === path.length) return split(n.dir, ratio, n.a, n.b);
      const step = path[i];
      return split(n.dir, n.ratio,
        step === 'a' ? walk(n.a, i + 1) : n.a,
        step === 'b' ? walk(n.b, i + 1) : n.b);
    })(tree, 0);
  }

  // Keep both halves at least minPx along the split axis. If the container is
  // too small to honour that, split it evenly rather than pinning to an edge.
  function clampRatio(rect, dir, ratio, minPx) {
    const span = dir === 'row' ? rect.w : rect.h;
    if (span < minPx * 2) return 0.5;
    const lo = minPx / span, hi = 1 - minPx / span;
    return Math.min(hi, Math.max(lo, ratio));
  }

  /* ----- rearranging -----
   * Both operations are pure tree edits. No DOM node is ever moved, which is
   * what keeps webviews from reloading -- see the flat-container invariant. */

  // Centre drop: the two panes trade places. Whole nodes move, so a leaf id
  // keeps travelling with its own content and `focus` stays on the pane the
  // user dragged.
  function swapLeaves(tree, idA, idB) {
    if (idA === idB) return tree;
    const a = findLeaf(tree, idA), b = findLeaf(tree, idB);
    if (!a || !b) return tree;
    return (function walk(n) {
      if (n.type === 'leaf') return n.id === idA ? b : n.id === idB ? a : n;
      return split(n.dir, n.ratio, walk(n.a), walk(n.b));
    })(tree);
  }

  const EDGE_DIR = { left: 'row', right: 'row', top: 'col', bottom: 'col' };
  const EDGE_FIRST = { left: true, right: false, top: true, bottom: false };

  // Edge drop: pull the pane out of where it was, then split the target and
  // drop it in on the named side.
  function moveLeaf(tree, dragId, targetId, edge) {
    if (dragId === targetId) return tree;
    const dragged = findLeaf(tree, dragId);
    if (!dragged || !findLeaf(tree, targetId)) return tree;
    const pruned = removeLeaf(tree, dragId);
    if (!pruned) return tree;
    const dir = EDGE_DIR[edge], first = EDGE_FIRST[edge];
    return (function walk(n) {
      if (n.type === 'leaf') {
        if (n.id !== targetId) return n;
        return first ? split(dir, 0.5, dragged, n) : split(dir, 0.5, n, dragged);
      }
      return split(n.dir, n.ratio, walk(n.a), walk(n.b));
    })(pruned);
  }

  /* ----- directional focus -----
   * Geometric rather than tree-based: "the pane to my left" should mean the one
   * that looks left of here, not the one that happens to be the tree sibling. */

  const AXIS = {
    left:  { along: 'x', sign: -1, cross: 'y', crossSize: 'h', size: 'w' },
    right: { along: 'x', sign:  1, cross: 'y', crossSize: 'h', size: 'w' },
    up:    { along: 'y', sign: -1, cross: 'x', crossSize: 'w', size: 'h' },
    down:  { along: 'y', sign:  1, cross: 'x', crossSize: 'w', size: 'h' },
  };

  function centre(r) { return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }

  function neighbour(rects, fromId, dir) {
    const from = rects.get(fromId);
    const ax = AXIS[dir];
    if (!from || !ax) return null;
    const c0 = centre(from);
    let best = null, bestScore = Infinity;
    rects.forEach(function (r, id) {
      if (id === fromId) return;
      const c = centre(r);
      const along = (c[ax.along] - c0[ax.along]) * ax.sign;
      if (along <= 0) return;                       // not in that direction
      // Prefer panes whose band overlaps ours: the perpendicular gap is a
      // penalty, so a pane straight ahead beats a nearer one off to the side.
      const gap = Math.abs(c[ax.cross] - c0[ax.cross]);
      const score = along + gap * 2;
      if (score < bestScore) { bestScore = score; best = id; }
    });
    return best;
  }

  /* ----- migrating the old dock layout -----
   * Existing spaces store {files:{dock,visible}, terminal:{dock,visible}, sizes}.
   * Turn that into the equivalent tree so nobody opens the app to a rearranged
   * space. Every open tab becomes a pane -- there are no hidden tabs any more,
   * so placing only the active one would silently strand the rest. */

  function migrate(entry, mkId, view) {
    const L = (entry && entry.layout) || {};
    const sizes = L.sizes || {};
    const tabs = (entry && entry.tabs) || [];

    // the web panes, dwindled into one block
    let tree = null, focus = null;
    tabs.forEach(function (t) {
      const node = leaf(mkId(), 'web', t.id);
      if (t.id === (entry && entry.active)) focus = node.id;
      if (!tree) { tree = node; return; }
      const target = leaves(tree)[leaves(tree).length - 1];
      tree = splitLeaf(tree, target.id, node, leaves(tree).length % 2 ? 'row' : 'col');
    });
    if (!focus && tree) focus = leaves(tree)[0].id;

    const attach = function (node, dir, first, ratio) {
      if (!tree) { tree = node; return; }
      tree = first ? split(dir, ratio, node, tree) : split(dir, 1 - ratio, tree, node);
    };

    if (L.terminal && L.terminal.visible) {
      const dir = L.terminal.dock === 'bottom' ? 'col' : 'row';
      const size = L.terminal.dock === 'bottom' ? (sizes.bottom || 280) / view.h
                 : (sizes[L.terminal.dock] || 400) / view.w;
      attach(leaf(mkId(), 'term'), dir, L.terminal.dock === 'left', size);
    }
    if (L.files && L.files.visible) {
      const dir = L.files.dock === 'bottom' ? 'col' : 'row';
      const size = L.files.dock === 'bottom' ? (sizes.bottom || 280) / view.h
                 : (sizes[L.files.dock] || 270) / view.w;
      attach(leaf(mkId(), 'files'), dir, L.files.dock !== 'right', size);
    }
    if (!focus && tree) focus = leaves(tree)[0].id;
    return { tree: tree, focus: focus };
  }

  return {
    leaf: leaf, split: split, rectsFor: rectsFor,
    leaves: leaves, findLeaf: findLeaf,
    dirFor: dirFor, splitLeaf: splitLeaf, insertRoot: insertRoot, removeLeaf: removeLeaf,
    dividersFor: dividersFor, setRatio: setRatio, clampRatio: clampRatio,
    swapLeaves: swapLeaves, moveLeaf: moveLeaf,
    neighbour: neighbour, migrate: migrate,
  };
});
