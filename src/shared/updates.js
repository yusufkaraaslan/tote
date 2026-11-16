// Pure release and compatibility policy shared by both viewers. No installation.
(function(root) {
  const RELEASES = 'https://github.com/yusufkaraaslan/tote/releases';
  const API = 'https://api.github.com/repos/yusufkaraaslan/tote/releases/latest';
  function version(value) {
    if (typeof value !== 'string' || value !== value.trim() || !/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(value)) return null;
    return value.split('.').map(Number);
  }
  function compare(a,b) {
    const x=version(a), y=version(b);
    if (!x || !y) return null;
    for(let i=0;i<3;i++) if(x[i]!==y[i]) return Math.sign(x[i]-y[i]);
    return 0;
  }
  function latest(data, current) {
    const tag = typeof data?.tag_name === 'string' ? data.tag_name : '';
    const release = tag.startsWith('v') ? tag.slice(1) : '';
    if (!version(release) || !version(current) || data.draft !== false || data.prerelease !== false)
      throw new Error('No valid stable release information was returned.');
    return { current, latest:release, available:compare(release,current)>0, url:RELEASES+'/tag/v'+release };
  }
  function peer(peer, local, protocol = 1) {
    if (peer?.v !== protocol) return { ok:false, message:`protocol v${Number.isInteger(peer?.v) ? peer.v : '?'} on the other side, v${protocol} here — update Tote on both machines from ${RELEASES}` };
    const mismatch = version(local) && version(peer.tote) && compare(local,peer.tote)!==0;
    return { ok:true, message:mismatch ? `This viewer is ${local}; the host is ${peer.tote}. They share protocol v${protocol}, but newer features may require updating both devices.` : '' };
  }
  function installAdvice(count) {
    return count > 0 ? `${count} host terminal${count===1?' is':'s are'} running. Finish them before replacing or restarting desktop Tote; quitting currently stops those processes.`
      : 'Installation is manual. Save your documents and phone drafts before replacing or restarting Tote.';
  }
  const api={RELEASES,API,version,compare,latest,peer,installAdvice};
  if(typeof module!=='undefined' && module.exports) module.exports=api; else root.ToteUpdates=api;
})(typeof window!=='undefined'?window:globalThis);
