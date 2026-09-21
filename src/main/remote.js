// Remote spaces, impure half: one multiplexed ssh connection per space, and the
// file operations that ride it. The decisions -- what to send, what the output
// means -- live in sshfix.js, which is why this file has no string building and
// no regexes in it.
//
// Two rules shape everything here:
//
//   1. Exactly one thing in the process may authenticate, and it is never a
//      file operation. Tailscale SSH's check period expires on a timer, so
//      re-auth is an ambient condition that any operation can hit at any
//      moment; ops therefore run with BatchMode and fail fast, and hand the
//      problem to RemoteConn, which owns the one interactive pty that can
//      answer a host-key question, a passphrase, or a "visit this URL".
//   2. New channels over an already-authenticated master do NOT re-trigger that
//      check -- only a new connection does. So the master's lifetime is what
//      sets how often the user has to re-authenticate, and keeping it alive
//      (ControlPersist=yes plus keepalives) is the real mitigation. Everything
//      below is the handling for when it expires anyway.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const S = require('./sshfix');

// Has to clear the 25 MB image cap with room for base64 and a big tree listing.
const MAX_BUFFER = 64 * 1024 * 1024;
const TREE_DEPTH = 5;

class RemoteError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;                 // one of sshfix.classify()'s kinds
    this.remote = true;               // lets the renderer tell these apart
  }
}

// How long a non-interactive op may take before we stop waiting. Generous
// enough for a big tree over a slow link, finite because the alternative is a
// files pane that spins forever -- see `abortOn` below for why that is real.
const OP_TIMEOUT = 20000;
// Only the head of stderr can carry an auth banner, and only stderr is scanned
// at all: verified against a live tailnet, the Tailscale check writes to stderr
// while stdout stays empty. Scanning stdout too would mean a `cat` of a file
// that merely *documents* a login URL aborts its own read -- and this repo now
// contains exactly such text. It also keeps a 25 MB image read from being
// decoded to a string chunk by chunk for nothing.
const ABORT_SCAN_BYTES = 8192;

// Run a command to completion, collecting stdout as a Buffer so the same helper
// serves `cat` on a PNG and `find` on a tree.
//
// `timeout` and `abortOn` exist because of a failure that BatchMode does NOT
// cover: Tailscale serves its periodic check *after* the connection is up, so
// ConnectTimeout has long since elapsed and ssh simply sits holding an open
// session while a "visit this URL" banner waits to be read. Verified against a
// live tailnet -- the op hangs indefinitely. Nothing may wait forever.
function exec(file, args, { input, inputFile, timeout, abortOn } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(e.message) });
    }
    const out = [];
    let len = 0;
    let err = '';
    let head = '';                 // head of stderr, the only place a banner lands
    let stopped = null;            // 'timeout' | 'needs-human'
    const stop = (why) => {
      if (stopped) return;
      stopped = why;
      try { proc.kill('SIGKILL'); } catch {}
    };
    const timer = timeout ? setTimeout(() => stop('timeout'), timeout) : null;
    const sniff = (chunk) => {
      if (!abortOn || head.length >= ABORT_SCAN_BYTES) return;
      head += chunk;
      if (abortOn(head)) stop('needs-human');
    };
    proc.stdout.on('data', (d) => {
      len += d.length;
      if (len <= MAX_BUFFER) out.push(d);
    });
    proc.stderr.on('data', (d) => { const t = d.toString(); err += t; sniff(t); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(e.message) });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (len > MAX_BUFFER) {
        return resolve({ code: -1, stdout: Buffer.alloc(0), stderr: 'Remote output too large' });
      }
      // The partial output is the whole point of stopping early: it is what
      // carries the URL, so the caller can classify instead of guessing.
      resolve({ code: stopped ? -1 : code, stopped, stdout: Buffer.concat(out), stderr: err });
    });
    if (inputFile) {
      // Streamed, not read into memory: a staged download can be any size.
      const rs = fs.createReadStream(inputFile);
      rs.on('error', (e) => { try { proc.stdin.destroy(); } catch {} ; err += e.message; });
      rs.pipe(proc.stdin);
    } else if (input != null) proc.stdin.end(input);
    else proc.stdin.end();
  });
}

