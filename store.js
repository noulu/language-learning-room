// Only the current learning state belongs on the interaction path. Historical
// idempotency receipts are read by task ID, in the same atomic transaction.
export const DB_NAME='language-room-multi-offline-v1';
const finished=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new Error('保存失败，未提交评分。'));tx.onerror=()=>{};});
export function openDatabase(){return new Promise((resolve,reject)=>{
  const request=indexedDB.open(DB_NAME,2);let abandoned=false;
  request.onupgradeneeded=()=>{
    const db=request.result,tx=request.transaction;
    if(!db.objectStoreNames.contains('state'))db.createObjectStore('state');
    if(!db.objectStoreNames.contains('recordings'))db.createObjectStore('recordings');
    const receipts=db.createObjectStore('receipts'),state=tx.objectStore('state'),read=state.get('current');
    // The upgrade commits all receipts and the compact state together, or none.
    read.onsuccess=()=>{if(read.result){const current=read.result;for(const [id,row] of Object.entries(current.receipts??{}))receipts.put(row,id);current.receipts={};state.put(current,'current');}};
  };
  request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();if(abandoned)db.close();else resolve(db);};
  request.onerror=()=>reject(request.error);
  request.onblocked=()=>{abandoned=true;reject(new Error('请关闭其他学习室页面后重新打开，原进度保留。'));};
});}
export class OfflineStore{
  constructor(db,initial){this.db=db;this.initial=initial;}
  async init(){await this.transaction(s=>s);return this;}
  async refresh({reuse=false}={}){
    const tx=this.db.transaction('state','readonly'),done=finished(tx),table=tx.objectStore('state');
    const cached=this.state,cachedRevision=this.loadedRevision,stamp=table.get('state-revision');let state,revision;
    const readState=()=>{const read=table.get('current');read.onsuccess=()=>{state=read.result||this.initial();};};
    stamp.onsuccess=()=>{
      revision=stamp.result;
      // Check the revision and, if needed, read state in the same transaction.
      if(reuse){if(cached&&revision&&revision===cachedRevision)state=cached;else readState();}
    };
    if(!reuse)readState();
    await done;this.state=state;this.loadedRevision=revision;return state;
  }
  async transaction(fn,recording,receiptKeys=()=>[]){
    const tx=this.db.transaction(recording?['state','receipts','recordings']:['state','receipts'],'readwrite'),done=finished(tx),table=tx.objectStore('state'),receipts=tx.objectStore('receipts');let result,draft,compact,revision,callbackError;
    const apply=()=>{try{
      // IndexedDB already supplies a detached copy. Do not clone it a second time.
      result=fn(draft);if(result?.then)throw Error('Offline state callbacks must be synchronous');
      for(const [id,row] of Object.entries(draft.receipts))receipts.put(row,id);
      compact={...draft,receipts:{}};table.put(compact,'current');
      revision=crypto.randomUUID();table.put(revision,'state-revision');
      if(recording)tx.objectStore('recordings').put(recording.blob,recording.id);
    }catch(error){callbackError=error;tx.abort();}};
    const read=table.get('current');read.onsuccess=()=>{try{
      draft=read.result||this.initial();draft.receipts??={};
      const keys=[...new Set(receiptKeys(draft).filter(id=>typeof id==='string'))];let pending=keys.length;
      if(!pending){apply();return;}
      for(const id of keys){const receipt=receipts.get(id);receipt.onsuccess=()=>{if(receipt.result)draft.receipts[id]=receipt.result;if(!--pending)apply();};}
    }catch(error){callbackError=error;tx.abort();}};
    try{await done;}catch(error){throw callbackError||error;}this.state=compact;this.loadedRevision=revision;return structuredClone(result);
  }
  async recording(id){const tx=this.db.transaction('recordings','readonly'),done=finished(tx),read=tx.objectStore('recordings').get(id);let blob;read.onsuccess=()=>{blob=read.result;};await done;return blob;}
  async revision(){const tx=this.db.transaction('state','readonly'),done=finished(tx),read=tx.objectStore('state').get('state-revision');let revision;read.onsuccess=()=>{revision=read.result;};await done;return revision;}
  async snapshot(){
    const tx=this.db.transaction(['state','receipts','recordings'],'readonly'),done=finished(tx);let state,revision;const receipts={},recordings=[];
    const stamp=tx.objectStore('state').get('state-revision');stamp.onsuccess=()=>{revision=stamp.result;};
    const read=tx.objectStore('state').get('current');read.onsuccess=()=>{state=read.result;};
    const scan=(name,visit)=>{const table=tx.objectStore(name),keys=table.getAllKeys(),values=table.getAll();values.onsuccess=()=>values.result.forEach((value,i)=>visit(keys.result[i],value));};
    scan('receipts',(key,value)=>{receipts[key]=value;});scan('recordings',(key,value)=>recordings.push({id:key,blob:value}));
    await done;if(state)state.receipts=receipts;return {state,recordings,revision};
  }
  async restore(state,recordings){
    const tx=this.db.transaction(['state','receipts','recordings'],'readwrite'),done=finished(tx),receipts=tx.objectStore('receipts');receipts.clear();
    for(const [id,row] of Object.entries(state.receipts))receipts.put(row,id);
    const compact={...state,receipts:{}};tx.objectStore('state').put(compact,'current');
    const revision=crypto.randomUUID();tx.objectStore('state').put(revision,'state-revision');
    const table=tx.objectStore('recordings');table.clear();for(const row of recordings)table.put(row.blob,row.id);
    await done;this.state=structuredClone(compact);this.loadedRevision=revision;
  }
}
