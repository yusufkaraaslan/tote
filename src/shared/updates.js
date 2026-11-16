// Pure release and compatibility policy shared by both viewers.
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
    return count > 0 ? `${count} host terminal${count===1?' is':'s are'} running. Finish them before replacing the host runtime. Closing desktop windows leaves background sessions running; installers and host upgrades still require a safe stop.`
      : 'Installation is manual. Save your documents and phone drafts before replacing or restarting Tote.';
  }
  function assetURL(release, name) {
    if (!version(release) || !/^[A-Za-z0-9_.-]+$/.test(name)) throw Error('Invalid release asset');
    return RELEASES+'/download/v'+release+'/'+name;
  }
  function artifact(manifest, { current, latest, platform, arch, protocol = 1 }) {
    if (!manifest || manifest.updateSchema !== 1 || manifest.signed !== true || manifest.version !== latest ||
        compare(latest,current) !== 1 || manifest.protocol !== protocol || !Array.isArray(manifest.files) ||
        manifest.files.length > 16 || !manifest.releasePlatforms?.includes(platform))
      throw Error('This release does not support a verified, compatible in-app update.');
    const name = platform === 'linux' && ['x64','arm64'].includes(arch) ? `Tote-${latest}-linux-${arch === 'x64' ? 'x86_64' : arch}.AppImage`
      : platform === 'android' ? `Tote-${latest}-android.apk` : null;
    const matches = manifest.files.filter(f => f.name === name && f.platform === platform);
    const f = matches[0], limit = platform === 'android' ? 256*1024*1024 : 1024*1024*1024;
    if (!name || matches.length !== 1 || !/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 1 || f.size > limit)
      throw Error('Missing or invalid update package for this device.');
    if (platform === 'android' && (!Number.isSafeInteger(manifest.androidVersionCode) || manifest.androidVersionCode < 1 ||
        !Number.isSafeInteger(manifest.androidMinSdkVersion) || manifest.androidMinSdkVersion < 33)) throw Error('Invalid Android update policy.');
    return { ...f, url:assetURL(latest,name) };
  }
  const api={RELEASES,API,version,compare,latest,peer,installAdvice,assetURL,artifact};
  if(typeof module!=='undefined' && module.exports) module.exports=api; else root.ToteUpdates=api;
})(typeof window!=='undefined'?window:globalThis);
