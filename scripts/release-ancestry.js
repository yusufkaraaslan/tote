const {spawnSync}=require('node:child_process');
function check(ref='HEAD', main='refs/remotes/origin/main', cwd) {
  const result=spawnSync('git',['merge-base','--is-ancestor','--',ref,main],{cwd,encoding:'utf8'});
  if(result.error || result.status!==0) throw new Error('Production releases must use a commit already on main. Fetch the full main history before checking.');
}
if(require.main===module)check(process.argv[2],process.argv[3]);
module.exports={check};
