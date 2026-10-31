// Debug an installed APK through Android WebView's debugging port.
// adb forward tcp:18765 localabstract:webview_devtools_remote_<app pid>
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
const adb = join(process.env.ANDROID_HOME || join(homedir(),'Android','Sdk'),'platform-tools','adb');
const serial = process.env.TOTE_ADB_SERIAL || 'emulator-5554';
const webviewTop = Number(process.env.TOTE_WEBVIEW_TOP || 128); // Pixel 6 API 35 status bar

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSocket } = require('../../node_modules/ws');
const pages = await (await fetch('http://127.0.0.1:18765/json')).json();
const page = pages.find(p => p.type === 'page');
if (!page) throw Error('No Android WebView debugging target');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
let sequence=0;const pending=new Map();
socket.on('message',raw=>{const msg=JSON.parse(raw);const call=pending.get(msg.id);if(call){pending.delete(msg.id);clearTimeout(call.timer);msg.error?call.reject(Error(JSON.stringify(msg.error))):call.resolve(msg.result);}});
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Timed out: '+method));},10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function tap(selector){
  const point=await evaluate(`(async()=>{const selector=${JSON.stringify(selector)};const e=selector.startsWith('text=')?[...document.querySelectorAll('button')].find(e=>e.textContent.startsWith(selector.slice(5))):document.querySelector(selector);e.scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,180));const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  const dpr=await evaluate('devicePixelRatio');
  execFileSync(adb,['-s',serial,'shell','input','tap',String(Math.round(point.x*dpr)),String(Math.round(point.y*dpr)+webviewTop)]);
}
try {
  const [action,value]=process.argv.slice(2);
  if(action==='eval')console.log(JSON.stringify(await evaluate(value),null,2));
  else if(action==='tap')await tap(value);
  else if(action==='pick') {
    execFileSync(adb,['-s',serial,'shell','uiautomator','dump','/sdcard/tote-picker.xml']);
    const xml=execFileSync(adb,['-s',serial,'shell','cat','/sdcard/tote-picker.xml'],{encoding:'utf8'});
    const node=[...xml.matchAll(/<node [^>]+/g)].map(m=>m[0]).find(n=>n.includes('text="'+value+'"'));
    if(!node)throw Error('Native picker item missing: '+value);
    const b=node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number);
    execFileSync(adb,['-s',serial,'shell','input','tap',String(Math.round((b[0]+b[2])/2)),String(Math.round((b[1]+b[3])/2))]);
  }
  else if(action==='wait') {
    let ok=false;for(let i=0;i<100;i++){if(await evaluate(value)){ok=true;break;}await new Promise(r=>setTimeout(r,100));}
    if(!ok)throw Error('Condition did not become true: '+value);console.log('PASS: '+value);
  }
  else if(action==='type')await call('Input.insertText',{text:value});
  else console.log(JSON.stringify(await evaluate(`({version:document.querySelector('#build-version')?.textContent,selects:[...document.querySelectorAll('select')].map(e=>({id:e.id,value:e.value,disabled:e.disabled,options:[...e.options].map(o=>({value:o.value,text:o.textContent}))})),banner:document.querySelector('#connection-banner').textContent,notice:document.querySelector('#notice').textContent,empty:document.querySelector('#empty').textContent,terminalVisible:!document.querySelector('#terminal-scroll').hidden,screen:document.querySelector('.xterm-rows')?.textContent,sendDisabled:document.querySelector('#send').disabled})`),null,2));
} finally {socket.close();}
