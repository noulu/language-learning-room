import {ASSESSMENT_VERSION,ensureAssessment,assessmentChoice,estimateAssessment,assessmentSamples,assessmentFingerprint} from './assessment.js';
import { randomUUID, createHash } from '../crypto.js';
import { createEmptyCard, fsrs, State } from '../vendor/fsrs.mjs';
import { LANGUAGE_INFO, knownLanguage, knownStage } from '../content.js';
import { fieldsOnly, requireValue, isObject, HttpError } from './errors.js';
import { ensureSurvey, estimateVocabulary, reservedEntries, surveyChoice } from './vocabulary.js';
import { MODEL_VERSION, estimateAdaptive, selectAdaptiveNew, trainingDifficulty } from './adaptive.js';
import { DEFAULT_HELPER_PAIRS, HELPER_POLICY, helperLanguages, initializeHelperPreferences } from '../helper-languages.js';
import { RecentWords } from './recent-words.js';
import { RecentParagraphs } from './paragraph-content.js';
import { readabilityContext, reviewReadability, meaningEvidence } from './review-readability.js';
import { WordExamples } from './word-examples.js';

const sessionKey=s=>`${s.languageId}:${s.purpose ?? s.stage}`;
const teachingEvidence=reviews=>reviews.filter(r=>r.vocabularyMeasurement?.version!==ASSESSMENT_VERSION&&!r.entryId?.includes(':assessment:'));
const wordKey=entry=>entry.canonicalTeachingEntryId??entry.id;
const isRecent=session=>['recent-words','recent-paragraphs'].includes(session?.purpose);
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const VOCABULARY_SHORT_STEPS = [2 * MINUTE, 5 * MINUTE];
const VOCABULARY_BATCH_SIZE = 4;
const VOCABULARY_REINFORCEMENT_LIMIT = 10;
export const TIMEZONE = 'America/New_York';
export const scheduler = fsrs({ enable_fuzz: false, request_retention: 0.9 });
export function initialState() {
  return { schemaVersion: 1, selectedLanguage: 'fr', selectedStage: 1,
    preferences: { dailyGoal: 20, dailyGoals: {}, helperPairs: structuredClone(DEFAULT_HELPER_PAIRS), helperPairPolicy: HELPER_POLICY, helpers: Object.fromEntries(Object.entries(DEFAULT_HELPER_PAIRS).map(([id,pair]) => [id,pair[0]])), familiarizationMode: 'mental-spelling', arabicDiacritics: false, arabicTransliteration: false, hindiTransliteration: true },
    languages: Object.fromEntries(Object.keys(LANGUAGE_INFO).map(id => [id, { xp: 0, stagePositions: {}, cards: {}, rewards: {}, reviews: [] }])),
    sessions: {}, activeSessions: {}, receipts: {}, requests: {}, recordings: {}, jobs: {} };
}
export function initializeLearningState(state) {
  let changed = initializeHelperPreferences(state);
  for (const id of Object.keys(LANGUAGE_INFO)) if (!state.languages[id]) {
    state.languages[id] = { xp: 0, stagePositions: {}, cards: {}, rewards: {}, reviews: [] };
    changed = true;
  }
  if (state.preferences.hindiTransliteration === undefined) {
    state.preferences.hindiTransliteration = true; changed = true;
  }
  return changed;
}
const dateFormats=new Map();
export function localDate(now,timezone=TIMEZONE) {
  if(!dateFormats.has(timezone))dateFormats.set(timezone,new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  return dateFormats.get(timezone).format(now);
}
function newVocabularyProgress(state, languageId, date) {
  const { newVocabularyGoals, newVocabularyToday } = state.preferences;
  const timezone = state.preferences.timezone ?? TIMEZONE;
  const dailyGoal = newVocabularyGoals?.[languageId] ?? 20;
  const today = newVocabularyToday?.[languageId];
  const goal = today?.date === date ? Math.max(dailyGoal, today.goal) : dailyGoal;
  const reviews = state.languages[languageId].reviews;
  let completed = 0, known = 0;
  for (let index = reviews.length - 1; index >= 0; index--) {
    const review = reviews[index];
    const reviewedAt = Date.parse(review.reviewedAt);
    if (!Number.isFinite(reviewedAt)) continue;
    if (localDate(reviewedAt, timezone) !== date) break;
    if (review.stage !== 2 || review.sessionPurpose || review.vocabularyMeasurement?.version === ASSESSMENT_VERSION || review.cardWasReview !== false) continue;
    if (review.rating === 1 || review.rating === 2) completed++;
    else if (review.rating === 3 || review.rating === 4) known++;
  }
  return { completed, goal, known };
}
function newVocabularyChoice(language, entries, hasAssessment) {
  const fresh = entries.filter(entry => !language.cards[`2:${wordKey(entry)}`]);
  if (!fresh.length) return null;
  const evidence = teachingEvidence(language.reviews).filter(review => !review.assessedSkill || review.stage === 2);
  if (hasAssessment) return selectAdaptiveNew(fresh, language.cards, evidence, 2);
  const survey = ensureSurvey(language, entries);
  const reserved = new Set(reservedEntries(language, survey));
  return surveyChoice(language, fresh, survey)
    ?? selectAdaptiveNew(fresh.filter(entry => !reserved.has(entry.id)), language.cards, evidence, 2)
    ?? surveyChoice(language, fresh, survey, true);
}
export function vocabularyPacing(language, now, timezone = TIMEZONE) {
  const samples = new Map();
  const recentWords = new Set();
  const today = localDate(now, timezone);
  let todayCount = 0, consecutiveReviews = 0, consecutiveNew = 0;
  for (let index = language.reviews.length - 1; index >= 0; index--) {
    const review = language.reviews[index];
    if (review.stage !== 2 || review.sessionPurpose || review.vocabularyMeasurement?.version === ASSESSMENT_VERSION ||
        ![1, 2, 3, 4].includes(review.rating) || !review.entryId) continue;
    const key = review.canonicalEntryId ?? review.entryId;
    if (samples.size < 20 && !samples.has(key)) samples.set(key, review.rating);
    const reviewedAt = Date.parse(review.reviewedAt);
    if (Number.isFinite(reviewedAt) && localDate(reviewedAt, timezone) === today) {
      if (todayCount === consecutiveReviews && review.cardWasReview === true) consecutiveReviews++;
      if (todayCount === consecutiveNew && review.cardWasReview === false) consecutiveNew++;
      if (todayCount < 3 && reviewedAt > now - 30 * MINUTE) recentWords.add(key);
      todayCount++;
    }
    if (samples.size === 20 && (todayCount >= VOCABULARY_BATCH_SIZE || reviewedAt <= now - 24 * 60 * MINUTE)) break;
  }
  const sampleCount = samples.size;
  const hardCount = [...samples.values()].filter(rating => rating <= 2).length;
  const success = sampleCount ? 1 - hardCount / sampleCount : 0.65;
  const target = Math.max(0.2, Math.min(1 / 3, success <= 0.65
    ? 0.25 + (success - 0.65) / 3
    : 0.25 + (success - 0.65) * 5 / 9));
  const newRatio = 0.25 + (target - 0.25) * Math.min(1, sampleCount / 10);
  return { newRatio, sampleCount, todayCount, consecutiveNew, recentWords,
    freshFirst: consecutiveReviews >= Math.round(1 / newRatio - 1) };
}
function isLearningCard(card) {
  return card?.state === State.Learning || card?.state === State.Relearning;
}
function isShortVocabularyStep(card) {
  return isLearningCard(card) && card.last_review && new Date(card.due) - new Date(card.last_review) < 60 * MINUTE;
}
function scheduledDue(card, spacedVocabulary) {
  const due = new Date(card.due).getTime();
  if (!spacedVocabulary || card.vocabularyUnsteadySince !== undefined || !isShortVocabularyStep(card)) return due;
  const last = new Date(card.last_review).getTime();
  // Older cards retain their saved scores. Apply the new spacing to their pending short steps.
  if ([MINUTE, 5 * MINUTE].includes(due - last)) return last + VOCABULARY_SHORT_STEPS[0];
  if ([6 * MINUTE, 12 * MINUTE].includes(due - last)) return last + VOCABULARY_SHORT_STEPS[1];
  return due;
}
function vocabularyUnsteadySince(card, now) {
  if (Number.isFinite(card?.vocabularyUnsteadySince)) return card.vocabularyUnsteadySince;
  // Seed the workload from recent short steps, so old backlogs do not crowd out new words.
  if (!isShortVocabularyStep(card)) return null;
  const last = +new Date(card.last_review);
  const delay = +new Date(card.due) - last;
  return now - last <= 2 * DAY && [1, 5, 6, 12].includes(delay / MINUTE) ? last : null;
}
function vocabularyAtCapacity(scheduled, now) {
  const pending = new Set();
  for (const { entry, card } of scheduled) {
    if (vocabularyUnsteadySince(card, now) !== null) pending.add(wordKey(entry));
    if (pending.size >= VOCABULARY_REINFORCEMENT_LIMIT) return true;
  }
  return false;
}
export function progress(state, id, now, content, stage = state.selectedStage) {
  const language = state.languages[id];
  const date = localDate(now,state.preferences.timezone??TIMEZONE);
  const completed = Object.keys(language.rewards[date] ?? {}).length;
  const xp = language.xp;
  return { daily: { date, completed, goal: state.preferences.dailyGoals[id] ?? state.preferences.dailyGoal }, xp, reviewCount: language.reviews.length,
    newVocabulary: newVocabularyProgress(state, id, date),
    level: 1 + Math.floor(xp / 100), levelProgress: { current: xp % 100, required: 100 },
    adaptive: estimateAdaptive(teachingEvidence(language.reviews).filter(r => !r.assessedSkill || r.assessedSkill !== 'word-meaning' || r.stage === 2), content?.eligible(id, stage) ?? [], stage),
    vocabulary: content?.assessment?.(id) ? estimateAssessment(language,content.assessment(id)) : estimateVocabulary(language, content?.eligible(id, 2) ?? []) };
}
export function publicState(state, now, content) {
  return { selectedLanguage: state.selectedLanguage, selectedStage: state.selectedStage,
    preferences: {...state.preferences,arabicDiacritics:state.preferences.arabicDiacritics===true,arabicTransliteration:state.preferences.arabicTransliteration===true}, timezone: state.preferences.timezone??TIMEZONE,
    languages: Object.fromEntries(Object.keys(LANGUAGE_INFO).map(id => [id, {
      ...progress(state, id, now, content), stagePositions: state.languages[id].stagePositions,
      adaptiveByStage: Object.fromEntries([1, 2, 3, 4].map(stage => [stage, estimateAdaptive(teachingEvidence(state.languages[id].reviews), content?.eligible(id, stage) ?? [], stage)])),
      reviewCount: state.languages[id].reviews.length }])) };
}
function promptFor(entry, helper) {
  const prompts = entry?.output?.prompts ?? {};
  const language = [helper, 'en', 'zh', ...Object.keys(prompts)].find(id => prompts[id]);
  return { prompt: language ? prompts[language] : null, promptLanguage: language ?? null, prompts };
}
function contentRevision(entry, mediaRevision) {
  const fields = [entry.display, entry.rank, entry.meanings ?? {}, entry.sentence ?? null, entry.output ?? null, entry.audio ?? null, entry.sourceIds ?? []];
  if (entry.speechText !== undefined) fields.push({ speechText: entry.speechText });
  if (entry.audioPlan !== undefined || entry.audioText !== undefined) fields.push({ audioPlan: entry.audioPlan, audioText: entry.audioText });
  if (mediaRevision) fields.push(mediaRevision);
  if (entry.generatedParagraph) fields.push(entry.paragraphTargets);
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
export function patchState(state, data, now, content) {
  fieldsOnly(data, ['selectedLanguage', 'selectedStage', 'preferences']);
  if (data.selectedLanguage !== undefined) state.selectedLanguage = knownLanguage(data.selectedLanguage);
  if (data.selectedStage !== undefined) state.selectedStage = knownStage(data.selectedStage);
  if (data.preferences !== undefined) {
    fieldsOnly(data.preferences, ['dailyGoal', 'dailyGoals', 'newVocabularyGoals', 'helpers', 'helperPairs', 'familiarizationMode','arabicDiacritics','arabicTransliteration','hindiTransliteration','timezone','skin']);
    const p = data.preferences;
    if(p.timezone!==undefined){requireValue(typeof p.timezone==='string'&&p.timezone.length<=100,'学习时区无效。');try{new Intl.DateTimeFormat('en',{timeZone:p.timezone});}catch{requireValue(false,'学习时区无效。');}state.preferences.timezone=p.timezone;}
    if(p.skin!==undefined){requireValue(['light','dark'].includes(p.skin),'皮肤选项无效。');state.preferences.skin=p.skin;}
    if (p.hindiTransliteration !== undefined) {
      requireValue(typeof p.hindiTransliteration === 'boolean', '印地语转写开关必须为布尔值。');
      state.preferences.hindiTransliteration = p.hindiTransliteration;
    }
    if(p.arabicDiacritics!==undefined) {
      requireValue(typeof p.arabicDiacritics==='boolean','阿拉伯语元音符号开关必须为布尔值。');
      state.preferences.arabicDiacritics=p.arabicDiacritics;
    }
    if(p.arabicTransliteration!==undefined) {
      requireValue(typeof p.arabicTransliteration==='boolean','阿拉伯语罗马字母注音开关必须为布尔值。');
      state.preferences.arabicTransliteration=p.arabicTransliteration;
    }
    initializeHelperPreferences(state);
    const goal = n => requireValue(Number.isInteger(n) && n >= 1 && n <= 1000, '每日目标须为 1–1000 的整数。');
    if (p.dailyGoal !== undefined) { goal(p.dailyGoal); state.preferences.dailyGoal = p.dailyGoal; }
    if (p.dailyGoals !== undefined) {
      requireValue(isObject(p.dailyGoals), 'dailyGoals 必须是对象。');
      for (const [id, n] of Object.entries(p.dailyGoals)) { knownLanguage(id); goal(n); state.preferences.dailyGoals[id] = n; }
    }
    if (p.newVocabularyGoals !== undefined) {
      requireValue(isObject(p.newVocabularyGoals), 'newVocabularyGoals 必须是对象。');
      state.preferences.newVocabularyGoals ??= {};
      const date = localDate(now, state.preferences.timezone ?? TIMEZONE);
      for (const [id, limit] of Object.entries(p.newVocabularyGoals)) {
        knownLanguage(id);
        requireValue(Number.isInteger(limit) && limit >= 0 && limit <= 1000, '每日新词须为 0–1000 的整数。');
        state.preferences.newVocabularyGoals[id] = limit;
        delete state.preferences.newVocabularyToday?.[id];
        const session = state.sessions[state.activeSessions[`${id}:2`]];
        if (session?.task && !session.task.isReview && newVocabularyProgress(state, id, date).completed >= limit) session.task = null;
      }
    }
    if (p.helpers !== undefined) {
      requireValue(isObject(p.helpers), 'helpers 必须是对象。');
      for (const [id, helper] of Object.entries(p.helpers)) {
        knownLanguage(id); requireValue(helper !== id && (helper === 'zh' || Object.hasOwn(LANGUAGE_INFO, helper)), '辅助语言必须不同于目标语言。');
        state.preferences.helpers[id] = helper;
        const secondary = [...helperLanguages(state.preferences,id), ...DEFAULT_HELPER_PAIRS[id], 'zh', 'en', 'ja'].find(language => language !== helper && language !== id);
        state.preferences.helperPairs[id] = [helper, ...(secondary ? [secondary] : [])];
        for (const session of Object.values(state.sessions)) if (session.languageId === id) {
          session.helperLanguage = helper;
          if (session.task) {
            session.task.helperLanguage = helper;
            const entry = content?.pack(id)?.entries.find(e => e.id === session.task.entryId);
            if (entry?.output?.prompts) Object.assign(session.task, promptFor(entry, helper));
          }
        }
      }
    }
    if (p.helperPairs !== undefined) {
      requireValue(isObject(p.helperPairs), 'helperPairs 必须是对象。');
      for (const [id, pair] of Object.entries(p.helperPairs)) {
        knownLanguage(id);
        requireValue(Array.isArray(pair) && pair.length === 2 && new Set(pair).size === 2 && pair.every(helper => helper !== id && (helper === 'zh' || Object.hasOwn(LANGUAGE_INFO, helper))), '请选择两种不同于目标语言的辅助语言。');
        state.preferences.helperPairs[id] = [...pair]; state.preferences.helpers[id] = pair[0];
        for (const session of Object.values(state.sessions)) if (session.languageId === id) session.helperLanguage = pair[0];
      }
    }
    if (p.familiarizationMode !== undefined) {
      requireValue(['recognition', 'mental-spelling'].includes(p.familiarizationMode), '未知熟悉模式。');
      state.preferences.familiarizationMode = p.familiarizationMode;
    }
  }
  return publicState(state, now, content);
}
export class Learning {
  constructor(store, content, media, clock = () => new Date()) {
    this.store = store; this.content = content; this.media = media; this.clock = clock;
    this.recentWords = new RecentWords(content, media);
    this.wordExamples=new WordExamples(content,media,this.recentWords);
    this.recentParagraphs = new RecentParagraphs(content, media);
  }
  recentSelector(session) {return session.purpose==='recent-paragraphs'?this.recentParagraphs:this.recentWords;}
  recentReadability(state,session,entry){
    const context=readabilityContext(session.languageId,state.languages[session.languageId],this.content.eligible(session.languageId,2));
    return reviewReadability(context,entry?.sentence?.text??'',entry?.paragraphTargets??[],{allowGloss:session.purpose==='recent-paragraphs'});
  }
  scheduledEntries(state, session) {
    if(session.purpose==='assessment')return [];
    const language=state.languages[session.languageId];
    if (isRecent(session)) {
      const reviewed = new Set(language.reviews.filter(review => review.sessionPurpose === session.purpose).map(review => review.entryId));
      return this.recentSelector(session).index(session.languageId).rows.filter(row => reviewed.has(row.entry.id))
        .map(row => ({ entry: row.entry, cardStage: 3, card: language.cards[`3:${row.entry.id}`] }));
    }
    const items=this.content.eligible(session.languageId,session.stage).map(entry=>({entry,cardStage:session.stage,card:language.cards[`${session.stage}:${entry.id}`]}));
    const keys=new Set(items.map(i=>`${i.cardStage}:${wordKey(i.entry)}`));
    const originIds=new Set(language.reviews.filter(r=>r.stage===3&&r.assessedSkill==='word-meaning'&&r.cardStage===2).map(r=>r.canonicalEntryId??r.entryId));
    if([2,3].includes(session.stage))for(const entry of this.content.eligible(session.languageId,2)){
      const key=`2:${wordKey(entry)}`;
      const belongs=session.stage===2||(session.stage===3&&originIds.has(wordKey(entry)));
      if(belongs&&!keys.has(key)&&language.cards[key]){items.push({entry,cardStage:2,card:language.cards[key]});keys.add(key);}
    }
    return items;
  }
  choose(state, session, now) {
    if (isRecent(session)) {
      const language = state.languages[session.languageId];
      const due = this.scheduledEntries(state, session).filter(item => item.card && new Date(item.card.due) <= now
        && (session.purpose==='recent-paragraphs'||this.media.hasPreparedSentence(session.languageId, item.entry))&&this.recentReadability(state,session,item.entry).allowed).sort((a, b) => new Date(a.card.due) - new Date(b.card.due));
      const selected = due[0] ?? (session.purpose==='recent-paragraphs'&&this.content.runtimeGenerationEnabled?null:this.recentSelector(session).candidates(session.languageId, language, now)
        .find(item => !language.cards[`3:${item.entry.id}`] && (session.purpose==='recent-paragraphs'||this.media.hasPreparedSentence(session.languageId, item.entry))&&this.recentReadability(state,session,item.entry).allowed));
      if (!selected) { session.task = null; return; }
      this.setTask(state, session, selected.entry, due.length ? 'review' : session.purpose);
      return;
    }
    const entries = this.content.eligible(session.languageId, session.stage);
    const language = state.languages[session.languageId], cards = language.cards;
    const assessment=this.content.assessment(session.languageId);
    if(session.purpose==='assessment'&&!assessment){session.task=null;return;}
    if(session.purpose==='assessment' && language.reviews.filter(r=>r.sessionId===session.id).length>=6){session.task=null;return;}
    const spacedVocabulary = session.stage === 2 && !session.purpose;
    const scheduled = this.scheduledEntries(state, session).filter(item => item.card)
      .map(item => ({ ...item, dueAt: scheduledDue(item.card, spacedVocabulary) }));
    const due = scheduled.filter(item => item.dueAt <= now)
      .sort((a,b) => a.dueAt - b.dueAt || a.entry.rank - b.entry.rank || a.cardStage - b.cardStage);
    const selectNew = (candidates = entries) => selectAdaptiveNew(candidates, cards, teachingEvidence(language.reviews).filter(r => !r.assessedSkill || r.stage === 2), session.stage);
    let selected;
    let nextReview = due[0];
    if (spacedVocabulary) {
      const timezone = state.preferences.timezone ?? TIMEZONE;
      const date = localDate(now, timezone);
      const { completed, goal, known } = newVocabularyProgress(state, session.languageId, date);
      const pacing = vocabularyPacing(language, now, timezone);
      const spaced = item => !pacing.recentWords.has(wordKey(item.entry));
      const shortDue = due.find(item => isShortVocabularyStep(item.card) && spaced(item));
      nextReview = shortDue ?? due.find(item => vocabularyUnsteadySince(item.card, now) !== null && spaced(item))
        ?? due.find(spaced)
        ?? due.find(item => isShortVocabularyStep(item.card)) ?? nextReview;
      const batchNeedsReview = pacing.consecutiveNew >= VOCABULARY_BATCH_SIZE && scheduled.some(item => isShortVocabularyStep(item.card));
      const allowNew = goal > 0 && !batchNeedsReview && !vocabularyAtCapacity(scheduled, now);
      const freshFirst = pacing.freshFirst || (!pacing.todayCount && !shortDue);
      if (assessment && allowNew && !shortDue && completed + known >= goal && !state.sessions[state.activeSessions[`${session.languageId}:assessment`]]?.task) {
        const lastSample = language.reviews.findLast(row => row.vocabularyMeasurement?.version === ASSESSMENT_VERSION);
        const sampledAt = Date.parse(lastSample?.reviewedAt);
        if (!Number.isFinite(sampledAt) || localDate(sampledAt, timezone) !== date) {
          const sample = assessmentChoice(language, assessment, ensureAssessment(language, assessment));
          const sampledCard = sample && cards[`2:${wordKey(sample.entry)}`];
          if (sample && (!sampledCard?.last_review || now - new Date(sampledCard.last_review) >= 60 * MINUTE)) selected = sample;
        }
      }
      if (!selected && allowNew && (freshFirst || !nextReview || pacing.recentWords.has(wordKey(nextReview.entry)))) {
        selected = newVocabularyChoice(language, entries, assessment);
      }
      if (!selected && nextReview) selected = { entry: nextReview.entry, selectionReason: 'review', practiceStage: nextReview.cardStage };
      session.task = null;
      if (selected) this.setTask(state, session, selected.entry, selected.selectionReason, selected.measurement, selected.practiceStage);
      return;
    }
    if (nextReview) selected = { entry: nextReview.entry, selectionReason: 'review', practiceStage: nextReview.cardStage };
    if (!selected && [2,3].includes(session.stage) && assessment) {
      const plan=ensureAssessment(language,assessment);
      selected=assessmentChoice(language,assessment,plan,session.purpose==='assessment');
      if(!selected && session.purpose==='assessment'){session.task=null;return;}
      if(!selected)selected=selectNew();
    }
    if (!selected && [2, 3].includes(session.stage) && !assessment) {
      const words = this.content.eligible(session.languageId, 2);
      const survey = ensureSurvey(language, words);
      selected = surveyChoice(language, words, survey);
      if (!selected) {
        const reserved = new Set(reservedEntries(language, survey));
        selected = selectNew(entries.filter(e => !reserved.has(e.id)));
        // Tiny or exhausted courses must remain usable even before six probes.
        if (!selected) selected = surveyChoice(language, words, survey, true);
      }
    }
    selected ??= selectNew();
    const entry = selected?.entry;
    if (!entry) { session.task = null; return; }
    this.setTask(state, session, entry, selected.selectionReason, selected.measurement, selected.practiceStage);
  }
  setTask(state, session, entry, selectionReason, measurement, practiceStage) {
    const taskStage = practiceStage ?? (measurement ? 2 : session.stage);
    const wordVariant = Boolean(measurement) || (session.stage === 3 && taskStage === 2);
    const entries = this.content.eligible(session.languageId, session.stage);
    const cards = state.languages[session.languageId].cards;
    selectionReason ??= session.task?.selectionReason ?? (cards[`${session.stage}:${entry.id}`] ? 'review' : 'high-frequency');
    const taskId = randomUUID();
    const audioUrl = kind => `/api/audio?${new URLSearchParams({ languageId: session.languageId, entryId: entry.id, kind, sessionId: session.id, taskId })}`;
    const helper = state.preferences.helpers[session.languageId];
    session.helperLanguage = helper;
    session.task = { id: taskId, stage: session.stage, entryId: entry.id, display: entry.display,
      ...(entry.canonicalTeachingEntryId ? {canonicalEntryId:entry.canonicalTeachingEntryId} : {}),
      ...(session.purpose==='assessment'?{purpose:'assessment'}:{}),
      meanings: entry.meanings ?? {}, helperLanguage: helper, sentence: entry.sentence ?? null,
      ...promptFor(entry, helper),
      references: entry.output?.references ?? [], sourceIds: entry.sourceIds ?? [], rank: entry.rank,
      difficulty: trainingDifficulty(entry, taskStage), selectionReason,
      ...(wordVariant || entry.id.includes(':assessment:') ? { variant: measurement ? 'word-meaning-check' : 'word-meaning-review', practiceStage: 2 } : {}),
      ...(measurement ? { vocabularyMeasurement: measurement } : {}),
      audio: { word: this.media.available(session.languageId, entry, 'word') ? audioUrl('word') : null,
        sentence: this.media.available(session.languageId, entry, 'sentence') ? audioUrl('sentence') : null },
      mode: session.stage === 1 ? session.mode : ['meaning', 'input', 'output'][session.stage - 2],
      isReview: Boolean(cards[`${taskStage}:${wordKey(entry)}`]), audioVerified: false, contentRevision: contentRevision(entry, this.media.revision?.(session.languageId, entry)) };
    if (isRecent(session)) {
      session.task.purpose = session.purpose;
      const language = state.languages[session.languageId];
      session.task.recentTargets = this.recentSelector(session).candidates(session.languageId, language, this.clock()).find(row => row.entry.id === entry.id)?.targets
        ?? language.reviews.filter(review => review.entryId === entry.id && review.recentTargets).at(-1)?.recentTargets ?? [];
      if (session.purpose==='recent-paragraphs') {session.task.generatedParagraph=true;session.task.audio.sentence=audioUrl('sentence');session.task.runtimeGenerated=Boolean(entry.runtimeGenerated);}
      session.task.audio.word = null;
    }
    if (session.task.mode === 'recognition') {
      const alternatives = entries.filter(e => e.id !== entry.id).slice(0, 3).map(e => e.display);
      const correctOption = parseInt(createHash('sha256').update(session.task.id).digest('hex').slice(0, 4), 16) % (alternatives.length + 1);
      alternatives.splice(correctOption, 0, entry.display);
      session.task.options = alternatives; session.task.correctOption = correctOption;
    }
    if(!session.purpose)state.languages[session.languageId].stagePositions[session.stage] = { sessionId: session.id, entryId: entry.id, rank: entry.rank };
  }
  currentEntry(session) {
    return this.taskEntry(session,session.task);
  }
  taskEntry(session,task){
    if(session.purpose==='recent-paragraphs')return this.content.paragraphs(session.languageId).find(entry=>entry.id===task?.entryId);
    return (task?.practiceStage===2||session.purpose==='assessment'?this.content.words(session.languageId):this.content.eligible(session.languageId,session.stage)).find(e=>e.id===task?.entryId);
  }
  measurementMatches(session,task){
    const pack=this.content.assessment(session.languageId);
    return task?.vocabularyMeasurement?.version!==ASSESSMENT_VERSION || Boolean(pack&&task.vocabularyMeasurement.frameFingerprint===assessmentFingerprint(pack));
  }
  needsRefresh(session) {
    if (!session.task) return false;
    if(isRecent(session)&&!this.recentReadability(this.store.state,session,this.currentEntry(session)).allowed)return true;
    if(!this.measurementMatches(session,session.task))return true;
    const entry = this.currentEntry(session);
    return !entry || session.task.contentRevision !== contentRevision(entry, this.media.revision?.(session.languageId, entry));
  }
  refreshSession(state, session) {
    if(isRecent(session)&&session.task&&!this.recentReadability(state,session,this.currentEntry(session)).allowed){session.task=null;this.choose(state,session,this.clock());return true;}
    if (!this.needsRefresh(session)) return false;
    if(!this.measurementMatches(session,session.task)){session.task=null;this.choose(state,session,this.clock());return true;}
    const entry = this.currentEntry(session);
    if (entry) this.setTask(state, session, entry, session.task.selectionReason, session.task.vocabularyMeasurement, session.task.practiceStage);
    else { session.task = null; this.choose(state, session, this.clock()); }
    return true;
  }
  async refreshContent(languageId) {
    const sessions = Object.values(this.store.state.sessions).filter(s => !languageId || s.languageId === languageId);
    if (!sessions.some(s => this.needsRefresh(s))) return;
    await this.store.transaction(state => {
      for (const session of Object.values(state.sessions)) if (!languageId || session.languageId === languageId) this.refreshSession(state, session);
      return { updated: true };
    });
  }
  view(state, session, now) {
    const p = progress(state, session.languageId, now, this.content, session.stage);
    const { completed, goal } = p.newVocabulary;
    if (session.stage === 2 && !session.purpose && goal > 0 && completed >= goal && completed < 1000 &&
        (session.task?.isReview || session.task?.selectionReason === 'vocabulary-assessment')) {
      const cards = state.languages[session.languageId].cards;
      const batch = state.preferences.newVocabularyGoals?.[session.languageId] ?? 20;
      const available = this.content.eligible(session.languageId, 2).filter(entry => !cards[`2:${wordKey(entry)}`]).length;
      if (available > 0) p.newVocabularyNextGoal = completed + Math.min(batch, available, 1000 - completed);
    }
    if (!session.task) {
      p.completedSession = true;
      const spacedVocabulary = session.stage === 2 && !session.purpose;
      const scheduled = this.scheduledEntries(state, session).filter(item => item.card)
        .map(item => ({ ...item, dueAt: scheduledDue(item.card, spacedVocabulary) }));
      const dates = scheduled.map(item => item.dueAt).filter(Number.isFinite);
      p.nextDue = dates.length ? new Date(Math.min(...dates)).toISOString() : null;
      if (spacedVocabulary && scheduled.some(item => isShortVocabularyStep(item.card) && item.dueAt > now)) p.vocabularyRest = true;
      if (spacedVocabulary && goal > 0 && vocabularyAtCapacity(scheduled, now)) p.vocabularyLimitReached = true;
    }
    const task = session.task ? structuredClone(session.task) : null;
    if(task&&isRecent(session)){
      const entry=this.currentEntry(session),language=state.languages[session.languageId];
      task.reviewReadability=this.recentReadability(state,session,entry);
      const evidence=meaningEvidence(language,this.content.eligible(session.languageId,2));
      const originals=entry?.paragraphTargets??task.recentTargets??[];
      task.recentTargets=originals.map(target=>{
        const row=evidence.get(target.entryId),word=row?.word;
        return{...target,surface:target.surface??target.display,reason:row?.rating<=2?'reinforce':target.reason??'recent',
          firstLearnedAt:row?.firstSuccess?new Date(row.firstSuccess).toISOString():null,
          lastPracticedAt:row?.last?new Date(row.last).toISOString():null,meanings:word?.meanings??{}};
      });
    }
    // Add metadata to legacy pending tasks without changing their ID or preparedness.
    if (task) {
      this.addHelpers(state, session, task);
      task.difficulty ??= trainingDifficulty(this.currentEntry(session), session.task?.practiceStage ?? session.stage);
      task.selectionReason ??= task.isReview ? 'review' : 'high-frequency';
    }
    // Upgrade older saved tasks as well: browsers must fetch each new task's URL,
    // even when the same entry was just played in another mode.
    if (task) for (const kind of ['word', 'sentence']) if (task.audio[kind]) {
      task.audio[kind] = `/api/audio?${new URLSearchParams({ languageId: session.languageId, entryId: task.entryId, kind, sessionId: session.id, taskId: task.id, ...(session.purpose==='recent-words' ? {prepared:'1'} : {}) })}`;
    }
    const suggestedTargets=isRecent(session)&&!task?[...meaningEvidence(state.languages[session.languageId],this.content.eligible(session.languageId,2)).values()]
      .sort((a,b)=>(b.rating<=2)-(a.rating<=2)||b.last-a.last).slice(0,3).map(row=>({entryId:row.word.id,display:row.word.display,reason:row.rating<=2?'reinforce':'recent'})):null;
    return { sessionId: session.id, ...(session.purpose?{purpose:session.purpose}:{}), task, ...(suggestedTargets?{suggestedTargets}:{}), progress: p, undo: this.undoInfo(state, session) };
  }
  addHelpers(state, session, task) {
    task.helperLanguages = helperLanguages(state.preferences, session.languageId);
    task.helperLanguage = state.preferences.helpers[session.languageId] ?? task.helperLanguages[0];
    const original = this.taskEntry(session, task);
    const entry = this.content.assistance?.(session.languageId, original) ?? original;
    if (!entry) return;
    task.lemma = entry.lemma;
    task.pos = entry.pos;
    task.hanja = entry.hanja ?? [];
    task.japaneseReadings = entry.japaneseReadings ?? {};
    task.transliterations = entry.transliterations ?? {};
    if(session.languageId==='ar')task.arabicVocalization=entry.arabicVocalization;
    task.meanings = entry.meanings ?? {};
    task.sentence = entry.sentence ?? null;
    Object.assign(task, promptFor(entry, task.helperLanguage));
    task.helperTranslationProvenance = entry.helperTranslationProvenance ?? {};
  }
  start(data) {
    fieldsOnly(data, ['languageId', 'stage', 'mode', 'purpose', 'newVocabularyToday']);
    const id = knownLanguage(data.languageId), stage = knownStage(data.stage);
    if (data.purpose !== undefined) requireValue(['recent-words','recent-paragraphs'].includes(data.purpose) && stage === 3, '近期词练习只支持输入训练。');
    if (data.mode !== undefined) requireValue(['recognition', 'mental-spelling'].includes(data.mode) && stage === 1, '此训练不支持所选模式。');
    if (data.newVocabularyToday !== undefined) {
      fieldsOnly(data.newVocabularyToday, ['date', 'goal']);
      requireValue(stage === 2 && !data.purpose && Number.isInteger(data.newVocabularyToday.goal) && data.newVocabularyToday.goal > 0 && data.newVocabularyToday.goal <= 1000, '今日加学数量无效。');
    }
    return this.store.transaction(state => {
      const now = this.clock();
      const activeKey = `${id}:${data.purpose ?? stage}`;
      const mode = data.mode ?? state.preferences.familiarizationMode;
      let session = state.sessions[state.activeSessions[activeKey]];
      if (!session || (stage === 1 && session.mode !== mode)) {
        session = { id: randomUUID(), languageId: id, stage, ...(data.purpose ? {purpose:data.purpose} : {}), helperLanguage: state.preferences.helpers[id], mode, task: null, createdAt: now.toISOString() };
        state.sessions[session.id] = session; state.activeSessions[activeKey] = session.id;
      }
      if (data.newVocabularyToday) {
        const date = localDate(now, state.preferences.timezone ?? TIMEZONE);
        requireValue(data.newVocabularyToday.date === date, '已到新的学习日，请刷新后再继续。', 409, 'study_day_changed');
        const { goal } = newVocabularyProgress(state, id, date);
        if (data.newVocabularyToday.goal > goal) {
          state.preferences.newVocabularyToday ??= {};
          state.preferences.newVocabularyToday[id] = { date, goal: data.newVocabularyToday.goal };
          if (session.task?.isReview || session.task?.selectionReason === 'vocabulary-assessment') session.task = null;
        }
      }
      this.refreshSession(state, session);
      if (!session.task) this.choose(state, session, now);
      else if (stage === 2 && !session.purpose) {
        const date = localDate(now, state.preferences.timezone ?? TIMEZONE);
        const { completed, goal, known } = newVocabularyProgress(state, id, date);
        const language = state.languages[id];
        const card = language.cards[`2:${session.task.canonicalEntryId ?? session.task.entryId}`];
        const sample = session.task.selectionReason === 'vocabulary-assessment';
        const full = vocabularyAtCapacity(this.scheduledEntries(state, session), now);
        if (full && (!session.task.isReview || sample)) this.choose(state, session, now);
        else if (session.task.isReview || sample) {
          const eligibleAt = sample ? (card?.last_review ? +new Date(card.last_review) + 60 * MINUTE : 0) : card ? scheduledDue(card, true) : Infinity;
          if (eligibleAt > now) this.choose(state, session, now);
          else if (goal > 0 && !full && (sample ? completed + known < goal : !isShortVocabularyStep(card) &&
              !vocabularyPacing(language, now, state.preferences.timezone ?? TIMEZONE).todayCount)) {
            const fresh = newVocabularyChoice(language, this.content.eligible(id, 2), this.content.assessment(id));
            if (fresh) this.setTask(state, session, fresh.entry, fresh.selectionReason, fresh.measurement, fresh.practiceStage);
          }
        }
      }
      state.selectedLanguage = id; state.selectedStage = stage;
      return this.view(state, session, now);
    });
  }
  startAssessment(data){
    fieldsOnly(data,['languageId']);const id=knownLanguage(data.languageId);
    requireValue(this.content.assessment(id),'此语言尚未发布跨频段测量词库。',409,'assessment_unavailable');
    return this.store.transaction(state=>{
      const key=`${id}:assessment`;let session=state.sessions[state.activeSessions[key]];
      if(!session||!session.task){session={id:randomUUID(),languageId:id,stage:2,purpose:'assessment',helperLanguage:state.preferences.helpers[id],mode:'meaning',task:null,createdAt:this.clock().toISOString()};state.sessions[session.id]=session;state.activeSessions[key]=session.id;}
      this.refreshSession(state,session);if(!session.task)this.choose(state,session,this.clock());
      return this.view(state,session,this.clock());
    });
  }
  async get(id) {
    let session = Object.hasOwn(this.store.state.sessions, id) ? this.store.state.sessions[id] : null;
    if (!session) throw new HttpError(404, 'session_not_found', '学习会话不存在。');
    await this.refreshContent(session.languageId);
    session = this.store.state.sessions[id];
    return this.view(this.store.state, session, this.clock());
  }
  replay(state, receipt) {
    if (receipt.task) {
      const original = state.sessions[receipt.review.sessionId];
      const entry = original && this.taskEntry(original,receipt.task);
      if (!entry || receipt.task.contentRevision !== contentRevision(entry, this.media.revision?.(original.languageId, entry))) {
        const session = original && (state.sessions[state.activeSessions[sessionKey(original)]] ?? original);
        if (session) {
          this.refreshSession(state, session);
          return { ...this.view(state, session, this.clock()), review: receipt.review };
        }
      }
    }
    const result = structuredClone(receipt), session = state.sessions[receipt.review.sessionId];
    if (session) {
      result.undo = this.undoInfo(state,session);
      result.progress.vocabulary = progress(state,session.languageId,this.clock(),this.content,session.stage).vocabulary;
      result.progress.adaptive ??= estimateAdaptive(state.languages[session.languageId].reviews, this.content.eligible(session.languageId, session.stage), session.stage);
      if (result.task) {
        this.addHelpers(state,session,result.task);
        const entry = this.taskEntry(session,result.task);
        result.task.difficulty ??= trainingDifficulty(entry, session.stage);
        result.task.selectionReason ??= result.task.isReview ? 'review' : 'high-frequency';
      }
    }
    return result;
  }
  review(data, onPrepared) {
    fieldsOnly(data, ['sessionId', 'taskId', 'rating', 'response', 'requestId']);
    requireValue(typeof data.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.requestId) && !['__proto__', 'constructor', 'prototype'].includes(data.requestId), 'requestId 必须是 1–128 位字母、数字、下划线或短横线。');
    requireValue(Number.isInteger(data.rating) && data.rating >= 1 && data.rating <= 4, '评分必须为 1–4。');
    requireValue(typeof data.sessionId === 'string' && typeof data.taskId === 'string', '缺少会话或题目。');
    if (data.response !== undefined) requireValue(typeof data.response === 'string' && data.response.length <= 10000, '回答必须为最多 10000 字符的文本。');
    const fingerprint = createHash('sha256').update(JSON.stringify([data.sessionId, data.taskId, data.rating, data.response ?? null])).digest('hex');
    return this.store.transaction(state => {
      requireValue(!Object.hasOwn(state.undoRequests ?? {}, data.requestId), '此requestId已用于撤销。', 409, 'idempotency_conflict');
      requireValue(!Object.hasOwn(state.undoneReviews ?? {}, data.taskId), '此评分已撤销，请对恢复的新题目重新自评。', 409, 'review_undone');
      const prior = Object.hasOwn(state.requests, data.requestId) ? state.requests[data.requestId] : null;
      if (prior) {
        requireValue(prior.fingerprint === fingerprint, '此 requestId 已用于另一个提交。', 409, 'idempotency_conflict');
        return this.replay(state, state.receipts[prior.taskId]);
      }
      if (Object.hasOwn(state.receipts, data.taskId)) {
        const receipt = state.receipts[data.taskId];
        requireValue(receipt.review.sessionId === data.sessionId, '题目不属于该会话。', 409, 'task_conflict');
        state.requests[data.requestId] = { fingerprint, taskId: data.taskId };
        return this.replay(state, receipt);
      }
      const session = Object.hasOwn(state.sessions, data.sessionId) ? state.sessions[data.sessionId] : null;
      requireValue(session, '学习会话不存在。', 404, 'session_not_found');
      requireValue(!this.needsRefresh(session), '内容已更新，请恢复当前题目后再自评。', 409, 'content_changed');
      requireValue(session.task?.id === data.taskId, '题目已更换，请恢复当前题目。', 409, 'task_conflict');
      const activeKey = sessionKey(session);
      requireValue(state.activeSessions[activeKey] === session.id, '此会话已被另一模式替换。', 409, 'session_conflict');
      requireValue(session.stage !== 1 || session.task.audioVerified, '当前听题音频尚未成功准备，请播放或重新获取音频后再评分。', 409, 'audio_not_ready');
      requireValue(session.purpose!=='recent-words' || session.task.audioVerified, '请先播放当前内容的自然语音，再揭晓和自评。', 409, 'audio_not_ready');
      const now = this.clock(), language = state.languages[session.languageId];
      const cardStage = session.task.practiceStage ?? session.stage;
      const cardKey = `${cardStage}:${session.task.canonicalEntryId??session.task.entryId}`;
      const rewardKey = `${session.stage}:${session.task.canonicalEntryId??session.task.entryId}`;
      const cardWasReview = Boolean(language.cards[cardKey]);
      const before = { task: structuredClone(session.task), cardKey, card: cardWasReview ? structuredClone(language.cards[cardKey]) : null, xp: language.xp,
        date: localDate(now,state.preferences.timezone??TIMEZONE), rewards: structuredClone(language.rewards[localDate(now,state.preferences.timezone??TIMEZONE)] ?? null),
        vocabularySurvey: structuredClone(language.vocabularySurvey ?? null), previousVocabularySurvey: structuredClone(language.previousVocabularySurvey ?? null),
        vocabularyAssessment:structuredClone(language.vocabularyAssessment??null),previousVocabularyAssessment:structuredClone(language.previousVocabularyAssessment??null) };
      const previous = language.cards[cardKey] ?? createEmptyCard(now);
      const result = scheduler.next(previous, now, data.rating);
      if (session.stage === 2 && !session.purpose && session.task.selectionReason !== 'vocabulary-assessment') {
        const pendingSince = vocabularyUnsteadySince(previous, now);
        delete result.card.vocabularyUnsteadySince;
        if (data.rating <= 2) {
          result.card.vocabularyUnsteadySince = +now;
          if (!isLearningCard(result.card)) result.card.state = State.Relearning;
          result.card.scheduled_days = 0;
          result.card.due = new Date(+now + VOCABULARY_SHORT_STEPS[data.rating - 1]);
        }
        const needsConfirmation = pendingSince !== null && now - pendingSince < DAY;
        if (data.rating >= 3 && (needsConfirmation || (data.rating === 3 && (isLearningCard(previous) || isLearningCard(result.card))))) {
          result.card.state = State.Review;
          result.card.learning_steps = 0;
          result.card.scheduled_days = 1;
          result.card.due = new Date(+now + DAY);
          if (needsConfirmation) result.card.vocabularyUnsteadySince = pendingSince;
        }
      } else if (Number.isFinite(previous.vocabularyUnsteadySince)) {
        result.card.vocabularyUnsteadySince = previous.vocabularyUnsteadySince;
      }
      language.cards[cardKey] = result.card;
      const date = localDate(now,state.preferences.timezone??TIMEZONE);
      language.rewards[date] ??= {};
      const awardedXp = language.rewards[date][rewardKey] ? 0 : 10;
      language.rewards[date][rewardKey] = true; language.xp += awardedXp;
      const review = { sessionId: session.id, taskId: data.taskId, entryId: session.task.entryId, stage: session.stage,
        ...(cardStage === 2 ? { assessedSkill: 'word-meaning' } : {}),
        ...(session.task.canonicalEntryId?{canonicalEntryId:session.task.canonicalEntryId}:{}),
        ...(session.purpose?{sessionPurpose:session.purpose}:{}),
        ...(session.task.recentTargets ? {recentTargets:structuredClone(session.task.recentTargets)} : {}),
        ...(session.task.vocabularyMeasurement ? { vocabularyMeasurement: structuredClone(session.task.vocabularyMeasurement) } : {}),
        cardStage, cardWasReview, rating: data.rating, response: data.response ?? null, reviewedAt: now.toISOString(), awardedXp,
        due: result.card.due, card: result.card, log: result.log, scheduler: 'ts-fsrs@5.4.1', assessment: 'self',
        difficulty: session.task.difficulty ?? trainingDifficulty(this.currentEntry(session), session.task?.practiceStage ?? session.stage), adaptiveModelVersion: MODEL_VERSION };
      language.reviews.push(review);
      session.task = null; this.choose(state, session, now);
      state.undoSlot = { sessionId: session.id, languageId: session.languageId, stage: session.stage, reviewTaskId: data.taskId, before };
      const receipt = { ...this.view(state, session, now), review };
      state.requests[data.requestId] = { fingerprint, taskId: data.taskId };
      state.receipts[data.taskId] = receipt;
      if (receipt.task && onPrepared) return Promise.resolve(onPrepared(receipt)).then(() => receipt);
      return receipt;
    }, undefined, state => [data.taskId, state.requests[data.requestId]?.taskId]);
  }
  undoInfo(state, session) {
    const slot = state.undoSlot;
    const latest = state.languages[session.languageId].reviews.at(-1);
    const matches = slot?.sessionId === session.id && slot.reviewTaskId === latest?.taskId && state.activeSessions[sessionKey(session)] === session.id;
    if (!matches) return { available: false };
    const previous = slot.before.task;
    const entry = this.taskEntry(session,previous);
    const unchanged = entry && this.measurementMatches(session,previous) && previous.contentRevision === contentRevision(entry, this.media.revision?.(session.languageId, entry));
    return { available: Boolean(unchanged), reviewTaskId: slot.reviewTaskId, currentTaskId: session.task?.id ?? null, ...(unchanged ? {} : { reason: 'content_changed' }) };
  }
  undo(data) {
    fieldsOnly(data, ['sessionId','reviewTaskId','currentTaskId','requestId']);
    requireValue(typeof data.sessionId === 'string' && typeof data.reviewTaskId === 'string' && (typeof data.currentTaskId === 'string' || data.currentTaskId === null), '撤销需要会话、上一评分及当前题目。');
    requireValue(typeof data.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.requestId) && !['__proto__','constructor','prototype'].includes(data.requestId), 'requestId无效。');
    const fingerprint = createHash('sha256').update(JSON.stringify(['undo',data.sessionId,data.reviewTaskId,data.currentTaskId])).digest('hex');
    return this.store.transaction(state => {
      const session = Object.hasOwn(state.sessions,data.sessionId) ? state.sessions[data.sessionId] : null;
      requireValue(session, '学习会话不存在。',404,'session_not_found');
      const prior = Object.hasOwn(state.undoRequests ?? {},data.requestId) ? state.undoRequests[data.requestId] : null;
      if (prior) {
        requireValue(prior.fingerprint === fingerprint, '此requestId已用于另一次撤销。',409,'idempotency_conflict');
        const original = state.receipts[data.reviewTaskId]?.review;
        return { ...this.view(state,session,this.clock()), undoApplied:false, undoneReviewTaskId:data.reviewTaskId,
          ...(session.task?.id === prior.restoredTaskId && original ? { restoredFrom: { taskId:data.reviewTaskId,response:original.response,recordingUrls:Object.values(state.recordings).filter(r=>r.sessionId===session.id&&r.taskId===data.reviewTaskId).map(r=>r.url) } } : {}) };
      }
      requireValue(!Object.hasOwn(state.requests,data.requestId), '此requestId已用于评分。',409,'idempotency_conflict');
      const slot=state.undoSlot, language=state.languages[session.languageId];
      requireValue(slot?.sessionId === session.id && slot.reviewTaskId === data.reviewTaskId && language.reviews.at(-1)?.taskId === data.reviewTaskId, '只能撤销当前会话最近一次评分，请恢复当前练习。',409,'undo_conflict');
      requireValue(state.activeSessions[sessionKey(session)] === session.id && (session.task?.id ?? null) === data.currentTaskId, '题目或会话已更换，请恢复当前练习。',409,'task_conflict');
      const before=slot.before, previous=before.task;
      const entry=this.taskEntry(session,previous);
      requireValue(entry && this.measurementMatches(session,previous) && previous.contentRevision === contentRevision(entry,this.media.revision?.(session.languageId,entry)), '上一题内容已更新，无法恢复旧评分；当前练习已保留。',409,'content_changed');
      const review=language.reviews.pop();
      if (before.card) language.cards[before.cardKey]=structuredClone(before.card); else delete language.cards[before.cardKey];
      language.xp=before.xp;
      if (before.rewards) language.rewards[before.date]=structuredClone(before.rewards); else delete language.rewards[before.date];
      for (const field of ['vocabularySurvey','previousVocabularySurvey','vocabularyAssessment','previousVocabularyAssessment']) {
        if (before[field]) language[field]=structuredClone(before[field]); else delete language[field];
      }
      // Rebuild from current unchanged source/current helper, with a new task ID.
      // setTask touches only this language's current training position.
      session.helperLanguage = state.preferences.helpers[session.languageId];
      this.setTask(state,session,entry,previous.selectionReason,previous.vocabularyMeasurement,previous.practiceStage);
      // Keep the heard question and option indices; task identity/media URLs change.
      for (const field of ['options','correctOption','audioVerified','audioProvenance']) if (Object.hasOwn(previous,field)) session.task[field]=structuredClone(previous[field]);
      state.undoneReviews ??= {};
      state.undoneReviews[data.reviewTaskId]={sessionId:session.id,undoneAt:this.clock().toISOString()};
      state.undoRequests ??= {};
      state.undoRequests[data.requestId]={fingerprint,reviewTaskId:data.reviewTaskId,restoredTaskId:session.task.id};
      state.undoSlot=null;
      return { ...this.view(state,session,this.clock()), undoApplied:true, undoneReviewTaskId:data.reviewTaskId,
        restoredFrom:{taskId:data.reviewTaskId,response:review.response,recordingUrls:Object.values(state.recordings).filter(r=>r.sessionId===session.id&&r.taskId===data.reviewTaskId).map(r=>r.url)} };
    }, undefined, () => [data.reviewTaskId]);
  }
  validateAudioTask(languageId, entryId, sessionId, taskId) {
    if (!sessionId && !taskId) return;
    const session = Object.hasOwn(this.store.state.sessions, sessionId) ? this.store.state.sessions[sessionId] : null;
    requireValue(session?.languageId === languageId && session.task?.entryId === entryId && session.task.id === taskId, '音频题目已更换，请恢复当前题目。', 409, 'task_conflict');
    requireValue(!this.needsRefresh(session), '内容已更新，请恢复当前题目以取得对应音频。', 409, 'content_changed');
  }
  wordExample(sessionId,taskId){
    const session=this.store.state.sessions[sessionId];
    requireValue(session?.task?.id===taskId&&taskId,'题目已更换，请查看当前词的例句。',409,'task_conflict');
    requireValue([1,2].includes(session.task.practiceStage??session.stage),'例句只用于单词学习。');
    requireValue(!this.needsRefresh(session),'内容已更新，请恢复当前题目。',409,'content_changed');
    const word=this.currentEntry(session),result=this.wordExamples.select(session.languageId,word,this.store.state.languages[session.languageId],helperLanguages(this.store.state.preferences,session.languageId));
    if(result.example?.hasAudio)result.example.audioUrl=`/api/audio?${new URLSearchParams({languageId:session.languageId,entryId:result.example.entryId,kind:'sentence',sessionId,taskId,prepared:'1',example:'1'})}`;
    return{taskId,...result};
  }
  validateExampleAudio(languageId,entryId,sessionId,taskId){
    const result=this.wordExample(sessionId,taskId);
    requireValue(this.store.state.sessions[sessionId].languageId===languageId&&result.example?.entryId===entryId&&result.example.hasAudio,'例句已更换或没有现成语音。',409,'task_conflict');
  }
  async audioReady(languageId, entryId, metadata, sessionId, taskId) {
    const provenance = JSON.stringify(metadata);
    const eligible = session => (session.stage === 1 || session.purpose === 'recent-words') &&
      session.languageId === languageId && session.task?.entryId === entryId &&
      (!sessionId || (session.id === sessionId && session.task.id === taskId)) && !this.needsRefresh(session) &&
      (!session.task.audioVerified || JSON.stringify(session.task.audioProvenance) !== provenance);
    // Optional playback cannot block a rating behind a redundant disk save.
    if (!Object.values(this.store.state.sessions).some(eligible)) return { ready: true };
    return this.store.transaction(state => {
      for (const session of Object.values(state.sessions)) {
        if (eligible(session)) {
          session.task.audioVerified = true;
          session.task.audioProvenance = metadata;
        }
      }
      return { ready: true };
    }, undefined, () => []);
  }
}
