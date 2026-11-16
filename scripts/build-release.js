const {build}=require('electron-builder');
const {check}=require('./release-version');
const pkg=require('../package.json');
check(undefined,process.env.RELEASE_TAG);
const signed=process.env.TOTE_SIGNED_RELEASE==='true';
if(signed) require('./release-signing').check(process.platform);
const config={...pkg.build,directories:{...pkg.build.directories,output:"dist/release"},forceCodeSigning:signed && process.platform!=='linux',
  mac:{...pkg.build.mac,hardenedRuntime:true, ...(signed?{}:{identity:null,notarize:false})}};
// Apple Silicon requires a valid signature even for local preview launches.
// An ad-hoc signature carries no publisher identity and is never notarized.
if(!signed && process.platform==='darwin') config.afterPack=async context=>{
  const app=require('node:path').join(context.appOutDir,'Tote.app');
  await require('@electron/osx-sign').signAsync({app,identity:'-',identityValidation:false,gatekeeperAssess:false,
    optionsForFile:()=>({hardenedRuntime:false})});
  require('node:child_process').execFileSync('codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
};
build({config,publish:'never'}).catch(error=>{console.error(error.message);process.exitCode=1;});
