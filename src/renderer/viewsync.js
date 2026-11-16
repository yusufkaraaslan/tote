// One controller per device. Snapshots and saves share a queue; local edits
// remain drafts until acknowledged. A conflict never retries as an overwrite.
(function (root) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  function create({ read, write, onChange = () => {}, onStatus = () => {}, protect = () => false, delay = 200 }) {
    let remote = { views: {}, revisions: {} }, current = {}, supported = null;
    let timer, running = null, wantRead = false, wantSave = false, error = null, stopped = false;
    const drafts = new Map();
    const status = () => ({ supported, pending: drafts.size, error, busy: !!running,
      conflicts: [...drafts].filter(([, d]) => d.conflict).map(([id]) => id) });
    const notify = () => { if (!stopped) onStatus(status()); };
    const put = (map, id, value) => { if (value === null) delete map[id]; else map[id] = clone(value); };
    function receive(snapshot) {
      if (stopped) return;
      if (!snapshot || ![0, 1].includes(snapshot.protocol)) throw new Error('Invalid layout snapshot');
      supported = snapshot.protocol === 1;
      const incoming = snapshot.views || {}, revisions = snapshot.revisions || {};
      const next = clone(incoming);
      for (const id of Object.keys(current)) {
        if (!drafts.has(id) && !equal(current[id], incoming[id]) && protect(id, incoming[id])) {
          drafts.set(id, { value: clone(current[id]), revision: remote.revisions[id] ?? null, conflict: true });
        }
      }
      for (const [id, draft] of drafts) {
        if (equal(draft.value, incoming[id])) { drafts.delete(id); continue; }
        if ((revisions[id] ?? null) !== draft.revision) draft.conflict = true;
        put(next, id, draft.value);
      }
      remote = { views: clone(incoming), revisions: { ...revisions } };
      const changed = !equal(current, next);
      current = next;
      if (changed) onChange(clone(current));
      notify();
    }
    function pump() {
      if (running) return running;
      running = Promise.resolve().then(async () => {
        while (!stopped && (wantRead || wantSave)) {
          if (wantRead) {
            wantRead = false;
            receive(await read());
            error = null;
          } else {
            wantSave = false;
            if (!supported) continue;
            const changes = [...drafts].filter(([, d]) => !d.conflict)
              .map(([wsId, d]) => ({ wsId, revision: d.revision, value: clone(d.value) }));
            if (!changes.length) continue;
            const result = await write({ changes });
            if (result.ok) {
              for (const sent of changes) {
                const draft = drafts.get(sent.wsId);
                if (!draft) continue;
                if (equal(draft.value, sent.value)) drafts.delete(sent.wsId);
                else { draft.revision = result.snapshot.revisions[sent.wsId] ?? null; draft.conflict = false; }
              }
            } else {
              for (const id of result.conflicts || []) if (drafts.has(id)) drafts.get(id).conflict = true;
              // A conflict in one workspace does not strand edits to others.
              wantSave = [...drafts.values()].some(d => !d.conflict);
            }
            receive(result.snapshot);
            error = null;
          }
        }
      }).catch(e => { error = e.message; wantRead = wantSave = false; }).finally(() => {
        running = null;
        notify();
      });
      notify();
      return running;
    }
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => { wantSave = true; pump(); }, delay);
    }
    return {
      status,
      views: () => clone(current),
      edit(views) {
        const next = clone(views);
        for (const id of new Set([...Object.keys(current), ...Object.keys(next)])) {
          if (equal(current[id], next[id])) continue;
          const previous = drafts.get(id);
          drafts.set(id, { value: next[id] ?? null, revision: previous?.revision ?? remote.revisions[id] ?? null,
            conflict: previous?.conflict || false });
        }
        current = next;
        notify();
        schedule();
      },
      refresh() { wantRead = wantSave = true; return pump(); },
      flush() { clearTimeout(timer); wantSave = true; return pump(); },
      resolve(id, choice) {
        if (running || !drafts.has(id)) return false;
        if (choice === 'saved') {
          if (protect(id, remote.views[id])) return false;
          drafts.delete(id);
          receive({ protocol: supported ? 1 : 0, ...remote });
        } else if (choice === 'local') {
          const draft = drafts.get(id);
          draft.revision = remote.revisions[id] ?? null;
          draft.conflict = false;
          schedule();
        } else return false;
        notify();
        return true;
      },
      dispose() { stopped = true; clearTimeout(timer); },
    };
  }
  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ViewSync = api;
})(typeof window !== 'undefined' ? window : globalThis);
