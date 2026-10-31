import { build } from 'esbuild';
import { mkdtemp, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(), 'tote-mobile-ui-'));
await build({entryPoints:['src/app.js'],bundle:true,outfile:join(dir,'app.js'),format:'iife',plugins:[{name:'fake-native',setup(b){
  b.onLoad({filter:/src\/app\.js$/},async args=>({contents:await readFile(args.path,'utf8')+'\nwindow.terminalText=()=>term ? Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i).translateToString(true)).join("\\n") : "";'}));
  b.onResolve({filter:/^\.\/native\.js$/},()=>({path:resolve('tests/native-fake.js')}));
  b.onResolve({filter:/^@capacitor\/app$/},()=>({path:'app',namespace:'fake'}));
  b.onLoad({filter:/.*/,namespace:'fake'},()=>({contents:'export const App={addListener:async()=>{},exitApp:async()=>{}};'}));
}}]});
for(const [from,to] of [['src/index.html','index.html'],['src/styles.css','styles.css'],['node_modules/@xterm/xterm/css/xterm.css','xterm.css']])await copyFile(from,join(dir,to));
const env={...process.env,TOTE_UI_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn('../node_modules/.bin/electron',['tests/ui.cjs'],{stdio:'inherit',env});
child.on('exit',code=>process.exit(code??1));
