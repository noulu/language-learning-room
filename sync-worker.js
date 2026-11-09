import {SupabaseSync} from './sync.js';
import {OfflineStore,openDatabase} from './store.js';
const values=new Map(),pending=new Map();let manager,initializing,serial=0,allowed=true;
const context=()=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});self.postMessage({type:'context',id});});
const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,value);self.postMessage({type:'storage',key,value});},removeItem:key=>{values.delete(key);self.postMessage({type:'storage',key,value:null});}};
async function refreshContext(){const value=await context();for(const key of ['multi-offline-ui','multi-offline-auth']){if(value[key]===null)values.delete(key);else values.set(key,value[key]);}allowed=value.canApply;manager.auth=JSON.parse(storage.getItem('multi-offline-auth')||'null');}
self.onmessage=async({data})=>{
 if(data.type==='context-result'){const request=pending.get(data.id);pending.delete(data.id);request?.resolve(data.value);return;}
 if(data.type==='allowed'){allowed=data.value;return;}
 try{
  initializing??=(async()=>{const engine={store:new OfflineStore(await openDatabase(),()=>{throw Error('学习数据库尚未就绪。');}),base:new URL('./',import.meta.url)};manager=new SupabaseSync(engine,data.config,{storage,canApply:()=>allowed,onStatus:(text,kind)=>self.postMessage({type:'status',text,kind}),onApply:()=>self.postMessage({type:'apply'})});manager.refreshContext=refreshContext;})();await initializing;
  await refreshContext();
  const result=await manager[data.method](...(data.args??[]));self.postMessage({type:'result',id:data.id,result});
 }catch(error){self.postMessage({type:'result',id:data.id,error:{message:error.message,status:error.status,retryUntil:error.retryUntil}});}
};
