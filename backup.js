import { sha256 } from './crypto.js';
export const LANGUAGE_IDS=['en','ja','ko','es','fr','ru','ar','id','hi'];
const uuid=/^[a-f0-9-]{36}$/i;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const check=(condition,message)=>{if(!condition)throw new Error(message);};
export function validateState(state) {
  check(state?.schemaVersion===1&&LANGUAGE_IDS.includes(state.selectedLanguage)&&[1,2,3,4].includes(state.selectedStage),'存档格式无效。');
  for(const key of ['languages','sessions','activeSessions','requests','receipts','recordings','jobs','preferences'])check(object(state[key]),'存档缺少必要字段。');
  check(Object.keys(state.languages).length===LANGUAGE_IDS.length&&Object.keys(state.languages).every(id=>LANGUAGE_IDS.includes(id)),'存档必须包含九门语言。');
  check(Number.isInteger(state.preferences.dailyGoal)&&state.preferences.dailyGoal>=1&&state.preferences.dailyGoal<=1000,'每日目标无效。');
  const limits = state.preferences.newVocabularyGoals;
  if (limits !== undefined) {
    check(object(limits) && Object.entries(limits).every(([id, limit]) =>
      LANGUAGE_IDS.includes(id) && Number.isInteger(limit) && limit >= 0 && limit <= 1000), '每日新词设置无效。');
  }
  const today = state.preferences.newVocabularyToday;
  if (today !== undefined) {
    check(object(today) && Object.entries(today).every(([id, row]) => LANGUAGE_IDS.includes(id) && object(row) &&
      /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isInteger(row.goal) && row.goal > 0 && row.goal <= 1000), '今日加学设置无效。');
  }
  for(const id of LANGUAGE_IDS) {
    const language=state.languages[id];check(Array.isArray(language.reviews)&&object(language.cards)&&object(language.rewards)&&object(language.stagePositions)&&Number.isFinite(language.xp),'学习记录无效。');
    for(const review of language.reviews)check([1,2,3,4].includes(review.rating)&&Number.isFinite(Date.parse(review.reviewedAt))&&review.entryId?.startsWith(`${id}:`)&&uuid.test(review.taskId),'评分记录无效。');
    for(const card of Object.values(language.cards))check(Number.isFinite(Date.parse(card.due))&&[0,1,2,3].includes(card.state)&&['stability','difficulty','elapsed_days','scheduled_days','reps','lapses'].every(key=>Number.isFinite(card[key])),'复习安排无效。');
  }
  for(const [id,session] of Object.entries(state.sessions))check(uuid.test(id)&&id===session.id&&LANGUAGE_IDS.includes(session.languageId)&&[1,2,3,4].includes(session.stage)&&(!session.task||uuid.test(session.task.id)),'会话无效。');
  for(const [id,record] of Object.entries(state.recordings))check(uuid.test(id)&&record.id===id&&['audio/webm','audio/mp4','audio/ogg','audio/wav','audio/mpeg'].includes(record.type?.split(';')[0]),'录音元数据无效。');
  const inspect=value=>{if(!object(value)&&!Array.isArray(value))return;for(const [key,row] of Object.entries(value)){check(!['__proto__','prototype','constructor'].includes(key),'存档包含无效字段。');inspect(row);}};inspect(state);
  return state;
}
export function normalize(payload,base) {
  const result=structuredClone(payload);validateState(result.state);
  for(const [id,record] of Object.entries(result.state.recordings)){delete record.filename;record.url=new URL(`local-recording/${id}`,base).href;}
  result.ui=object(result.ui)?result.ui:{};result.ui.items||={};
  for(const item of Object.values(result.ui.items)){item.audioHeard=false;if(item.recordServerURL){const id=item.recordServerURL.split('/').at(-1);item.recordServerURL=Object.hasOwn(result.state.recordings,id)?new URL(`local-recording/${id}`,base).href:null;}}
  delete result.ui.refreshJob;delete result.ui.pendingUndos;return result;
}
export async function exportBackup(engine) {
  const snapshot=await engine.store.snapshot(),recordings=[];
  for(const row of snapshot.recordings){const bytes=new Uint8Array(await row.blob.arrayBuffer());let text='';for(let offset=0;offset<bytes.length;offset+=16384)text+=String.fromCharCode(...bytes.subarray(offset,offset+16384));recordings.push({id:row.id,type:row.blob.type,sha256:sha256(bytes),data:btoa(text)});}
  const ui=JSON.parse(localStorage.getItem('multi-offline-ui')||'{}');
  return new Blob([JSON.stringify({format:'language-room-multi-backup',version:1,exportedAt:new Date().toISOString(),courseVersion:engine.document.version,state:snapshot.state,ui,recordings})],{type:'application/json'});
}
export async function readBackup(file,engine) {
  check(file.size<=128*1024*1024,'备份超过128MB。');const payload=JSON.parse(await file.text());
  check(payload.format==='language-room-multi-backup'&&payload.version===1,'这不是九语学习室的备份。');validateState(payload.state);
  check(Array.isArray(payload.recordings)&&payload.recordings.length===Object.keys(payload.state.recordings).length,'备份录音数量不匹配。');
  const seen=new Set(),recordings=[];
  for(const row of payload.recordings){check(uuid.test(row.id)&&!seen.has(row.id)&&Object.hasOwn(payload.state.recordings,row.id)&&typeof row.data==='string'&&row.data.length<=12*1024*1024,'备份录音无效。');seen.add(row.id);const bytes=Uint8Array.from(atob(row.data),char=>char.charCodeAt(0));check(bytes.length>0&&bytes.length<=8*1024*1024&&sha256(bytes)===row.sha256&&row.type===payload.state.recordings[row.id].type,'备份录音校验失败。');recordings.push({id:row.id,blob:new Blob([bytes],{type:row.type})});}
  return {...normalize(payload,engine.base),recordings};
}
export async function restoreBackup(engine,payload) {
  await engine.store.restore(payload.state,payload.recordings);window.multiOffline.restoring=true;
  localStorage.setItem('multi-offline-ui',JSON.stringify(payload.ui));
  localStorage.setItem('multi-offline-last-import',JSON.stringify({at:new Date().toISOString(),reviews:Object.values(payload.state.languages).reduce((sum,language)=>sum+language.reviews.length,0),recordings:payload.recordings.length}));
  localStorage.setItem('multi-offline-import-id',crypto.randomUUID());await engine.refreshSelected();
}
