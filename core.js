export const languageNames = { en: 'English', ja: '日本語', ko: '한국어', es: 'Español', fr: 'Français', ru: 'Русский', ar: 'العربية', id: 'Bahasa Indonesia', hi: 'हिन्दी · 印地语', zh: '中文' };

export function shortcutAction(event, { revealed, busy, hasTask, dialogOpen, canUndo = false, canPlay = false, recording = false, canRevealWhileSaving = false }) {
  const target = event.target;
  if (event.repeat || event.isComposing || event.altKey || dialogOpen || recording) return null;
  if (target?.closest?.('input, textarea, select, button, a, [contenteditable], [role="textbox"]')) return null;
  const space = event.code === 'Space' || event.key === ' ';
  if (busy) return canRevealWhileSaving && hasTask && !revealed && !event.ctrlKey && !event.metaKey && space ? { type: 'reveal' } : null;
  const undoKey = event.key === 'Backspace' && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  const undoZ = !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.code === 'KeyZ' || String(event.key).toLowerCase() === 'z');
  if ((undoKey || undoZ) && canUndo) return { type: 'undo' };
  if (event.ctrlKey || event.metaKey || !hasTask) return null;
  if (!event.shiftKey && canPlay && (event.code === 'KeyS' || String(event.key).toLowerCase() === 's')) return { type: 'replay' };
  if (space) return revealed ? null : { type: 'reveal' };
  if (revealed && /^[1-4]$/.test(event.key)) return { type: 'rate', rating: Number(event.key) };
  return null;
}

export function translation(values, helper) {
  if (!values || typeof values !== 'object') return { text: '', language: helper };
  if (values[helper]) return { text: values[helper], language: helper };
  const fallback = ['en', 'zh', ...Object.keys(values)].find(key => values[key]);
  return { text: fallback ? values[fallback] : '', language: fallback || helper };
}

export function progressValues(progress = {}, stateLanguage = {}, dailyGoal = 20) {
  const daily = progress.daily || stateLanguage.daily || {};
  const completed = Number(daily.completed) || 0;
  const goal = Number(daily.goal ?? dailyGoal) || 20;
  const xp = Number(progress.xp ?? stateLanguage.xp) || 0;
  const level = Number(progress.level ?? stateLanguage.level) || 1;
  const levelProgress = progress.levelProgress || stateLanguage.levelProgress;
  return { completed, goal, xp, level, current: levelProgress ? Number(levelProgress.current) || 0 : null, required: levelProgress ? Number(levelProgress.required) || 1 : null };
}

export const adaptiveScaleLabels = {
  zh: ['起步', '基础', '日常', '进阶', '挑战'],
  en: ['Starting', 'Basic', 'Everyday', 'Advanced', 'Challenge']
};

export function adaptiveValues(progress = {}, languageState = {}, stage, locale = 'zh', sessionMatches = true) {
  const labels = adaptiveScaleLabels[locale] || adaptiveScaleLabels.zh;
  const expectedStage = Number(stage);
  const current = progress?.adaptive;
  const saved = languageState?.adaptiveByStage?.[String(expectedStage)];
  const valid = value => value && typeof value.score === 'number' && Number.isFinite(value.score) && value.score >= 1 && value.score <= 5 && value.estimated !== false && (!value.basis || value.basis === 'self-rating') && (value.minScore === undefined || value.minScore === 1) && (value.maxScore === undefined || value.maxScore === 5);
  const value = [
    sessionMatches && Number(current?.stage) === expectedStage ? current : null,
    saved && (saved.stage === undefined || Number(saved.stage) === expectedStage) ? saved : null
  ].find(valid);
  if (!value) return { known: false, score: null, label: locale === 'en' ? 'Awaiting estimate' : '待估计', confidence: '', scoreText: '', contentLimited: false, limitText: '' };
  const band = Math.max(0, Math.min(4, Math.round(value.score) - 1));
  const confidenceTranslations = { '正在试探': 'Probing', '证据较少': 'Limited evidence', '初步估计': 'Tentative estimate', '初步自评依据': 'Tentative self-rating evidence', '逐渐稳定': 'Becoming steadier', '待试探': 'Awaiting practice', '试探中': 'Probing', '逐步确认': 'Being confirmed' };
  // Use one consistent set of UI scale names. Keep a supplied description only
  // when it extends the same band (e.g. 日常短句), rather than renaming its scale.
  const label = typeof value.label === 'string' && value.label.startsWith(labels[band]) ? value.label : labels[band];
  const confidence = locale === 'en' ? confidenceTranslations[value.confidenceLabel] || (/^[\x00-\x7F]+$/.test(value.confidenceLabel || '') && value.confidenceLabel ? value.confidenceLabel : value.probing ? 'Probing' : 'Self-rating estimate') : value.confidenceLabel || (value.probing ? '正在试探' : '置信状态待积累');
  return {
    known: true, score: value.score, label, confidence,
    scoreText: `${Number(value.score.toFixed(1))} / 5`,
    contentLimited: value.contentLimited === true,
    limitText: value.contentLimited === true ? (locale === 'en' ? 'Current content limit · more suitable items needed' : '当前内容上限 · 需要更多合适题目') : ''
  };
}

