const {build}=require('electron-builder');
const {check}=require('./release-version');
const pkg=require('../package.json');
check(undefined,process.env.RELEASE_TAG);
const signed=process.env.TOTE_SIGNED_RELEASE==='true';
if(signed) require('./release-signing').check(process.platform);
const config={...pkg.build,directories:{...pkg.build.directories,output:"dist/release"},forceCodeSigning:signed && process.platform!=='linux',
  mac:{...pkg.build.mac,hardenedRuntime:true, ...(signed?{}:{identity:null,notarize:false})}};
build({config,publish:'never'}).catch(error=>{console.error(error.message);process.exitCode=1;});
