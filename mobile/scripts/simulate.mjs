// Real mobile UI, real server; only the Android plugin boundary is replaced.
import { build } from 'esbuild';
import { mkdtemp, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { tailnetAddress } from '../src/model.js';
const address = tailnetAddress(process.argv[2]);
const dir = await mkdtemp(join(tmpdir(), 'tote-live-mobile-'));
await build({entryPoints:['src/app.js'],bundle:true,outfile:join(dir,'app.js'),format:'iife',plugins:[{
  name:'simulator-plugins',setup(b){
    b.onLoad({filter:/src\/app\.js$/},async args=>({contents:await readFile(args.path,'utf8')+`
      window.simulation = {
        text:()=>term ? Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i).translateToString(true)).join('\\n') : '',
        session:()=>attached,
        workspace:()=>client.call('workspaces:list'),
        reconnect:()=>client?.socket.close(),
      };`}));
    b.onResolve({filter:/^@capacitor\/(core|app)$/},args=>({path:args.path,namespace:'simulator'}));
    b.onLoad({filter:/.*/,namespace:'simulator'},()=>({contents:`
      export const registerPlugin = name => window.simulatorPlugins[name];
      export const App = {addListener:async()=>{},exitApp:async()=>{}};
    `}));
  },
}]});
for(const [from,to] of [['src/index.html','index.html'],['src/styles.css','styles.css'],['node_modules/@xterm/xterm/css/xterm.css','xterm.css']])await copyFile(from,join(dir,to));
const env={...process.env,TOTE_UI_DIR:dir,TOTE_SIM_ADDRESS:address};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn('../node_modules/.bin/electron',['scripts/simulator.cjs'],{stdio:'inherit',env});
child.on('exit',code=>process.exit(code??1));