export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export function sentenceParts(sentence, entryId, display) {
  const text = typeof sentence === 'string' ? sentence : sentence?.text || '';
  const tokens = typeof sentence === 'object' && Array.isArray(sentence?.tokens) ? sentence.tokens.filter(token => token.text) : [];
  const parts = [];
  let cursor = 0;
  for (const token of tokens) {
    const start = text.indexOf(token.text, cursor);
    if (start < cursor) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: token.text, entryId: token.entryId || (token.text === display ? entryId : null) });
    cursor = start + token.text.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

export function reviewSentenceParts(text,targets,languageId){
  const ranges=[];
  for(const target of targets??[]){
    const surface=target.surface??target.display;if(!surface)continue;
    const escaped=surface.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const boundary=['ja','ko','ar'].includes(languageId)?'':'(?<![\\p{L}\\p{N}\\p{M}])',after=boundary?'(?![\\p{L}\\p{N}\\p{M}])':'';
    for(const match of text.matchAll(new RegExp(boundary+escaped+after,'giu')))ranges.push({start:match.index,end:match.index+match[0].length,entryId:target.entryId});
  }
  ranges.sort((a,b)=>a.start-b.start||b.end-a.end);const parts=[];let cursor=0;
  for(const range of ranges){if(range.start<cursor)continue;if(range.start>cursor)parts.push({text:text.slice(cursor,range.start)});parts.push({text:text.slice(range.start,range.end),entryId:range.entryId,reviewTarget:true});cursor=range.end;}
  if(cursor<text.length)parts.push({text:text.slice(cursor)});return parts;
}

function requestFailure(status, statusText, data) {
  const error = new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `${status} ${statusText}`);
  error.status = status; error.code = data.error?.code;
  return error;
}