/* ----- the connection ------------------------------------------------------ */

class RemoteConn {
  // launchPty is injected rather than imported so this file stays independent
  // of PtyManager (and of electron): main.js wires the two together.
  constructor({ id, host, root, socketDir, cacheDir, launchPty, onState, onAuthUrl }) {
    this.id = id;
    this.host = host;
    this.configured = root;           // what the user typed, may start with ~
    this.root = null;                 // absolute, as reported by the remote
    this.state = 'idle';
    this.message = '';
    this.url = null;
    this.launchPty = launchPty;
    this.onState = onState || (() => {});
    this.onAuthUrl = onAuthUrl || (() => {});
    fs.mkdirSync(socketDir, { recursive: true });
    // Hashed, not the space id: a unix socket path has ~104 bytes to work with
    // and a space id is user-derived and unbounded.
    this.socket = path.join(socketDir, crypto.createHash('sha1').update(id).digest('hex').slice(0, 12) + '.sock');
    this.cacheDir = path.join(cacheDir, crypto.createHash('sha1').update(id).digest('hex').slice(0, 12));
    this.connecting = null;
    this.ptyId = null;
  }

  info() {
    return { id: this.id, host: this.host, state: this.state, root: this.root || this.configured,
             message: this.message || S.explain(this.state), url: this.url, ptyId: this.ptyId };
  }

  setState(state, { message, url } = {}) {
    this.state = state;
    this.message = message || S.explain(state);
    this.url = url || null;
    this.onState(this.info());
  }

