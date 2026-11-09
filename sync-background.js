// Cloud serialization, validation, merging and compression belong off the UI
// thread. The existing sync protocol and cross-tab learning lock are shared.
export function backgroundSync(manager,base){
 // Without a shared Web Lock, keep the existing same-page operation queue.
 if(typeof Worker!=='function'||!navigator.locks)return;
 let worker,serial=0,inFlight,applying=Promise.resolve();const pending=new Map();
 const context=()=>({'multi-offline-ui':manager.storage.getItem('multi-offline-ui'),'multi-offline-auth':manager.storage.getItem('multi-offline-auth'),canApply:manager.canApply()});
 function start(){
  if(worker)return;worker=new Worker(new URL('sync-worker.js',base),{type:'module'});
  worker.onmessage=({data})=>{
   if(data.type==='context'){worker.postMessage({type:'context-result',id:data.id,value:context()});return;}
   if(data.type==='storage'){if(data.value===null)manager.storage.removeItem(data.key);else manager.storage.setItem(data.key,data.value);return;}
   if(data.type==='status'){manager.conflict=data.kind==='conflict'?{background:true}:null;manager.status(data.text,data.kind);return;}
   if(data.type==='apply'){applying=manager.engine.store.refresh().then(()=>manager.onApply());return;}
   if(data.type==='result'){const request=pending.get(data.id);pending.delete(data.id);if(data.error)request?.reject(Object.assign(new Error(data.error.message),data.error));else applying.then(()=>request?.resolve(data.result),error=>request?.reject(error));}
  };
  worker.onerror=()=>{worker.terminate();worker=null;for(const request of pending.values())request.reject(Error('后台同步暂不可用，进度仍保存在当前设备。'));pending.clear();};
 }
 function call(method,args=[]){return new Promise((resolve,reject)=>{try{start();const id=++serial;pending.set(id,{resolve,reject});worker.postMessage({id,method,args,config:manager.config});}catch(error){reject(error);}});}
 manager.sync=()=>{if(!manager.configured||!manager.auth){manager.status(manager.configured?'登录后自动同步手机和电脑。':'云同步等待配置；本机学习和备份可用。',manager.configured?'signed-out':'unconfigured');return Promise.resolve();}if(inFlight)return inFlight;inFlight=call('sync').finally(()=>{inFlight=null;});return inFlight;};
 manager.conflictBackup=which=>call('conflictBackup',[which]);manager.resolve=which=>call('resolve',[which]);
 // Let a busy editor/recording immediately suspend background application.
 for(const name of ['focusin','focusout','input','keydown','pointerdown'])document.addEventListener(name,()=>{worker?.postMessage({type:'allowed',value:manager.canApply()});},true);
}
