const ALL = ['linux', 'darwin', 'win32', 'android'];
function productionPlatforms(release) {
  const platforms = release.releasePlatforms;
  if (!Array.isArray(platforms) || platforms.length < 1 || new Set(platforms).size !== platforms.length
    || platforms.some(p => !ALL.includes(p))) throw Error('Invalid production release platforms');
  return ALL.filter(p => platforms.includes(p));
}
function platforms(release, signed) { return signed ? productionPlatforms(release) : [...ALL]; }
function desktopMatrix(release, signed) {
  const runners = { linux: 'ubuntu-22.04', darwin: 'macos-15', win32: 'windows-2022' };
  return { include: platforms(release, signed).filter(p => p !== 'android').map(platform => ({ os: runners[platform], platform })) };
}
module.exports = { ALL, productionPlatforms, platforms, desktopMatrix };
