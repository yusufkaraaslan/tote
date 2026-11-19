export function webUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw Error('Enter a complete http:// or https:// address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Error('Use an http:// or https:// address without a username or password.');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '[::]' ||
      host === '0.0.0.0' || host.startsWith('127.')) {
    throw Error('This address points to the phone. For DSH on your computer, use a URL reachable from the phone over Tailscale. A service listening only on 127.0.0.1 cannot be opened remotely.');
  }
  return url.href;
}