  /* --- the one interactive path --------------------------------------------
   *
   * Runs in a real pty and streams to a pane, because every way this can stall
   * needs a human: an unknown host key, a key passphrase, and Tailscale's
   * periodic check, which prints a URL and blocks until it has been visited.
   * The process staying alive and blocked is the whole point -- it unblocks by
   * itself the moment the browser round trip finishes.
   */
  connect({ cols, rows, sender, mkdir }) {
    if (this.connecting) return this.connecting;
    this.setState('connecting');
    let buf = '';
    let triedAuth = false;            // open the login page at most once per attempt
    let settled = false;

    this.connecting = new Promise((resolve) => {
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        this.connecting = null;
        resolve(ok);
      };

      const onData = (data) => {
        buf += data;
        const probe = S.parseProbe(buf);
        if (probe.ok) {
          this.root = probe.root;
          this.setState('up');
          return finish(true);        // the master persists after the probe exits
        }
        if (probe.error) {
          this.setState('down', { message: probe.error });
          return finish(false);
        }
        const cls = S.classify(buf);
        if (cls.kind === 'auth') {
          this.setState('auth', { url: cls.url, message: 'Waiting for you to authenticate...' });
          if (!triedAuth) { triedAuth = true; this.onAuthUrl(cls.url); }
        } else if (cls.kind !== 'unknown' && this.state === 'connecting') {
          this.setState(cls.kind, { message: S.describe(cls) });
        }
      };

      const onExit = () => {
        this.ptyId = null;
        if (settled) return;
        // Exited without ever reporting a root: whatever the last classification
        // was is the reason, and 'unknown' just means the connection went away.
        const cls = S.classify(buf);
        this.setState(cls.kind === 'unknown' ? 'down' : cls.kind,
          { message: cls.kind === 'unknown' ? undefined : S.describe(cls), url: cls.url });
        finish(false);
      };

      const args = S.connectArgs({ host: this.host, socket: this.socket, root: this.configured, mkdir });
      try {
        this.ptyId = this.launchPty({ file: 'ssh', args, cols, rows }, sender, onData, onExit);
      } catch (e) {
        this.setState('down', { message: e.message });
        finish(false);
      }
    });
    return this.connecting;
  }

  // Re-establish the master without a human. Most drops -- sleep, a wifi hop, a
  // tailnet reconnect -- need no auth at all and heal invisibly here; the ones
  // that do need auth surface as a state the UI can offer a button for.
  async silentConnect() {
    if (this.connecting) return this.connecting;
    const root = this.root || this.configured;
    const args = S.silentConnectArgs({ host: this.host, socket: this.socket, root });
    // Same hazard as run(): a reconnect can be met with the check banner and
    // then held open. Bounded, and stopped the moment the banner appears.
    const { code, stdout, stderr } = await exec('ssh', args,
      { timeout: OP_TIMEOUT, abortOn: S.needsHuman });
    const probe = S.parseProbe(stdout.toString() + stderr);
    if (code === 0 && probe.ok) {
      this.root = probe.root;
      this.setState('up');
      return true;
    }
    const cls = S.classify(stderr + stdout.toString());
    this.setState(cls.kind === 'unknown' ? 'down' : cls.kind,
      { message: cls.kind === 'unknown' ? undefined : S.describe(cls), url: cls.url });
    return false;
  }

  // Cheap enough to poll while a remote space is active, so a dropped link is
  // noticed by the heartbeat rather than by the user clicking something.
  async healthy() {
    const { code } = await exec('ssh', S.checkArgs({ host: this.host, socket: this.socket }),
      { timeout: 5000 });
    return code === 0;
  }

  async heartbeat() {
    if (this.state !== 'up') return;
    if (!(await this.healthy())) this.setState('socketDead');
  }

  // Every non-interactive operation. Fails fast, then retries once behind a
  // silent reconnect -- so a laptop that slept costs one extra round trip
  // rather than an error the user has to clear by hand.
  async run(command, { input, inputFile, retry = true } = {}) {
    // ControlPersist=yes outlives Tote itself, so a restart usually finds the
    // master still up and needs no interaction at all.
    if (!this.root && !(await this.silentConnect())) {
      throw new RemoteError(this.message, this.state);
    }
    const args = S.runArgs({ host: this.host, socket: this.socket, command });
    const res = await exec('ssh', args,
      { input, inputFile, timeout: OP_TIMEOUT, abortOn: S.needsHuman });
    if (res.code === 0) {
      if (this.state !== 'up') this.setState('up');
      return res.stdout;
    }
    // Stopped rather than finished. `needs-human` is the Tailscale check almost
    // every time and the partial output holds the URL, so it classifies cleanly
    // and the banner can offer the login link within a second of the op
    // starting -- instead of the pane spinning until someone gives up.
    if (res.stopped) {
      // stderr only, for the same reason the sniffer reads only stderr: file
      // content on stdout must never be mistaken for a server message.
      const cls = S.classify(res.stderr);
      if (cls.kind !== 'unknown') {
        this.setState(cls.kind, { message: S.describe(cls), url: cls.url });
        throw new RemoteError(this.message, cls.kind);
      }
      this.setState('down', { message: `${this.host} stopped responding` });
      throw new RemoteError(this.message, 'down');
    }
    // 255 is ssh's own failure; any other code came from the remote command and
    // must not be retried -- reconnecting and re-running would apply a
    // non-idempotent operation twice.
    const sshFailed = res.code === 255 || res.code === -1;
    const cls = S.classify(res.stderr);
    if (retry && sshFailed && await this.silentConnect()) {
      return this.run(command, { input, inputFile, retry: false });
    }
    if (sshFailed) {
      if (cls.kind !== 'unknown') this.setState(cls.kind, { message: S.describe(cls), url: cls.url });
      throw new RemoteError(cls.kind === 'unknown' ? (res.stderr.trim() || 'Connection failed') : this.message,
        cls.kind === 'unknown' ? 'down' : cls.kind);
    }
    throw new RemoteError((res.stderr || res.stdout.toString()).trim() || 'Remote command failed', 'error');
  }

  async text(command, opts) {
    return (await this.run(command, opts)).toString('utf8');
  }

  async disconnect() {
    await exec('ssh', S.exitArgs({ host: this.host, socket: this.socket }));
    this.root = null;
    this.setState('idle');
  }
}

