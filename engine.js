import { Learning, initialState, publicState, patchState, initializeLearningState } from './lib/learning.js';
import { OfflineContent, knownLanguage } from './content.js';
import { OfflineStore } from './store.js';
import { randomUUID, sha256 } from './crypto.js';
import { requireValue, HttpError } from './lib/errors.js';
import { ParagraphGeneration } from './lib/paragraph-generation.js';
import { publicAsset } from './assets.js';
export const CACHE_PREFIX='language-room-multi-';
export class OfflineEngine {
  constructor(db,document,base=new URL('./',location.href),clock=()=>new Date(),{fetcher=globalThis.fetch.bind(globalThis)}={}) {
    this.document=document; this.base=base; this.content=new OfflineContent(document); this.store=new OfflineStore(db,initialState); this.cacheName=CACHE_PREFIX+document.version;
    this.media={available:(_id,entry,kind)=>Boolean(document.audio[`${entry.id}:${kind}`]),hasPreparedSentence:(_id,entry)=>Boolean(document.audio[`${entry.id}:sentence`]?.metadata.decodeVerified),revision:(_id,entry)=>({offlineAudio:['word','sentence'].map(kind=>document.audio[`${entry.id}:${kind}`]?.sha256||null)})};
    this.fetcher=fetcher;this.loadedPacks=new Map();this.learning=new Learning(this.store,this.content,this.media,clock);
  }
  async ensureLanguage(id) {
    knownLanguage(id);if(this.loadedLanguage===id)return;
    const document=this.document.languages[id];let pack=this.loadedPacks.get(id);
    if(!pack){const cache=await caches.open(this.cacheName),response=document.asset?await publicAsset(this.cacheName,this.base,document.asset,{fetcher:this.fetcher}):await cache.match(new URL(document.file,this.base));if(!response)throw new Error('这门语言的教材尚未离线保存，请联网重试。');pack=await response.json();}
    this.loadedPacks.delete(id);this.loadedPacks.set(id,pack);while(this.loadedPacks.size>2)this.loadedPacks.delete(this.loadedPacks.keys().next().value);
    if(this.loadedLanguage)this.content.install(this.loadedLanguage,this.document.languages[this.loadedLanguage]);this.content.install(id,pack);this.document.audio=pack.audio;this.loadedLanguage=id;
    for(const cachedId of this.learning.recentWords.indexes.keys())if(!this.loadedPacks.has(cachedId))this.learning.recentWords.indexes.delete(cachedId);
  }
  syncRuntimeParagraphs(){
    this.content.runtimeParagraphs=new Map(Object.entries(this.store.state.languages).map(([id,language])=>[id,Object.values(language.generatedParagraphs??{}).filter(entry=>this.content.runtimeParagraphValid(id,entry))]));
  }
  async refreshSelected(){const id=this.store.state.selectedLanguage;await this.ensureLanguage(id);this.syncRuntimeParagraphs();await this.learning.refreshContent(id);}
  async init() { await this.store.init(); await this.store.transaction(state=>initializeLearningState(state)); await this.refreshSelected();this.paragraphs=new ParagraphGeneration(this.store,this.content,this.learning); return this; }
  catalog() { return {providers:{paragraphGeneration:this.paragraphs.provider.info()},languages:Object.entries(this.document.languages).map(([id,pack])=>({id,...pack.info,availableStages:[1,2,3,4],...pack.counts,assessmentAvailable:Boolean(pack.assessment),version:pack.course.version,sources:[...pack.course.sources,...(pack.sentences.sources??[]),...(pack.paragraphs.sources??[])],audioNote:'音频逐条在线播放；可选下载离线包。'}))}; }
  async audio(parsed,run=callback=>callback(),signal){
    const id=knownLanguage(parsed.searchParams.get('languageId')),entryId=parsed.searchParams.get('entryId'),kind=parsed.searchParams.get('kind')||'word',sessionId=parsed.searchParams.get('sessionId'),taskId=parsed.searchParams.get('taskId'),example=parsed.searchParams.get('example');
    requireValue(['word','sentence'].includes(kind),'音频种类无效。');requireValue(!parsed.searchParams.has('example')||example==='1'&&kind==='sentence'&&sessionId&&taskId,'例句语音参数无效。');
    const selected=example&&this.exampleReader?await this.exampleReader.select(sessionId,taskId):null;
    const validate=()=>{
      if(selected){const session=this.store.state.sessions[sessionId];requireValue(session?.languageId===id&&session.task?.id===taskId&&!this.learning.needsRefresh(session)&&selected.example?.hasAudio&&selected.example.entryId===entryId,'例句题目已更换。',409,'task_conflict');}
      else if(example)this.learning.validateExampleAudio(id,entryId,sessionId,taskId);else this.learning.validateAudioTask(id,entryId,sessionId,taskId);
    };
    const record=await run(async()=>{await this.store.refresh({reuse:true});await this.ensureLanguage(id);this.syncRuntimeParagraphs();validate();const row=this.document.audio[`${entryId}:${kind}`];requireValue(row,'这项音频尚未准备。',404,'audio_unavailable');return row;});
    const response=await publicAsset(this.cacheName,this.base,record,{save:false,fetcher:this.fetcher,signal}),bytes=await response.arrayBuffer();
    await run(async()=>{await this.store.refresh({reuse:true});await this.ensureLanguage(id);validate();if(!example&&(kind==='word'||['recent-words','recent-paragraphs'].includes(this.store.state.sessions[sessionId]?.purpose)))await this.learning.audioReady(id,entryId,record.metadata,sessionId,taskId);});
    return new Response(bytes,{headers:{'Content-Type':record.type,'Cache-Control':'no-store'}});
  }
  async handle(url,options={}) {
    const parsed=new URL(url,this.base),path=parsed.pathname,method=options.method||'GET',data=()=>JSON.parse(options.body||'{}');
    try {
      if(path==='/api/audio')return await this.audio(parsed,options.runLocal,options.signal);
      await this.store.refresh({reuse:true});let requested=this.store.state.selectedLanguage;
      if(method==='POST'&&path!=='/api/recording'){const row=data();requested=row.languageId??this.store.state.sessions[row.sessionId]?.languageId??requested;}
      if(method==='PATCH')requested=data().selectedLanguage??requested;
      if(path.startsWith('/api/session/'))requested=this.store.state.sessions[path.split('/').at(-1)]?.languageId??requested;
      requested=parsed.searchParams.get('languageId')??requested;await this.ensureLanguage(requested);this.syncRuntimeParagraphs();let result,status=200;
      if(path==='/api/catalog')result=this.catalog();
      else if(path==='/api/state'&&method==='GET')result=publicState(this.store.state,this.learning.clock(),this.content);
      else if(path==='/api/state'&&method==='PATCH')result=await this.store.transaction(state=>patchState(state,data(),this.learning.clock(),this.content));
      else if(path==='/api/session'&&method==='POST')result=await this.paragraphs.ensure(await this.learning.start(data()));
      else if(path==='/api/paragraphs/generate'&&method==='POST'){
        const row=data();requireValue(row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).every(key=>['sessionId','taskId'].includes(key))&&typeof row.sessionId==='string'&&(row.taskId===null||typeof row.taskId==='string'),'生成请求无效。');
        result=await this.paragraphs.generate(row.sessionId,row.taskId);
      }
      else if(/^\/api\/session\/[A-Za-z0-9_-]+$/.test(path)&&method==='GET')result=await this.learning.get(path.split('/').at(-1));
      else if(path==='/api/assessment/session'&&method==='POST')result=await this.learning.startAssessment(data());
      else if(path==='/api/review'&&method==='POST'){const reviewed=await this.learning.review(data());result={...await this.paragraphs.ensure(reviewed),...(reviewed.review?{review:reviewed.review}:{})};}
      else if(path==='/api/undo'&&method==='POST')result=await this.learning.undo(data());
      else if(path==='/api/word-example'&&method==='GET')result=this.learning.wordExample(parsed.searchParams.get('sessionId'),parsed.searchParams.get('taskId'));
      else if(path==='/api/lookup') {
        const id=knownLanguage(parsed.searchParams.get('languageId')),entry=this.content.entry(id,parsed.searchParams.get('entryId')),sentenceId=parsed.searchParams.get('sentenceId');
        const sentence=sentenceId?this.content.eligible(id,3).find(row=>row.sentence?.id===sentenceId)?.sentence:null;
        const tokens=sentence?.tokens?.filter(token=>token.entryId===entry.id||token.lemma===entry.lemma)||[];
        result={entry,context:sentenceId?{status:tokens.some(token=>token.function)?'annotated':'unavailable',tokens}:undefined};
      } else if(path==='/api/recording'&&method==='POST') {
        const blob=options.body,sessionId=parsed.searchParams.get('sessionId'),taskId=parsed.searchParams.get('taskId');
        requireValue(blob instanceof Blob&&blob.size>0&&blob.size<=8*1024*1024,'录音为空或超过8MB。',413,'recording_too_large'); requireValue(['audio/webm','audio/mp4','audio/ogg','audio/wav','audio/mpeg'].includes(blob.type.split(';')[0]),'录音格式不支持。',415,'unsupported_media');
        const id=randomUUID(),url=new URL(`local-recording/${id}`,this.base).href;
        result=await this.store.transaction(state=>{const session=state.sessions[sessionId];requireValue(session?.task?.id===taskId&&session.stage===4,'录音须关联当前输出题。',409,'task_conflict');const record={id,sessionId,taskId,type:blob.type,url,createdAt:this.learning.clock().toISOString()};state.recordings[id]=record;return record;},{id,blob});status=201;
      } else throw new HttpError(404,'not_found','此旅行版没有此接口。');
      if(result?.task?.runtimeGenerated&&!this.document.audio[`${result.task.entryId}:sentence`]){
        result.task.audio.sentence=null;result.task.deviceSpeech=true;
      }
      return new Response(JSON.stringify(result),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    } catch(error) { return new Response(JSON.stringify({error:{code:error.code||'offline_error',message:error.name==='QuotaExceededError'?'设备空间不足，请先备份并释放空间。':error.message}}),{status:error.status||500,headers:{'Content-Type':'application/json'}}); }
  }
}
