const fs=require('node:fs'), path=require('node:path');
const root=path.join(__dirname,'..');
const U=require('../src/shared/updates');
function check(dir=root, tag) {
  const read=p=>JSON.parse(fs.readFileSync(path.join(dir,p),'utf8'));
  const r=read('release.json');
  require('./release-targets').productionPlatforms(r);
  if(r.androidMinSdkVersion !== 33 || !U.version(r.version) || !Number.isInteger(r.androidVersionCode) || r.androidVersionCode<11 || r.androidVersionCode>2100000000 || r.protocol!==require('../src/host/protocol').VERSION) throw Error('Invalid release metadata');
  for(const name of ['package.json','package-lock.json','mobile/package.json','mobile/package-lock.json']) {
    const p=read(name);
    if(p.version!==r.version || (p.packages && p.packages[''].version!==r.version)) throw Error('Version mismatch in '+name);
  }
  const gradle=fs.readFileSync(path.join(dir,'mobile/android/app/build.gradle'),'utf8');
  if(!gradle.includes('versionCode releaseMetadata.androidVersionCode') || !gradle.includes('versionName releaseMetadata.version')) throw Error('Android must use release.json');
  const variables=fs.readFileSync(path.join(dir,'mobile/android/variables.gradle'),'utf8');
  if(!variables.includes('minSdkVersion = releaseMetadata.androidMinSdkVersion')) throw Error('Android minimum must use release.json');
  if(tag && tag!=='v'+r.version) throw Error('Tag must be v'+r.version);
  if(tag && !fs.existsSync(path.join(dir,'docs/releases',tag+'.md'))) throw Error('Missing release notes');
  return r;
}
if(require.main===module) {
  if(process.argv[2]==='--write') {
    const r=JSON.parse(fs.readFileSync(path.join(root,'release.json'),'utf8'));
    if(r.androidMinSdkVersion !== 33 || !U.version(r.version)) throw Error('Invalid release version');
    for(const file of ['package.json','package-lock.json','mobile/package.json','mobile/package-lock.json']) {
      const p=path.join(root,file), data=JSON.parse(fs.readFileSync(p,'utf8'));data.version=r.version;
      if(data.packages)data.packages[''].version=r.version;
      fs.writeFileSync(p,JSON.stringify(data,null,2)+'\n');
    }
  }
  console.log('Release metadata valid:',check(root,process.env.RELEASE_TAG).version);
}
module.exports={check};