/* ----- the filesystem ------------------------------------------------------
 *
 * Same method surface as the local half of WorkspaceManager, same return
 * shapes, so the IPC handlers and the whole renderer cannot tell the two apart.
 * `meta` carries the local file-classification helpers rather than duplicating
 * them, which is what keeps a remote tree node and a remote doc pane agreeing
 * about a file's kind for exactly the same reason the local ones do.
 */
class RemoteFs {
  constructor(conn, { ignore, meta }) {
    this.conn = conn;
    this.ignore = ignore;
    this.meta = meta;
  }

  get root() {
    return this.conn.root || this.conn.configured;
  }

  resolveSafe(rel) {
    if (!this.conn.root) throw new RemoteError('Not connected to ' + this.conn.host, this.conn.state);
    return S.remoteResolve(this.conn.root, rel);
  }

  inboxDir(providerId) {
    if (!this.conn.root) throw new RemoteError('Not connected to ' + this.conn.host, this.conn.state);
    const base = S.remoteResolve(this.conn.root, 'inbox');
    return providerId ? base + '/' + providerId : base;
  }

  isTextFile(name) {
    return this.meta.isTextFile(name);
  }

  async tree(depth = TREE_DEPTH) {
    const out = await this.conn.text(S.treeCommand(this.conn.root, depth, this.ignore));
    return S.buildTree(out, (name) => ({
      text: this.meta.isTextFile(name),
      kind: this.meta.docKind(name),
    }));
  }

  // One line back however big the project is: the change probe that stands in
  // for chokidar, which cannot watch another machine.
  async fingerprint(depth = TREE_DEPTH) {
    return (await this.conn.text(S.fingerprintCommand(this.conn.root, depth, this.ignore))).trim();
  }

  async stat(rel) {
    return S.parseStat(await this.conn.text(S.statCommand(this.resolveSafe(rel))));
  }

  async readText(rel) {
    const st = await this.stat(rel);
    if (st.type !== 'file') throw new Error('Not a file: ' + rel);
    if (st.size > this.meta.MAX_READ_BYTES) throw new Error('File too large to edit inline (> 2 MB)');
    const buf = await this.conn.run(S.catCommand(this.resolveSafe(rel)));
    if (buf.includes(0)) throw new Error('Binary file - open it externally instead');
    return buf.toString('utf8');
  }

  async writeText(rel, content) {
    await this.conn.run(S.writeCommand(this.resolveSafe(rel)), { input: content });
  }

  async readDoc(rel) {
    const abs = this.resolveSafe(rel);
    const kind = this.meta.docKind(rel);
    const st = await this.stat(rel);
    if (st.type === 'none') throw new Error('No such file: ' + rel);
    if (st.type === 'dir') throw new Error('Not a file: ' + rel);
    const base = { kind, mtimeMs: st.mtimeMs, size: st.size };
    if (kind === 'binary') return base;

    // A <webview> cannot be pointed at a remote path, so a remote PDF is cached
    // locally and served from there. The cache key carries the mtime, so a
    // changed file is a different file and staleness needs no bookkeeping.
    if (kind === 'pdf') return Object.assign(base, { fileUrl: pathToFileURL(await this.cache(rel, st)).href });

    // HTML gets the same two faces as it does locally, minus the folder around
    // it: the cache holds one file, so a remote page whose stylesheet sits next
    // to it renders unstyled. The source face is exact either way.
    if (kind === 'html') {
      const out = Object.assign(base, { fileUrl: pathToFileURL(await this.cache(rel, st)).href });
      if (st.size <= this.meta.MAX_READ_BYTES) {
        const buf = await this.conn.run(S.catCommand(abs));
        if (!buf.includes(0)) out.text = buf.toString('utf8');
      }
      return out;
    }

    if (kind === 'image') {
      if (st.size > this.meta.MAX_IMAGE_BYTES) {
        return Object.assign(base, { error: this.meta.mb(st.size) + ', larger than the 25 MB view limit' });
      }
      const buf = await this.conn.run(S.catCommand(abs));
      const ext = this.meta.extOf(rel);
      const out = Object.assign(base, {
        dataUrl: 'data:' + (this.meta.MIME[ext] || 'application/octet-stream') + ';base64,' + buf.toString('base64'),
      });
      if (ext === '.svg' && !buf.includes(0)) out.text = buf.toString('utf8');
      return out;
    }

    if (st.size > this.meta.MAX_READ_BYTES) {
      return Object.assign(base, { error: this.meta.mb(st.size) + ', larger than the 2 MB view limit' });
    }
    const buf = await this.conn.run(S.catCommand(abs));
    if (buf.includes(0)) return Object.assign(base, { error: 'Binary file — open it externally instead' });
    return Object.assign(base, { text: buf.toString('utf8') });
  }

