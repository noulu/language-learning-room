// Three-way merge: independent languages merge; conflicting learning branches
// remain intact and require a choice. Never silently overwrite either history.
import { sameJSON as same } from './sync-delta.js';
const clone=value=>value===undefined?undefined:structuredClone(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const learning=language=>{
  if(!language)return language;
  const {stagePositions,...progress}=language;
  return progress;
};
export class SyncConflict extends Error { constructor(paths){super('两台设备修改了同一份学习记录，两份进度均已保留。');this.name='SyncConflict';this.paths=paths;} }
export function mergeProgress(base,local,remote) {
  const conflicts=[];
  const localLanguages=local.state.languages,remoteLanguages=remote.state.languages;
  const sources=new Map();
  for(const language of Object.keys(localLanguages)){
    const before=learning(base?.state.languages[language]);
    const left=learning(localLanguages[language]),right=learning(remoteLanguages[language]);
    if(same(left,right)||same(before,right))sources.set(language,'local');
    else if(same(before,left))sources.set(language,'remote');
  }
  function merge(previous,left,right,path=[]) {
    if(same(left,right))return clone(left);
    if(same(previous,left))return clone(right);
    if(same(previous,right))return clone(left);
    const key=path.join('.');
    if(key==='state.selectedLanguage'||key==='state.selectedStage'||key==='state.undoSlot')return clone(left);
    if(path.length===3&&path[0]==='state'){
      if(path[1]==='languages'){
        const source=sources.get(path[2]);
        if(source)return clone(source==='local'?left:right);
        conflicts.push(key);return clone(left);
      }
      // Opening a lesson can replace an ungraded task without advancing learning.
      // Retain the task/cursor belonging to the branch whose learning advanced.
      const language=path[1]==='activeSessions'?path[2].split(':')[0]:
        path[1]==='sessions'?(left?.languageId??right?.languageId):undefined;
      const source=sources.get(language);
      if(source)return clone(source==='local'?left:right);
    }
    if(object(left)&&object(right)&&(previous===undefined||object(previous))) {
      const result={};for(const child of new Set([...Object.keys(previous??{}),...Object.keys(left),...Object.keys(right)])){const value=merge(previous?.[child],left[child],right[child],[...path,child]);if(value!==undefined)result[child]=value;}return result;
    }
    conflicts.push(key);return clone(left);
  }
  const result=merge(base,local,remote);if(conflicts.length)throw new SyncConflict(conflicts);
  // One-step undo snapshots cannot safely span independently merged branches.
  if(!same(local.state,remote.state)&&!same(base?.state,local.state)&&!same(base?.state,remote.state))delete result.state.undoSlot;
  return result;
}
