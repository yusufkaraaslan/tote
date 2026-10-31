const {contextBridge,ipcRenderer}=require('electron');
function addListener(name,fn){
  const key='sim:'+name;
  const handler=(_,data)=>fn(data);ipcRenderer.on(key,handler);
  return Promise.resolve({remove:()=>ipcRenderer.removeListener(key,handler)});
}
contextBridge.exposeInMainWorld('simulatorPlugins',{
  ToteNative:{addListener,connect:args=>ipcRenderer.invoke('sim:connect',args),
    send:args=>ipcRenderer.invoke('sim:send',args),disconnect:args=>ipcRenderer.invoke('sim:disconnect',args),showKeyboard:async()=>{}},
  ToteDiscovery:{addListener,start:args=>ipcRenderer.invoke('sim:discover',args),stop:async()=>{},openTailscale:async()=>{}},
  ToteSpeech:{addListener:async()=>{},start:async()=>{throw Error('Microphone requires an Android device.');},stop:async()=>{},cancel:async()=>{}},
});
