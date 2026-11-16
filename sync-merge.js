// Three-way merge: independent languages merge; conflicting learning branches
// remain intact and require a choice. Never silently overwrite either history.
import { sameJSON as same } from './sync-delta.js';
const clone=value=>value===undefined?undefined:structuredClone(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
export class SyncConflict extends Error { constructor(paths){super('两台设备修改了同一份学习记录，两份进度均已保留。');this.name='SyncConflict';this.paths=paths;} }
export function mergeProgress(base,local,remote) {
  const conflicts=[];
  function merge(previous,left,right,path=[]) {
    if(same(left,right))return clone(left);
    if(same(previous,left))return clone(right);
    if(same(previous,right))return clone(left);
    const key=path.join('.');
    if(key==='state.selectedLanguage'||key==='state.selectedStage'||key==='state.undoSlot'||path[0]==='ui')return clone(left);
    if(path.length===3&&path[0]==='state'&&path[1]==='languages'){conflicts.push(key);return clone(left);}
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
