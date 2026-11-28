import {mnemonicData} from './mnemonic-data.js';
import {escapeHTML as esc} from './core.js';

const valid=row=>mnemonicData.schemaVersion===2&&mnemonicData.method==='cross-language-keyword'&&['user-demonstrated','reviewed'].includes(row.review);
const index=new Map(mnemonicData.rows.filter(valid).map(row=>[row.entryId,row]));
const names={zh:'中文',en:'英语',ja:'日语',ko:'韩语',es:'西班牙语'};
export const mnemonicCoverage=mnemonicData.counts;
export function wordMnemonic(item,languageId) {
  const row=index.get(item?.entryId??item?.id);
  if(!row||row.languageId!==languageId||row.display!==item.display||row.sourceMeaning!==item.meanings?.en)return null;
  return row;
}
export function mnemonicMarkup(item,languageId,ui='zh') {
  const row=wordMnemonic(item,languageId),zh=ui==='zh';
  if(!row)return `<p class="mnemonic-pending" lang="${zh?'zh':'en'}">${zh?'暂无合适的跨语言谐音助记。':'No suitable cross-language sound cue yet.'}</p>`;
  const readings=[...new Set([row.cueReading,row.cueRomanization])].filter(reading=>reading!==row.cueWord);
  const pronunciation=readings.length?'（'+readings.map(esc).join(' / ')+'）':'';
  return `<section class="word-mnemonic" aria-label="${zh?'记忆小故事':'Memory cue'}" lang="zh"><h3>${zh?'记忆小故事':'Memory cue'} <span>${zh?'跨语言谐音':'Cross-language sound link'}</span></h3><p class="mnemonic-cue"><bdi lang="${esc(languageId)}" dir="auto">${esc(row.targetReading)}</bdi> → <span>${esc(names[row.cueLanguage])}</span><bdi lang="${esc(row.cueLanguage)}">${esc(row.cueWord)}${pronunciation}</bdi> · ${esc(row.cueMeaning)}</p><p class="mnemonic-story">${esc(row.story)}</p><p class="mnemonic-note">${zh?'声音相近；原词读音仍听音频。':'Similar sounds; follow the original audio for pronunciation.'}</p></section>`;
}
