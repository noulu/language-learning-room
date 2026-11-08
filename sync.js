import { sha256 } from './crypto.js';
import { validateState, normalize } from './backup.js';
import { mergeProgress, SyncConflict } from './sync-merge.js';
const AUTH_KEY='multi-offline-auth';
const equal=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
async function pack(payload) {
  if(!globalThis.CompressionStream||!globalThis.DecompressionStream)return payload;
  const bytes=new Uint8Array(await new Response(new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  let text='';for(let offset=0;offset<bytes.length;offset+=16384)text+=String.fromCharCode(...bytes.subarray(offset,offset+16384));
  return {format:payload.format,version:1,state:{},encoding:'gzip-base64',packed:btoa(text)};
}
async function unpack(payload) {
  if(payload?.encoding!=='gzip-base64')return payload;
  if(!globalThis.DecompressionStream)throw new Error('请升级浏览器后同步；本机进度已保留。');
  if(typeof payload.packed!=='string'||payload.packed.length>64*1024*1024)throw new Error('云端存档大小无效。');
  const input=Uint8Array.from(atob(payload.packed),char=>char.charCodeAt(0)),reader=new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(),chunks=[];let length=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>64*1024*1024)throw new Error('解压后的存档超过64MB，未覆盖本机。');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(await new Blob(chunks).text());
}
export class SupabaseSync {
  constructor(engine,config,{fetcher=globalThis.fetch.bind(globalThis),storage=localStorage,onStatus=()=>{},onApply=()=>{},canApply=()=>true}={}) {
    this.engine=engine;this.config=config;this.fetcher=fetcher;this.storage=storage;this.onStatus=onStatus;this.onApply=onApply;this.canApply=canApply;
    this.auth=parse(storage.getItem(AUTH_KEY));this.queue=Promise.resolve();this.syncQueue=Promise.resolve();this.configured=false;
    if(config?.url&&config?.publishableKey){const url=new URL(config.url);if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co')||url.pathname!=='/')throw new Error('同步服务地址无效。');const key=config.publishableKey;if(key.startsWith('sb_secret_')||key.startsWith('ey')&&parse(atob(key.split('.')[1].replaceAll('-','+').replaceAll('_','/')))?.role!=='anon')throw new Error('浏览器只能使用公开密钥。');this.configured=true;this.origin=url.origin;}
  }
  status(text,kind='normal'){this.onStatus(text,kind);}
  async remote(baseline, userId) {
    const headers = { 'Content-Type': 'application/json' };
    const head = await this.request('/rest/v1/rpc/travel_head', { headers, body: {} });
    if (baseline && head.revision === baseline.revision) {
      return { revision: head.revision, payload: baseline.payload };
    }

    // A conflict or interrupted apply can leave the merge baseline behind.
    // Reuse the validated cloud response independently of that baseline.
    const cacheKey = userId && `sync-fetched:${userId}`;
    const cached = cacheKey ? await this.meta(cacheKey) : null;
    if (cached && cached.revision === head.revision) {
      return { revision: cached.revision, payload: await unpack(cached.payload) };
    }

    const response = await this.request('/rest/v1/rpc/travel_read', { headers, body: {} });
    const payload = await unpack(response.payload);
    if (payload) this.validate(payload);
    if (cacheKey && this.auth?.user?.id === userId) {
      await this.meta(cacheKey, { revision: response.revision, payload: response.payload });
    }
    return { revision: response.revision, payload };
  }
  async writeRemote(revision,payload){return this.request('/rest/v1/rpc/travel_write',{headers:{'Content-Type':'application/json'},body:{expected_revision:revision,new_payload:await pack(payload)}});}
  async meta(key,value) {
    const db=this.engine.store.db,write=value!==undefined,tx=db.transaction('state',write?'readwrite':'readonly'),table=tx.objectStore('state');let result;
    const request=write?table.put(value,key):table.get(key);request.onsuccess=()=>{result=request.result;};
    await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};});return result;
  }
  run(callback) {
    const operation=this.queue.then(()=>navigator.locks?navigator.locks.request('multi-offline-sync',callback):callback());this.queue=operation.catch(()=>{});return operation;
  }
  networkRun(callback){const operation=this.syncQueue.then(()=>navigator.locks?navigator.locks.request('multi-offline-sync-network',callback):callback());this.syncQueue=operation.catch(()=>{});return operation;}
  async request(route,{method='POST',body,headers={},auth=true,retry=true,raw=false}={}) {
    if(!this.configured)throw new Error('云同步尚未配置。');
    if(auth&&(!this.auth||this.auth.expires_at*1000<Date.now()+60000))await this.refreshAuth();
    let response;
    try{response=await this.fetcher(this.origin+route,{method,headers:{apikey:this.config.publishableKey,...(auth?{Authorization:`Bearer ${this.auth.access_token}`}:{'Content-Type':'application/json'}),...headers},body:body instanceof Blob?body:body===undefined?undefined:JSON.stringify(body),credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(20000)});}catch{throw new Error('暂时无法连接同步服务；进度仍保存在本机，联网后重试。');}
    if(response.status===401&&auth&&retry){await this.refreshAuth();return this.request(route,{method,body,headers,auth,retry:false,raw});}
    if(!response.ok){if(response.status===409)return {conflict:true};throw new Error(response.status===400||response.status===401?'登录已失效或邮箱、密码不正确，请重新登录。':response.status===413?'同步空间或文件大小达到免费额度；本机进度已保留。':'同步服务暂不可用，本机进度已保留。');}
    return raw?response:response.status===204?null:response.json();
  }
  saveAuth(auth) {if(!auth?.access_token||!auth.refresh_token||!auth.user?.id)throw new Error('登录响应无效。');this.auth={...auth,expires_at:auth.expires_at??Math.floor(Date.now()/1000)+auth.expires_in};this.storage.setItem(AUTH_KEY,JSON.stringify(this.auth));}
  async refreshAuth() {
    const latest=parse(this.storage.getItem(AUTH_KEY));if(latest?.expires_at*1000>Date.now()+60000){this.auth=latest;return;}
    if(!latest?.refresh_token)throw new Error('请先登录同步账号。');
    const result=await this.request('/auth/v1/token?grant_type=refresh_token',{auth:false,body:{refresh_token:latest.refresh_token}});this.saveAuth(result);
  }
  async signIn(email,password) {
    const result=await this.request('/auth/v1/token?grant_type=password',{auth:false,body:{email,password}});
    const owner=await this.meta('sync-owner');if(owner&&owner!==result.user?.id)throw new Error('这台设备已有另一账号的进度。请先导出备份，并在独立浏览器配置中使用新账号。');
    this.saveAuth(result);await this.meta('sync-owner',result.user.id);return this.sync();
  }
  async signOut() {await this.sync().catch(()=>{});this.storage.removeItem(AUTH_KEY);this.auth=null;this.status('已退出同步账号，本机进度保留。','signed-out');}
  async snapshot() {
    const snapshot=await this.engine.store.snapshot(),state=snapshot.state,recordings={};
    for(const row of snapshot.recordings){const bytes=await row.blob.arrayBuffer();recordings[row.id]={type:row.blob.type,bytes:bytes.byteLength,sha256:sha256(bytes)};}
    for(const [id,row] of Object.entries(state.recordings)){delete row.filename;row.url=`recording:${id}`;}
    state.jobs={};validateState(state);
    await this.refreshContext?.();const ui=parse(this.storage.getItem('multi-offline-ui'))||{};
    const payload={format:'language-room-multi-sync',version:1,state,ui,recordings};
    this.snapshotRevisions??=new WeakMap();if(snapshot.revision!==undefined)this.snapshotRevisions.set(payload,snapshot.revision);return payload;
  }
  async matches(payload){
    await this.refreshContext?.();const revision=this.snapshotRevisions?.get(payload);
    if(revision!==undefined&&this.engine.store.revision)return revision===await this.engine.store.revision()&&equal(payload.ui,parse(this.storage.getItem('multi-offline-ui'))||{});
    return equal(payload,await this.snapshot());
  }
  validate(payload) {
    if(payload?.format!=='language-room-multi-sync'||payload.version!==1||!payload.recordings||Array.isArray(payload.recordings))throw new Error('云端存档格式无效，未覆盖本机。');validateState(payload.state);
    const ids=Object.keys(payload.state.recordings);if(ids.length!==Object.keys(payload.recordings).length)throw new Error('云端录音清单无效。');
    for(const id of ids){const row=payload.recordings[id];if(!row||row.type!==payload.state.recordings[id].type||!Number.isInteger(row.bytes)||row.bytes<=0||row.bytes>8*1024*1024||!/^[a-f0-9]{64}$/.test(row.sha256))throw new Error('云端录音清单无效。');}
    return payload;
  }
  async downloadRecordings(payload) {
    const result=[];for(const [id,row] of Object.entries(payload.recordings)) {
      let blob=await this.engine.store.recording(id);if(!blob||blob.size!==row.bytes||sha256(await blob.arrayBuffer())!==row.sha256){const response=await this.request(`/storage/v1/object/authenticated/travel-recordings/${this.auth.user.id}/${id}.${row.sha256}`,{method:'GET',raw:true});const bytes=await response.arrayBuffer();if(bytes.byteLength!==row.bytes||sha256(bytes)!==row.sha256)throw new Error('云端录音校验失败，未替换本机进度。');blob=new Blob([bytes],{type:row.type});}result.push({id,blob});
    }return result;
  }
  async uploadRecordings(payload,remote) {
    for(const [id,row] of Object.entries(payload.recordings)){if(equal(row,remote?.recordings?.[id]))continue;const blob=await this.engine.store.recording(id);if(!blob||blob.size!==row.bytes||sha256(await blob.arrayBuffer())!==row.sha256)throw new Error('本机录音缺失或校验失败；尚未提交云端进度。');try{await this.request(`/storage/v1/object/travel-recordings/${this.auth.user.id}/${id}.${row.sha256}`,{body:blob,headers:{'Content-Type':row.type.split(';')[0]}});}catch(error){const existing=await this.request(`/storage/v1/object/authenticated/travel-recordings/${this.auth.user.id}/${id}.${row.sha256}`,{method:'GET',raw:true}).catch(()=>null);if(!existing)throw error;const bytes=await existing.arrayBuffer();if(bytes.byteLength!==row.bytes||sha256(bytes)!==row.sha256)throw error;}}
  }
  async apply(payload,recordings) {
    const normalized=normalize(payload,this.engine.base);await this.engine.store.restore(normalized.state,recordings);this.storage.setItem('multi-offline-ui',JSON.stringify(normalized.ui));this.storage.setItem('multi-offline-import-id',crypto.randomUUID());
  }
  // Network work never owns the learning lock. Only short snapshots/commits do.
  sync() {
    if(this.inFlight){this.syncAgain=true;return this.inFlight;}
    const operation=this.networkRun(async()=>{for(let round=0;round<3;round++){this.syncAgain=false;await this.syncLocked();if(!this.syncAgain)break;}});this.inFlight=operation.finally(()=>{this.inFlight=null;});return this.inFlight;
  }
  async syncLocked() {
    if(!this.configured){this.status('云同步等待配置；本机学习和备份可用。','unconfigured');return;}
    if(!this.auth){this.status('登录后自动同步手机和电脑。','signed-out');return;}
    if(!navigator.onLine){this.status('离线学习中 · 联网后自动同步','offline');return;}
    if(!this.canApply()){this.status('本机已保存 · 当前操作结束后同步');return;}
    this.auth=parse(this.storage.getItem(AUTH_KEY))||this.auth;
    const uid=this.auth.user.id,owner=await this.meta('sync-owner');if(owner&&owner!==uid)throw new Error('同步账号与本机进度所属账号不一致。');
    let baseline=await this.meta(`sync-base:${uid}`);
    for(let attempt=0;attempt<3;attempt++) {
      const local=await this.snapshot(),remote=await this.remote(baseline,uid);
      if(remote.payload)this.validate(remote.payload);
      let merged;
      if(!remote.payload)merged=local;
      else if(!baseline&&Object.values(local.state.languages).every(language=>language.reviews.length===0)&&!Object.keys(local.recordings).length)merged=remote.payload;
      else if(equal(local,remote.payload))merged=local;
      else {
        try{merged=mergeProgress(baseline?.localBase??baseline?.payload,local,remote.payload);}catch(error){if(!(error instanceof SyncConflict))throw error;this.conflict={local,remote};this.status('两台设备的同一语言都有改动，请选择要继续的进度；两份都可备份。','conflict');return;}
      }
      const recordings=equal(merged,local)?null:await this.downloadRecordings(merged);
      // Typing may continue while requests are in flight. Do not discard a new draft.
      if(!await this.matches(local)||!this.canApply()){this.status('本机已保存 · 操作结束后继续同步');this.syncAgain=this.canApply();this.schedule();return;}
      let revision=remote.revision;
      if(!equal(merged,remote.payload)) {
        // First save any remote-only blobs locally without replacing the state.
        if(recordings){const tx=this.engine.store.db.transaction('recordings','readwrite');for(const row of recordings)tx.objectStore('recordings').put(row.blob,row.id);await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}
        await this.uploadRecordings(merged,remote.payload);
        if(!await this.matches(local)){this.status('本机已保存 · 继续同步最新进度');this.syncAgain=this.canApply();this.schedule();return;}
        const response=await this.writeRemote(remote.revision,merged);
        if(response.conflict)continue;revision=response.revision;
      }
      const changed=!equal(local,merged);
      const applied=await this.run(async()=>{
        if(this.auth?.user?.id!==uid)return false;
        if(!await this.matches(local)||(changed&&!this.canApply())){
          // Remember both the accepted cloud snapshot and its local parent.
          // A grade during an upload is rebased next time, never overwritten.
          await this.meta(`sync-base:${uid}`,{revision,payload:merged,...(changed?{localBase:local}:{})});
          this.status('云端已接收进度 · 当前操作结束后继续合并');this.syncAgain=this.canApply();this.schedule();return false;
        }
        if(changed)await this.apply(merged,recordings);
        await this.meta(`sync-base:${uid}`,{revision,payload:merged});await this.meta('sync-owner',uid);return true;
      });
      if(!applied)return;
      this.conflict=null;this.status(`已同步 · ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`,'synced');
      if(changed)this.onApply();return;
    }
    this.status('另一台设备正在同步，本机已保存，稍后自动重试。','pending');
  }
  schedule() {clearTimeout(this.timer);this.timer=setTimeout(()=>this.sync().catch(error=>this.status(error.message,'error')),1000);}
  start() {this.interval=setInterval(()=>this.sync().catch(error=>this.status(error.message,'error')),15000);window.addEventListener('online',()=>this.schedule());window.addEventListener('focus',()=>this.schedule());document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')this.schedule();});this.schedule();}
  async conflictBackup(which) {
    if(!this.conflict)throw new Error('没有待处理的冲突。');const payload=which==='local'?this.conflict.local:this.conflict.remote.payload;
    const recordings=await this.downloadRecordings(payload),rows=[];
    for(const row of recordings){const bytes=new Uint8Array(await row.blob.arrayBuffer());let value='';for(let offset=0;offset<bytes.length;offset+=16384)value+=String.fromCharCode(...bytes.subarray(offset,offset+16384));rows.push({id:row.id,type:row.blob.type,sha256:sha256(bytes),data:btoa(value)});}
    return new Blob([JSON.stringify({...normalize(payload,this.engine.base),format:'language-room-multi-backup',version:1,exportedAt:new Date().toISOString(),recordings:rows})],{type:'application/json'});
  }
  resolve(which) {return this.networkRun(async()=>{
    if(!this.conflict)throw new Error('冲突已处理。');const fresh=await this.remote();if(fresh.revision!==this.conflict.remote.revision){this.conflict=null;return this.syncLocked();}
    const local=await this.snapshot();if(!equal(local,this.conflict.local)){this.conflict=null;return this.syncLocked();}
    const payload=which==='local'?local:this.conflict.remote.payload,recordings=await this.downloadRecordings(payload);let revision=fresh.revision;
    if(which==='local'){await this.uploadRecordings(payload,fresh.payload);const result=await this.writeRemote(revision,payload);if(result.conflict){this.conflict=null;return this.syncLocked();}revision=result.revision;}
    const applied=await this.run(async()=>{
      if(!await this.matches(local)||!this.canApply()){this.status('本机有新操作，请重新选择同步版本。','conflict');return false;}
      if(which!=='local')await this.apply(payload,recordings);
      await this.meta(`sync-base:${this.auth.user.id}`,{revision,payload});return true;
    });if(!applied)return;this.conflict=null;this.status('已同步选择的进度','synced');if(which!=='local')this.onApply();
  });}
}
