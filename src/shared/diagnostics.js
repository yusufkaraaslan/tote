// Shared by the host, desktop renderer and Android. Export an allowlist of
// typed operational fields, never arbitrary logs with regex substitutions.
(function (root) {
  const explanations = Object.freeze({
    unknown: 'Unclassified error; no raw message retained',
    unavailable: 'Required service or command is unavailable',
    permission: 'Access was denied', refused: 'Device authorization was refused',
    timeout: 'An operation timed out', heartbeat: 'Connection heartbeat timed out',
    overloaded: 'Viewer or transport queue limit reached', disconnected: 'Connection closed',
    incompatible: 'Peer protocol or version is incompatible', address_in_use: 'Sharing port is already in use',
    malformed: 'Received malformed data',
  });
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const number = (value, max = 1e9) => Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value) : null;
  const bool = value => typeof value === 'boolean' ? value : null;
  const choice = (value, values, fallback = 'unknown') => values.includes(value) ? value : fallback;
  const version = value => typeof value === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-(?:alpha|beta|rc|dev)(?:\.\d{1,6})?)?$/.test(value) ? value : null;
  const time = value => Number.isSafeInteger(value) && value >= 0 && value < 8640000000000000 ? value : null;
  const code = value => typeof value === 'string' && Object.hasOwn(explanations, value) ? value : 'unknown';
  function classify(error) {
    let text = '';
    try { text = (typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : error?.code || '').slice(0, 1024); } catch {}
    if (/EADDRINUSE|port.*in use/i.test(text)) return 'address_in_use';
    if (/heartbeat/i.test(text)) return 'heartbeat';
    if (/fell behind|consum.*output|output stalled|queue|buffer.*full|too many pending/i.test(text)) return 'overloaded';
    if (/refused|403|not one of your|authoriz/i.test(text)) return 'refused';
    if (/EACCES|EPERM|permission|denied/i.test(text)) return 'permission';
    if (/ENOENT|not installed|not found|unavailable|no such file/i.test(text)) return 'unavailable';
    if (/protocol|incompatible|update Tote/i.test(text)) return 'incompatible';
    if (/invalid response|malformed|not JSON|invalid.*sequence/i.test(text)) return 'malformed';
    if (/timed? ?out|timeout|no answer/i.test(text)) return 'timeout';
    if (/closed|disconnected|viewer left|stopped sharing/i.test(text)) return 'disconnected';
    return 'unknown';
  }
  function createLog() {
    const events = [];
    return {
      add(area, error) {
        events.push({ at: Date.now(), area: choice(area, ['connection', 'terminal', 'sharing', 'tailscale', 'diagnostics']), code: classify(error) });
        if (events.length > 50) events.shift();
      },
      snapshot: () => events.map(e => ({ ...e })),
    };
  }
  function network(value) {
    const v = object(value);
    return { state: choice(v.state, ['running', 'stopped', 'needs-login', 'unavailable']), reason: v.reason == null ? null : code(v.reason) };
  }
  function report(input) {
    const x = object(input), viewer = object(x.viewer), host = object(x.host), c = object(x.connection);
    const sharing = object(x.sharing), net = object(x.network), native = object(x.native);
    return {
      format: 'tote-diagnostics-v1', capturedAt: time(x.capturedAt) ?? Date.now(),
      viewer: { kind: choice(viewer.kind, ['desktop', 'android']), version: version(viewer.version),
        platform: choice(viewer.platform, ['linux', 'darwin', 'win32', 'android']), runtime: version(viewer.runtime) },
      host: { version: version(host.version), state: choice(host.state, ['current', 'cached', 'unavailable', 'unsupported']) },
      connection: { mode: choice(c.mode, ['local', 'remote', 'none'], 'none'),
        state: choice(c.state, ['local', 'connected', 'disconnected', 'connecting']),
        flow: bool(c.flow), pendingCalls: number(c.pendingCalls), queuedBytes: number(c.queuedBytes), pendingFrames: number(c.pendingFrames) },
      network: { viewer: network(net.viewer), host: network(net.host) },
      sharing: { enabled: bool(sharing.enabled), listening: bool(sharing.listening), reason: sharing.reason == null ? null : code(sharing.reason) },
      native: { tailscaleInstalled: bool(native.tailscaleInstalled), pendingBytes: number(native.pendingBytes), pendingFrames: number(native.pendingFrames), queuedBytes: number(native.queuedBytes) },
      terminals: (Array.isArray(x.terminals) ? x.terminals.slice(0, 64) : []).map((entry, index) => {
        const t = object(entry), h = object(t.host), local = object(t.local);
        return { label: 'Terminal ' + (index + 1), focused: bool(t.focused), alive: bool(t.alive),
          host: { cols: number(h.cols, 1000), rows: number(h.rows, 1000) },
          local: { cols: number(local.cols, 1000), rows: number(local.rows, 1000), width: number(local.width, 50000), height: number(local.height, 50000) },
          controller: choice(t.controller, ['this-viewer', 'another-viewer', 'unclaimed']) };
      }),
      events: (Array.isArray(x.events) ? x.events.slice(-50) : []).map(entry => {
        const e = object(entry), safe = code(e.code);
        return { at: time(e.at), area: choice(e.area, ['connection', 'terminal', 'sharing', 'tailscale', 'diagnostics']), code: safe, detail: explanations[safe] };
      }),
    };
  }
  function stringify(input) {
    const text = JSON.stringify(report(input), null, 2);
    if (new TextEncoder().encode(text).length > 65536) throw new Error('Diagnostic report exceeded its size limit');
    return text;
  }
  function summary(input) {
    const r = report(input);
    return [
      ['Viewer', `${r.viewer.kind} ${r.viewer.version || 'unknown version'}`],
      ['Host', `${r.host.version || 'unknown version'} (${r.host.state})`],
      ['Connection', r.connection.state], ['This device’s Tailscale', r.native.tailscaleInstalled === true ? 'installed' : r.native.tailscaleInstalled === false ? 'not installed' : r.network.viewer.state],
      ['Host’s Tailscale', r.network.host.state],
      ['Device sharing', r.sharing.reason ? explanations[r.sharing.reason] : r.sharing.listening === true ? 'listening' : r.sharing.enabled === false ? 'off' : 'unknown'],
      ['Recent errors', String(r.events.length)],
    ];
  }
  // Associate operational host rows with this viewer's viewport. IDs stay here;
  // the final allowlist assigns anonymous ordinal labels to exported rows.
  function compose({ snapshot, status, metrics, viewer, hostVersion, network: net, connection, events, native }) {
    const s = object(snapshot), local = (Array.isArray(metrics) ? metrics : []).slice(0, 64).map(object);
    const remote = (Array.isArray(s.terminals) ? s.terminals : []).slice(0, 64).map(object);
    const terminals = remote.map(t => ({ ...t, ...local.find(m => m.id === t.id), host: t.host, controller: t.controller, alive: t.alive }));
    for (const m of local) if (!remote.some(t => t.id === m.id)) terminals.unshift({ ...m, controller: 'unknown' });
    terminals.sort((a, b) => Number(!!b.focused) - Number(!!a.focused));
    return report({ ...s, capturedAt: Date.now(), viewer, host: { version: s.host?.version || hostVersion, state: status },
      network: { viewer: net, host: s.network?.host }, connection, native, terminals,
      events: [...(Array.isArray(s.events) ? s.events.slice(-50) : []), ...(Array.isArray(events) ? events.slice(-50) : [])]
        .sort((a, b) => (time(a?.at) || 0) - (time(b?.at) || 0)),
    });
  }
  async function withTimeout(promise, ms = 6000) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Diagnostics timed out')), ms); })]); }
    finally { clearTimeout(timer); }
  }
  function render(container, input) {
    const r = report(input), table = document.createElement('table');
    function row(values, head = false) {
      const tr = document.createElement('tr');
      for (const value of values) { const td = document.createElement(head ? 'th' : 'td'); td.textContent = value; tr.append(td); }
      table.append(tr);
    }
    summary(r).forEach(values => row(values));
    container.replaceChildren(table);
    const terminals = document.createElement('div');
    for (const t of r.terminals) {
      const p = document.createElement('p');
      const grid = v => v.cols == null || v.rows == null ? 'unknown' : `${v.cols} × ${v.rows}`;
      p.textContent = `${t.label}${t.focused ? ' (focused)' : ''}: host ${grid(t.host)}; local ${grid(t.local)}; viewport ${t.local.width ?? '?'} × ${t.local.height ?? '?'} px; sizing: ${t.controller}.`;
      terminals.append(p);
    }
    if (!r.terminals.length) terminals.textContent = 'No terminal sizing data available.';
    container.append(terminals);
    for (const e of r.events.slice(-5)) {
      const p = document.createElement('p');
      p.textContent = `${e.at == null ? 'Unknown time' : new Date(e.at).toISOString()} · ${e.area}: ${e.detail}`;
      container.append(p);
    }
  }
  const api = { classify, createLog, report, stringify, summary, compose, withTimeout, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ToteDiagnostics = api;
})(typeof window !== 'undefined' ? window : globalThis);