async function readPreparedReview(response, onPrepared) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error('评分保存结果未收到，请重试。');
      pending += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const data = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (data.error) throw requestFailure(data.status, '', data);
        if (data.result) return data.result;
        if (data.prepared) onPrepared(data.prepared);
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function request(path, { onPrepared, ...options } = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  if (onPrepared && response.ok && response.body && response.headers.get('content-type') === 'application/x-ndjson') {
    return readPreparedReview(response, onPrepared);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw requestFailure(response.status, response.statusText, data);
  return data;
}

// Word counts are measured separately from frequency, XP and adaptive difficulty.
export function assessmentCanStart(value={}) {
  return value.needsNewItems!==true&&(value.roundComplete!==true||value.nextRoundReady===true);
}
export function vocabularyValues(progress = {}, languageState = {}, locale = 'zh', sessionMatches = true) {
  const en=locale==='en';
  const candidates=[sessionMatches?progress.vocabulary:null,languageState.vocabulary];
  const overall=candidates.find(v=>v?.scope==='source-qualified-common-word-forms'&&v.unit==='qualified-independent-word-form'&&Number.isInteger(v.populationCount)&&v.populationCount>0&&Number.isInteger(v.sampleCount)&&v.sampleCount>=0&&Number.isInteger(v.bandCount)&&v.bandCount>0);
  if(overall){
    const hasEstimate=Number.isInteger(overall.estimate)&&Number.isInteger(overall.lower)&&Number.isInteger(overall.upper)&&overall.lower>=0&&overall.estimate>=overall.lower&&overall.estimate<=overall.upper&&overall.upper<=overall.populationCount&&overall.coveredBands===overall.bandCount;
    const status=overall.status==='stabilizing'?(en?'Becoming stable':'趋于稳定'):overall.status==='rough'?(en?'Rough estimate':'粗估'):(en?'Calibrating':'正在校准');
    const count=overall.roundSampleCount??overall.sampleCount,target=overall.targetSamples||36;
    return {headingText:en?'Vocabulary level estimate':'词汇水平估计',estimateText:hasEstimate?(en?`Know about ${overall.estimate} words`:`估计认识约 ${overall.estimate} 词`):(en?'Awaiting estimate':'待估计'),
      recalledText:`${status} · ${en?'This round':'本轮抽测'} ${count}/${target}`,
      rangeText:hasEstimate?(en?`Reference range ${overall.lower}–${overall.upper} words${overall.atFrameworkLimit?' · Lower-frequency tail unmeasured':''}`:`参考范围 ${overall.lower}–${overall.upper} 词${overall.atFrameworkLimit?' · 更低频词未测':''}`):(en?`${overall.coveredBands}/${overall.bandCount} frequency bands sampled`:`已覆盖 ${overall.coveredBands}/${overall.bandCount} 个频段`),
      detailText:en?`Self-rated independent word forms from a broad sourced frequency framework (${overall.populationCount} forms). Not word families or all words; the lower-frequency tail is unmeasured. Languages are not directly comparable. Self-recalled ${overall.recalledCount} practiced forms. ${overall.needsNewItems?'Fresh measurement words needed.':''}`:`按较宽常用词频范围的有源独立词形抽测（框架 ${overall.populationCount} 词形），不是词族或全语言词汇量；更低频尾部未测，不同语言不直接比较。已练词义自评能回忆 ${overall.recalledCount} 词形。${overall.needsNewItems?'本批新测量词已用完，等待补充。':''}`,
      progressValue:count,progressMax:target,overall:true,needsNewItems:overall.needsNewItems===true,roundComplete:overall.roundComplete===true,nextRoundReady:overall.nextRoundReady===true};
  }
  const valid = v => v?.scope === 'current-course-entries' && v?.unit === 'word-entry' && Number.isInteger(v.coverageCount) && v.coverageCount >= 0 && Number.isInteger(v.recalledCount) && v.recalledCount >= 0 && v.recalledCount <= v.coverageCount;
  const value = [sessionMatches ? progress.vocabulary : null, languageState.vocabulary].find(valid);
  if (!value) return { estimateText: en ? 'Awaiting estimate' : '待估计', recalledText: en ? 'Self-recalled words: awaiting evidence' : '自评能回忆：待积累', rangeText: en ? 'Word-meaning samples 0 / 6' : '词义抽查 0 / 6' };
  const hasEstimate = value.status === 'tentative' && Number.isInteger(value.estimate) && Number.isInteger(value.lower) && Number.isInteger(value.upper) && value.lower >= value.recalledCount && value.estimate >= value.lower && value.estimate <= value.upper && value.upper <= value.coverageCount;
  return {
    estimateText: hasEstimate ? (en ? `About ${value.estimate} words` : `估计约 ${value.estimate} 词`) : (en ? 'Awaiting estimate' : '待估计'),
    recalledText: en ? `Self-recalled ${value.recalledCount} words · word bank ${value.coverageCount}` : `自评能回忆 ${value.recalledCount} 词 · 词库 ${value.coverageCount} 词`,
    rangeText: hasEstimate ? (en ? `Reference range ${value.lower}–${value.upper} words · ${value.sampleCount} sampled${value.atCoverageLimit ? ' · Current word bank limit; more words unmeasured' : ''}${value.refreshing ? ` · Refresh samples ${value.refreshSampleCount} / 6` : ''}` : `参考范围 ${value.lower}–${value.upper} 词 · 已抽查 ${value.sampleCount} 词${value.atCoverageLimit ? ' · 当前词库上限 · 更多词尚未测' : ''}${value.refreshing ? ` · 更新抽查 ${value.refreshSampleCount} / 6` : ''}`) : (en ? `Word-meaning samples ${value.sampleCount || 0} / ${value.requiredSamples || 6}` : `词义抽查 ${value.sampleCount || 0} / ${value.requiredSamples || 6}`)
  };
}
