// Content revisions survive reconnects and host restarts without a separate
// metadata file. The host is the sole writer; checking and committing are sync.
const { createHash } = require('crypto');
const { isDeepStrictEqual } = require('util');
const clone = value => JSON.parse(JSON.stringify(value));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const revision = value => value === undefined ? null : createHash('sha256').update(JSON.stringify(value)).digest('hex');

class Views {
  constructor(cfg, exists) { this.cfg = cfg; this.exists = exists; }

  snapshot() {
    const views = clone(this.cfg.getViews());
    return { protocol: 1, views, revisions: Object.fromEntries(Object.entries(views).map(([id, value]) => [id, revision(value)])) };
  }

  patch({ changes } = {}) {
    if (!Array.isArray(changes) || changes.length > 1000) throw new Error('Invalid layout changes');
    const snapshot = this.snapshot(), seen = new Set(), conflicts = [];
    for (const change of changes) {
      if (!record(change) || typeof change.wsId !== 'string' || !change.wsId ||
          ['__proto__', 'constructor', 'prototype'].includes(change.wsId) || seen.has(change.wsId) ||
          !(change.revision === null || typeof change.revision === 'string') ||
          !(change.value === null || record(change.value))) throw new Error('Invalid workspace layout change');
      seen.add(change.wsId);
      if ((snapshot.revisions[change.wsId] ?? null) !== change.revision ||
          (change.value !== null && !this.exists(change.wsId))) conflicts.push(change.wsId);
    }
    if (conflicts.length) return { ok: false, conflicts, snapshot };
    const next = clone(snapshot.views);
    for (const { wsId, value } of changes) {
      if (value === null) delete next[wsId];
      else next[wsId] = clone(value);
    }
    if (!isDeepStrictEqual(next, snapshot.views)) this.cfg.saveViews(next);
    return { ok: true, snapshot: this.snapshot() };
  }

  // Older desktops send a whole map. Diff against THEIR last read, then apply
  // the same revision check. Never grant an old client an unconditional write.
  legacy(viewer, data) {
    if (!record(data) || !viewer.viewsBaseline) throw new Error('Read layouts before saving; reopen this workspace to refresh');
    const base = viewer.viewsBaseline;
    const changes = [];
    for (const wsId of new Set([...Object.keys(base.views), ...Object.keys(data)])) {
      if (!isDeepStrictEqual(base.views[wsId], data[wsId])) changes.push({
        wsId, revision: base.revisions[wsId] ?? null, value: data[wsId] ?? null,
      });
    }
    const result = this.patch({ changes });
    if (!result.ok) throw new Error('Layout changed in another viewer; reopen this workspace before saving');
    // The old RPC returns only true: the caller has NOT seen unrelated
    // changes merged into the result. Keep its actual view as the baseline.
    const revisions = { ...base.revisions };
    for (const { wsId } of changes) revisions[wsId] = result.snapshot.revisions[wsId] ?? null;
    viewer.viewsBaseline = { views: clone(data), revisions };
    return result;
  }
}

module.exports = { Views };
