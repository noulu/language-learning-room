import { OfflineEngine, CACHE_PREFIX } from './engine.js';
import { openDatabase } from './store.js';
import { exportBackup, readBackup, restoreBackup } from './backup.js';
import { SupabaseSync } from './sync.js';
import { mountStorage } from './storage-ui.js';
import {localize,watchLocale} from './locale.js';
import {ExampleReader} from './example-reader.js';
import {backgroundSync} from './sync-background.js';
const base=new URL('./',location.href),nativeFetch=window.fetch.bind(window),shell=document.querySelector('.app-shell');
const panel=document.createElement('main');panel.className='installer';panel.innerHTML='<p>LANGUAGE ROOM</p><h1>九门语言，打开就学。</h1><p>正在加载程序和当前语言教材，音频在练习时逐条在线播放，无需下载整包。</p><p id="boot-status" role="status">正在打开学习室…</p><button type="button" id="retry-load" hidden>重新打开</button>';document.body.append(panel);
const downloadSection=document.createElement('section');downloadSection.className='offline-download';downloadSection.innerHTML='<h3>离线学习（可选）</h3><p>平时直接在线学习，播放当前词句时才加载音频，不另外保存整包。需要断网学习时，再下载全部九语教材和音频。</p><p id="install-status" role="status">正在检查离线包…</p><progress id="install-progress" max="1" value="0" hidden></progress><button id="download-course" type="button">下载完整离线包</button><p>iPhone 可在 Safari“分享 → 添加到主屏幕”，从图标进入。下载请使用 Wi-Fi，保持页面打开。</p>';
const status=downloadSection.querySelector('#install-status'),progress=downloadSection.querySelector('progress'),download=downloadSection.querySelector('button');
let registration,engine,cache,release,documentPack,manager,storageTools;
export function saveFile(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
const message=text=>{status.textContent=text;};
function controls(syncConfig) {
  const controls=document.createElement('section');controls.className='offline-controls';controls.innerHTML='<div><strong>手机与电脑同步</strong><p id="sync-status" role="status">检查同步状态…</p></div><form id="sync-login"><label>邮箱 <input id="sync-email" type="email" autocomplete="username" required></label><label>密码 <input id="sync-password" type="password" autocomplete="current-password" required></label><button type="submit">登录并同步</button></form><button type="button" id="sync-now">立即同步</button><button type="button" id="sync-signout">退出同步账号</button><div id="sync-conflict" hidden><p>为避免覆盖，已暂停同步。先备份两份进度，再选择继续哪一份。</p><button type="button" id="backup-local-conflict">备份本机版本</button><button type="button" id="backup-cloud-conflict">备份云端版本</button><button type="button" id="choose-local">继续本机版本</button><button type="button" id="choose-cloud">继续云端版本</button></div><button type="button" id="export-backup">导出九语备份</button><button type="button" id="import-backup">导入九语备份</button><input id="backup-file" type="file" accept="application/json,.json" hidden><span id="backup-status" role="status"></span><small>登录后，进度、设置、草稿和私人录音同步至你的专属云存档。离线时先存本机，重新联网后自动同步。两台设备同时离线修改同一语言时，会保留两份并请你选择，绝不静默覆盖。请定期导出备份。</small>';
  document.querySelector('#settings-dialog .panel-heading').after(controls);
  const indicator=document.createElement('p');indicator.className='offline-status';shell.querySelector('.learning-tools').append(indicator);
  manager=new SupabaseSync(engine,syncConfig,{fetcher:nativeFetch,canApply:()=>window.travelCanReload?.()!==false,onStatus:(text,kind)=>{controls.querySelector('#sync-status').textContent=text;indicator.textContent=text;controls.querySelector('#sync-conflict').hidden=kind!=='conflict';controls.querySelector('#sync-login').hidden=Boolean(manager.auth);controls.querySelector('#sync-signout').hidden=!manager.auth;},onApply:()=>{window.multiOffline.restoring=true;location.reload();}});
  window.multiOffline.sync=manager;
  backgroundSync(manager,base);
  let busy=false;const feedback=controls.querySelector('#backup-status');
  try{const receipt=JSON.parse(localStorage.getItem('multi-offline-last-import'));if(receipt&&Number.isInteger(receipt.reviews)&&Number.isInteger(receipt.recordings))feedback.textContent=`最近一次本机导入：${new Date(receipt.at).toLocaleString()}，${receipt.reviews.toLocaleString()} 条练习记录、${receipt.recordings} 份录音。当前保留的各语言历史见下方“已保存的累计学习记录”；云端是否完成请看上方同步状态。`;}catch{}
  const action=callback=>async event=>{event?.preventDefault();if(busy)return;busy=true;try{await callback(event);}catch(error){feedback.textContent=error.message;}finally{busy=false;}};
  controls.querySelector('#sync-login').onsubmit=action(async()=>{const email=controls.querySelector('#sync-email').value,password=controls.querySelector('#sync-password').value;controls.querySelector('#sync-password').value='';controls.querySelector('#sync-login button').focus();await manager.signIn(email,password);});
  controls.querySelector('#sync-now').onclick=action(()=>manager.syncNow());controls.querySelector('#sync-signout').onclick=action(()=>manager.signOut());
  controls.querySelector('#export-backup').onclick=action(async()=>{saveFile(await exportBackup(engine),`language-room-backup-${new Date().toISOString().slice(0,10)}.json`);feedback.textContent='已生成九语备份，请保存文件。';});
  controls.querySelector('#import-backup').onclick=()=>controls.querySelector('#backup-file').click();
  controls.querySelector('#backup-file').onchange=action(async event=>{const file=event.target.files[0];event.target.value='';if(!file)return;feedback.textContent='正在校验备份，请稍候…';try{const payload=await readBackup(file,engine),reviews=Object.values(payload.state.languages).reduce((sum,language)=>sum+language.reviews.length,0);if(!confirm(localize(`备份包含 ${reviews.toLocaleString()} 条练习记录、${payload.recordings.length} 份录音。导入会替换本机进度；登录后自动同步，有冲突时需选择版本。继续前会先导出本机旧备份。确定导入？`))){feedback.textContent='已取消导入，现有进度保留。';return;}saveFile(await exportBackup(engine),`language-room-before-import-${Date.now()}.json`);await manager.run(()=>restoreBackup(engine,payload));location.reload();}catch(error){feedback.textContent=`导入未完成：${error.message} 请保留原备份。`;feedback.scrollIntoView({block:'nearest'});}});
  for(const which of ['local','cloud']) {
    controls.querySelector(`#backup-${which}-conflict`).onclick=action(async()=>saveFile(await manager.conflictBackup(which),`language-room-${which}-${Date.now()}.json`));
    controls.querySelector(`#choose-${which}`).onclick=action(async()=>{if(!confirm(localize(`将继续${which==='local'?'本机':'云端'}版本。选择前会下载另一版本的完整备份，请保存好。是否继续？`)))return;saveFile(await manager.conflictBackup(which==='local'?'cloud':'local'),`language-room-alternate-${Date.now()}.json`);await manager.resolve(which);});
  }
  controls.append(downloadSection);
  storageTools=mountStorage({release,base,cache,registration,section:downloadSection,fetcher:nativeFetch});
  const update=document.createElement('button');update.type='button';update.textContent='有更新 · 安装新版';update.hidden=true;controls.append(update);
  const topUpdate=update.cloneNode(true);topUpdate.textContent='有新版 · 更新网站';shell.querySelector('.top-actions').append(topUpdate);
  watchLocale(controls,indicator,topUpdate);
  window.multiOffline.checkForUpdates=async()=>{
    await registration.update();
    const response=await nativeFetch(new URL('release.json?update-check='+Date.now(),base),{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error(document.documentElement.lang==='en'?'Update check failed. Progress is preserved.':'暂时无法检查更新，学习进度保留。');
    const latest=await response.json(),en=document.documentElement.lang==='en';
    return latest.version===release.version?(en?'Content and website are up to date.':'内容和网站已是最新版。'):(en?'A new release is preparing. Use Update website when it appears; your progress is preserved.':'发现新版，正在准备。更新按钮出现后点击启用；学习进度保留。');
  };
  const notify=()=>{update.hidden=topUpdate.hidden=!registration.waiting;},watch=()=>{registration.installing?.addEventListener('statechange',notify);notify();};watch();registration.addEventListener('updatefound',watch);
  update.onclick=topUpdate.onclick=action(async()=>{if(!registration.waiting)return;if(storageTools?.busy||window.travelCanReload?.()===false){feedback.textContent='请先结束当前操作或存储管理，再更新网站。';return;}await manager.run(async()=>{navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true});registration.waiting.postMessage('activate-update');});});
  manager.start();
}
async function launch() {
  if(engine){location.reload();return;}
  engine=await new OfflineEngine(await openDatabase(),documentPack,base,undefined,{fetcher:nativeFetch}).init();window.multiOffline={engine,release};
  engine.exampleReader=new ExampleReader(engine,base);
  const configResponse=await cache.match(new URL('sync-config.json',base)),syncConfig=await configResponse.json();
  shell.hidden=false;panel.remove();controls(syncConfig);
  window.fetch=(input,options={})=>{const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin===location.origin&&url.pathname.startsWith('/api/')){
    if(url.pathname==='/api/word-example')return engine.exampleReader.handle(url);
    const execute=async()=>{const result=await engine.handle(url,{...options,runLocal:callback=>manager.run(callback)});if(result.ok&&(options.method??'GET')!=='GET')manager.schedule();return result;};
    return url.pathname==='/api/audio'?execute():manager.run(execute);
  }return nativeFetch(input,options);};
  window.addEventListener('storage',event=>{if(event.key==='multi-offline-import-id'){window.multiOffline.restoring=true;location.reload();}});
  await import('./app.js');try{await navigator.storage?.persist?.();}catch{}
}
async function initialize() {
  try {
    if(!isSecureContext||!('serviceWorker'in navigator)||!('indexedDB'in window))throw new Error('请通过HTTPS网址打开；iPhone不能直接打开ZIP安装。');
    registration=await navigator.serviceWorker.register(new URL('service-worker.js',base),{scope:base.pathname,updateViaCache:'none'});
    if(registration.waiting&&navigator.serviceWorker.controller){navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true});registration.waiting.postMessage('activate-update');return;}
    if(!navigator.serviceWorker.controller)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>finish(new Error('离线组件尚未下载完成，请联网重试。')),180000),worker=registration.installing;const finish=error=>{clearTimeout(timer);navigator.serviceWorker.removeEventListener('controllerchange',controlled);worker?.removeEventListener('statechange',changed);error?reject(error):resolve();},controlled=()=>{if(navigator.serviceWorker.controller)finish();},changed=()=>{if(worker.state==='redundant'&&!registration.active)finish(new Error('离线组件下载失败，请联网重试。'));};navigator.serviceWorker.addEventListener('controllerchange',controlled);worker?.addEventListener('statechange',changed);controlled();});
    const response=await nativeFetch(new URL('release.json',base));if(!response.ok)throw new Error('学习包暂时无法加载。');release=await response.json();cache=await caches.open(CACHE_PREFIX+release.version);
    const courseResponse=await cache.match(new URL('course.json',base));if(!courseResponse)throw new Error('应用更新尚未完成，请刷新重试。');documentPack=await courseResponse.json();
    const ready=await cache.match(new URL('offline-ready',base));message(ready&&(await ready.text())===release.version?'上次完整离线校验已通过；可检查实际保存内容。':`当前直接在线学习。完整离线音频约 ${(release.audio.reduce((total,row)=>total+row.bytes,0)/1024/1024).toFixed(0)} MB，教材另占空间；不下载也能使用。`);await launch();
  }catch(error){panel.querySelector('#boot-status').textContent=error.message;panel.querySelector('#retry-load').hidden=false;panel.querySelector('#retry-load').onclick=()=>location.reload();}
}
void initialize();