  async createFile(rel) {
    await this.guardedCreate(S.createFileCommand(this.resolveSafe(rel)), rel);
  }

  async createFolder(rel) {
    await this.guardedCreate(S.mkdirCommand(this.resolveSafe(rel)), rel);
  }

  async guardedCreate(command, rel) {
    try {
      await this.conn.run(command);
    } catch (e) {
      // The remote script signals a collision by exit code, so the message it
      // printed is what we have to go on.
      if (/TOTE_ERR=exists/.test(String(e.message))) throw new Error('Already exists: ' + rel);
      throw e;
    }
  }

  async rename(fromRel, toRel) {
    await this.conn.run(S.renameCommand(this.resolveSafe(fromRel), this.resolveSafe(toRel)));
  }

  // No remote wastebasket exists, so this moves into the space's .tote-trash/
  // rather than removing. Recoverable, like shell.trashItem is locally.
  async trash(rel) {
    const trashDir = S.remoteResolve(this.conn.root, '.tote-trash');
    await this.conn.run(S.trashCommand(this.resolveSafe(rel), trashDir, String(Date.now())));
  }

  // Chromium writes downloads to local disk, so a remote space stages them and
  // pushes afterwards. Copy, never move: the source may be the user's own
  // ~/Downloads, which nothing of ours may empty.
  async ingest(absSource, providerId) {
    const inbox = this.inboxDir(providerId);
    await this.conn.run(S.mkdirpCommand(inbox));
    const listing = await this.conn.text(`ls -A ${S.shq(inbox)} 2>/dev/null || true`);
    const taken = listing.split(/\r?\n/).filter(Boolean);
    const target = inbox + '/' + S.freeName(path.basename(absSource), taken);
    await this.conn.run(S.writeCommand(target), { inputFile: absSource });
    return target;
  }

  // A local copy of a remote file, for the things that can only be given a real
  // path: the PDF pane's <webview> and "send to active tab".
  async cache(rel, st) {
    const stat = st || (await this.stat(rel));
    const key = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16);
    const file = path.join(this.conn.cacheDir, `${key}-${stat.mtimeMs}${this.meta.extOf(rel)}`);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(this.conn.cacheDir, { recursive: true });
      const buf = await this.conn.run(S.catCommand(this.resolveSafe(rel)));
      fs.writeFileSync(file, buf);
      this.sweepCache(key, path.basename(file));
    }
    return file;
  }

  // One cached copy per remote file: drop the older mtimes of the same key.
  sweepCache(key, keep) {
    try {
      for (const name of fs.readdirSync(this.conn.cacheDir)) {
        if (name.startsWith(key + '-') && name !== keep) {
          fs.unlinkSync(path.join(this.conn.cacheDir, name));
        }
      }
    } catch {}
  }
}

module.exports = { RemoteConn, RemoteFs, RemoteError };
