import { escapeHTML as esc } from './core.js';
import { verbReferenceData, verbReferenceTables } from './verb-reference-data.js';

function normalize(text, language) {
  const word = String(text ?? '').trim().normalize('NFC').toLowerCase();
  if (language === 'ar') return word.replace(/[\u0640\u064b-\u065f\u0670]/gu, '');
  if (language === 'ru') return word.replace(/\u0301/gu, '');
  return word;
}

const words = value => value.split(' ');
const title = {
  present: ['现在时', 'Present', 'present'],
  past: ['过去时', 'Past', 'past'],
  preterite: ['直陈式 · 简单过去时', 'Indicative · simple past', 'past'],
  imperfect: ['直陈式 · 未完成过去时', 'Indicative · imperfect', 'past'],
  compound: ['复合过去时 · 助动词 avoir', 'Compound past · auxiliary avoir', 'past'],
  future: ['直陈式 · 简单将来时', 'Indicative · simple future', 'future'],
  conditional: ['条件式 · 现在时', 'Present conditional', 'present'],
  subjunctive: ['虚拟式 · 现在时', 'Present subjunctive', 'present'],
  subjPast: ['虚拟式 · 未完成过去时', 'Imperfect subjunctive', 'past'],
  command: ['命令式 · 肯定', 'Imperative · affirmative', 'present'],
  negativeCommand: ['命令式 · 否定', 'Imperative · negative', 'present'],
  gerund: ['副动词', 'Gerund', 'form'],
  presentParticiple: ['现在分词', 'Present participle', 'present'],
  participle: ['过去分词', 'Past participle', 'form'],
  jaPolite: ['礼貌体 · 非过去', 'Polite · non-past', 'present'],
  jaPast: ['礼貌体 · 过去', 'Polite · past', 'past'],
  koPolite: ['日常礼貌体 · 非过去', 'Casual-polite · non-past', 'present'],
  koPast: ['日常礼貌体 · 过去', 'Casual-polite · past', 'past'],
  habitual: ['习惯体', 'Habitual aspect', 'form'],
  markers: ['动词前的词', 'Words before the verb', 'form'],
  clitic: ['不定式 · 附加代词', 'Infinitive · attached pronoun', 'form'],
  presentation: ['引出眼前的人或物', 'Presentative forms', 'form'],
  idCopula: ['定义或辨认', 'Defining or identifying', 'form'],
  modal: ['情态动词', 'Modal verb', 'form'],
  modalPast: ['情态动词 · 过去语境', 'Modal verb · past context', 'past'],
  negPresent: ['现在时 · 否定', 'Present · negative', 'present'],
  negPast: ['过去时 · 否定', 'Past · negative', 'past'],
  suggestion: ['建议 · 第一人称复数', 'Suggestion · first-person plural', 'form'],
  arSubj: ['主动 · 非过去 · 虚拟式', 'Active non-past · subjunctive', 'present'],
  arJussive: ['主动 · 非过去 · 切格', 'Active non-past · jussive', 'present'],
};

const esPeople = ['yo', 'nosotros', 'tú', 'vosotros', 'él / ella / usted', 'ellos / ellas / ustedes'];
const frPeople = ['je', 'nous', 'tu', 'vous', 'il / elle / on', 'ils / elles'];
const gender = [['阳性单数', 'Masc. singular'], ['阳性复数', 'Masc. plural'], ['阴性单数', 'Fem. singular'], ['阴性复数', 'Fem. plural']];
const polarity = [['肯定', 'Affirmative'], ['否定', 'Negative']];

// Values are the exact surface forms used for matching. Labels show only the grammatical ending or marker.
function panel(key, labels, endings, forms, columns = 2) {
  const [zh, en, tone] = title[key];
  return { key, zh, en, tone, columns, cells: labels.map((label, i) => ({
    label: Array.isArray(label) ? label : [label, label], ending: endings[i], forms: Array.isArray(forms[i]) ? forms[i] : [forms[i]],
  })) };
}

const suffix = ending => `-${ending}`;
function affixes(key, labels, endings, stem, columns) {
  return panel(key, labels, endings.map(suffix), endings.map((ending, i) =>
    (typeof stem === 'function' ? stem(ending, i) : stem) + ending), columns);
}

const spanish = new Set(words('hablar trabajar estudiar tomar llevar pasar llamar usar cambiar ayudar caminar necesitar comer beber aprender vender correr vivir escribir subir abrir buscar pagar llegar'));
function spanishTables(lemma) {
  if (lemma === 'haber') return [affixes('present', esPeople, words('e emos as abéis a an'), 'h')];
  if (!spanish.has(lemma)) return [];
  const stem = lemma.slice(0, -2), type = lemma.slice(-2), ar = type === 'ar', er = type === 'er';
  const spelling = ending => ending.startsWith('e') || ending.startsWith('é')
    ? stem.replace(/c$/u, 'qu').replace(/g$/u, 'gu').replace(/z$/u, 'c') : stem;
  const people = (key, tails, base = stem) => affixes(key, esPeople, words(tails), base);
  const subj = ar ? 'e emos es éis e en' : 'a amos as áis a an';
  return [
    people('present', ar ? 'o amos as áis a an' : er ? 'o emos es éis e en' : 'o imos es ís e en'),
    people('preterite', ar ? 'é amos aste asteis ó aron' : 'í imos iste isteis ió ieron', spelling),
    people('imperfect', ar ? 'aba ábamos abas abais aba aban' : 'ía íamos ías íais ía ían'),
    people('future', 'é emos ás éis á án', lemma),
    people('conditional', 'ía íamos ías íais ía ían', lemma),
    people('subjunctive', subj, spelling),
    people('subjPast', ar ? 'ara áramos aras arais ara aran' : 'iera iéramos ieras ierais iera ieran'),
    people('subjPast', ar ? 'ase ásemos ases aseis ase asen' : 'iese iésemos ieses ieseis iese iesen'),
    affixes('command', ['tú', 'usted', 'nosotros', 'vosotros', 'ustedes'], ar ? words('a e emos ad en') : er ? words('e a amos ed an') : words('e a amos id an'), spelling, 3),
    panel('negativeCommand', ['tú', 'usted', 'nosotros', 'vosotros', 'ustedes'], [2, 4, 1, 3, 5].map(i => suffix(words(subj)[i])),
      [2, 4, 1, 3, 5].map(i => `no ${spelling(words(subj)[i])}${words(subj)[i]}`), 3),
    affixes('gerund', [['词尾', 'Ending']], [ar ? 'ando' : 'iendo'], stem, 1),
    affixes('participle', gender, lemma === 'abrir' ? words('ierto iertos ierta iertas')
      : lemma === 'escribir' ? words('ito itos ita itas') : ar ? words('ado ados ada adas') : words('ido idos ida idas'),
      { abrir: 'ab', escribir: 'escr' }[lemma] ?? stem),
  ];
}

const frenchEr = new Set(words('parler manger aimer donner penser trouver passer jouer demander regarder chercher travailler écouter rester arriver retrouver habiter marcher porter monter fermer montrer entrer tomber'));
const frenchIr = new Set(words('finir choisir réussir remplir grandir'));
const avoirCompound = new Set(words('parler manger aimer donner penser trouver jouer demander regarder chercher travailler écouter retrouver habiter marcher porter fermer montrer finir choisir réussir remplir grandir'));
function frenchTables(lemma) {
  const ir = frenchIr.has(lemma);
  if (!ir && !frenchEr.has(lemma)) return [];
  const stem = lemma.slice(0, -2);
  const spelling = ending => lemma === 'manger' && /^[aoâ]/u.test(ending) ? `${stem}e` : stem;
  const people = (key, tails, base = spelling) => affixes(key, frPeople, words(tails), base);
  const part = ir ? 'i' : 'é';
  const tables = [
    people('present', ir ? 'is issons is issez it issent' : 'e ons es ez e ent'),
    people('imperfect', ir ? 'issais issions issais issiez issait issaient' : 'ais ions ais iez ait aient'),
    people('preterite', ir ? 'is îmes is îtes it irent' : 'ai âmes as âtes a èrent'),
    people('future', 'ai ons as ez a ont', lemma),
    people('conditional', 'ais ions ais iez ait aient', lemma),
    people('subjunctive', ir ? 'isse issions isses issiez isse issent' : 'e ions es iez e ent'),
    people('subjPast', ir ? 'isse issions isses issiez ît issent' : 'asse assions asses assiez ât assent'),
    affixes('command', ['tu', 'nous', 'vous'], ir ? words('is issons issez') : words('e ons ez'), spelling, 3),
    affixes('presentParticiple', [['词尾', 'Ending']], [ir ? 'issant' : 'ant'], spelling, 1),
    affixes('participle', gender, [part, `${part}s`, `${part}e`, `${part}es`], stem),
  ];
  if (avoirCompound.has(lemma)) {
    const auxiliary = words('ai avons as avez a ont');
    tables.splice(2, 0, panel('compound', frPeople, auxiliary, auxiliary.map(word => `${word} ${stem}${part}`)));
  }
  return tables;
}

const russian = new Set(words('быть делать сделать работать читать говорить думать знать слушать играть гулять смотреть писать видеть хотеть уметь понимать помнить любить ждать жить учить считать'));
function russianTables(lemma) {
  if (!russian.has(lemma)) return [];
  const stem = lemma.slice(0, -2);
  return [affixes('past', [['阳性单数', 'Masc. singular'], ['阴性单数', 'Fem. singular'], ['中性单数', 'Neut. singular'], ['复数', 'Plural']],
    words('л ла ло ли'), stem)];
}

const english = new Set(words('work play like want need call look use live walk talk ask help open close show eat drink read write say make see get take know think come go have do'));
function englishTables(lemma) {
  if (!english.has(lemma)) return [];
  const tail = /(?:s|sh|ch|x|z|o)$/u.test(lemma) ? 'es' : 's';
  const pastEnding = lemma.endsWith('e') ? 'd' : 'ed';
  const inflections = {
    eat: ['ate', 'eaten'], drink: ['drank', 'drunk'], read: ['read', 'read'], write: ['wrote', 'written'],
    say: ['said', 'said'], make: ['made', 'made'], see: ['saw', 'seen'], get: ['got', ['got', 'gotten']],
    take: ['took', 'taken'], know: ['knew', 'known'], think: ['thought', 'thought'], come: ['came', 'come'],
    go: ['went', 'gone'], have: ['had', 'had'], do: ['did', 'done'], show: ['showed', ['shown', 'showed']],
  };
  const [past, participle] = inflections[lemma] ?? [lemma + pastEnding, lemma + pastEnding];
  const irregular = ['不规则变化', 'Irregular form'];
  const endsWithE = lemma.endsWith('e') && !lemma.endsWith('ee');
  const ing = lemma === 'get' ? 'getting' : `${endsWithE ? lemma.slice(0, -1) : lemma}ing`;
  return [
    panel('present', ['I / you / we / they', 'he / she / it'], [['原形', 'Base form'], suffix(tail)], [lemma, lemma === 'have' ? 'has' : lemma + tail]),
    panel('past', [['各人称', 'All persons']], [past === lemma + pastEnding ? suffix(pastEnding) : irregular], [past], 1),
    panel('participle', [['词尾', 'Ending']], [participle === lemma + pastEnding ? suffix(pastEnding) : irregular], [participle], 1),
    panel('presentParticiple', [['词尾', 'Ending']], ['-ing'], [ing], 1),
  ];
}

const arabic = new Set(words('فعل طلب دخل وصل فتح ذهب نظر حمل لعب خرج كتب شرب درس جلس سكن سمع عمل'));
const arPeople = ['أنا', 'نحن', 'أنتَ', 'أنتِ', 'أنتما', 'أنتم', 'أنتنّ', 'هو', 'هي', 'هما (م)', 'هما (ف)', 'هم', 'هنّ'];
function arabicTables(lemma) {
  if (!arabic.has(lemma)) return [];
  const endings = words('تُ نَا تَ تِ تُمَا تُمْ تُنَّ َ تْ ا تَا وا نَ');
  return [panel('past', arPeople, endings.map(ending => ending === 'َ' ? '◌َ' : suffix(ending)),
    endings.map(ending => `${lemma}${ending}`), 3)];
}

const japaneseIchidan = new Set(words('いる できる くれる 見る 見える 食べる 入れる 使える 受ける あげる 始める なれる 決める 出る 感じる 続ける 言える'));
const japaneseGodan = new Set(words('思う 言う やる 行く しまう 違う わかる 使う 話す 考える 作る 持つ 死ぬ 入る 行う 買う 出す もらう 聞く 読む とる 変わる 終わる 続く なる'));
function japaneseTables(lemma) {
  const godanStems = { う: 'い', く: 'き', ぐ: 'ぎ', す: 'し', つ: 'ち', ぬ: 'に', ぶ: 'び', む: 'み', る: 'り' };
  let stem;
  if (japaneseIchidan.has(lemma)) stem = lemma.slice(0, -1);
  else if (japaneseGodan.has(lemma)) stem = lemma.slice(0, -1) + godanStems[lemma.at(-1)];
  else stem = { する: 'し', 来る: '来', 愛する: '愛し' }[lemma];
  if (!stem) return [];
  return [affixes('jaPolite', polarity, words('ます ません'), stem, 1), affixes('jaPast', polarity, words('ました ませんでした'), stem, 1)];
}

const koreanPatterns = {
  '하다': ['해요', '했어요', '-여요', '-였어요'],
  '보다': ['봐요', '봤어요', '-아요', '-았어요'],
  '모르다': ['몰라요', '몰랐어요', '-아요', '-았어요'],
  '먹다': ['먹어요', '먹었어요', '-어요', '-었어요'],
  '가다': ['가요', '갔어요', '-아요', '-았어요'],
  '오다': ['와요', '왔어요', '-아요', '-았어요'],
  '지나다': ['지나요', '지났어요', '-아요', '-았어요'],
};
function koreanTables(lemma) {
  const pattern = koreanPatterns[lemma];
  if (!pattern) return [];
  const [plain, past, presentEnding, pastEnding] = pattern, stem = lemma.slice(0, -1);
  return [
    panel('koPolite', polarity, [presentEnding, '-지 않아요'], [plain, `${stem}지 않아요`], 1),
    panel('koPast', polarity, [pastEnding, '-지 않았어요'], [past, `${stem}지 않았어요`], 1),
    ...(lemma === '하다' ? [panel('command', [['直说体', 'Plain']], ['-여라'], ['해라'], 1)] : []),
  ];
}

const hindi = new Set(words('करना जाना होना देना लेना खाना देखना आना बोलना लिखना'));
function hindiTables(lemma) {
  if (!hindi.has(lemma)) return [];
  const tables = [affixes('habitual', gender, words('ता ते ती ती'), lemma.slice(0, -2))];
  if (lemma === 'होना') tables.push(panel('present', ['मैं', 'हम / आप / वे', 'तुम', 'वह / यह'],
    words('हूँ हैं हो है'), words('हूँ हैं हो है')));
  return tables;
}

const idMarkers = ['sedang', 'sudah', 'belum', 'akan'];
const indonesian = new Set(words('makan minum datang pergi tahu punya suka ada belajar kerja bekerja membaca melihat pulang tidur'));
function indonesianTables(lemma) {
  if (!indonesian.has(lemma) && !idMarkers.includes(lemma)) return [];
  const forms = idMarkers.map(marker => indonesian.has(lemma) ? `${marker} ${lemma}` : marker);
  return [panel('markers', [['正在', 'In progress'], ['已经', 'Already'], ['还没', 'Not yet'], ['将要', 'Going to']], idMarkers, forms, 1)];
}

const providers = { es: spanishTables, fr: frenchTables, ru: russianTables, en: englishTables, ar: arabicTables,
  ja: japaneseTables, ko: koreanTables, hi: hindiTables, id: indonesianTables };
const previewKeys = { es: ['present', 'preterite', 'imperfect'], fr: ['present', 'imperfect', 'compound'], ko: ['koPolite', 'koPast'] };
const aliases = { hi: { 'है': 'होना', 'हैं': 'होना' }, ko: { '해라': '하다' } };

const enFixed = {
  would: ['modal', ['条件、委婉或过去习惯', 'Conditions, politeness or past habits']],
  "don't": ['negPresent', 'I / you / we / they', '-n’t'],
  "can't": ['modal', ['否定能力或可能性', 'Negative ability or possibility'], '-n’t'],
  "didn't": ['negPast', ['各人称', 'All persons'], '-n’t'],
  "doesn't": ['negPresent', 'he / she / it', '-n’t'],
  "won't": ['modal', ['将来或意愿 · 否定', 'Future or willingness · negative'], '-n’t'],
  "wouldn't": ['modal', ['条件或过去意愿 · 否定', 'Condition or past willingness · negative'], '-n’t'],
  "let's": ['suggestion', ['我们一起做', 'Let us do it'], '-’s'],
  cannot: ['modal', ['否定能力或可能性', 'Negative ability or possibility'], '-not'],
  "haven't": ['negPresent', 'I / you / we / they', '-n’t'],
  "couldn't": ['modal', ['能力或可能性 · 否定', 'Ability or possibility · negative'], '-n’t'],
  "aren't": ['negPresent', 'you / we / they', '-n’t'],
};

function fixedTables(display, language) {
  if (language === 'en' && enFixed[display]) {
    const [key, label, ending = ['固定形式', 'Fixed form']] = enFixed[display];
    const tables = [panel(key, [label], [ending], [display], 1)];
    if (display === 'would') tables.push(panel('modalPast', [['间接引语中的 will', 'Reported will']], [ending], [display], 1));
    if (display === "aren't") tables.push(panel('negPresent', [['I · 用于问句', 'I · in questions']], [ending], [display], 1));
    return tables;
  }
  if (language === 'es' && ['hacerlo', 'darle'].includes(display)) {
    return [panel('clitic', [display === 'hacerlo' ? ['直接宾语', 'Direct object'] : ['间接宾语', 'Indirect object']], [suffix(display.slice(-2))], [display], 1)];
  }
  if (language === 'fr' && ['voici', 'voilà'].includes(display)) {
    return [panel('presentation', [['这里', 'Here'], ['那里', 'There']], ['-ci', '-là'], ['voici', 'voilà'])];
  }
  if (language === 'ja') {
    if (['だ', 'です'].includes(display)) return [panel('jaPolite', [['普通体', 'Plain'], ['礼貌体', 'Polite']], ['-だ', '-です'], ['だ', 'です'])].map(table => ({ ...table, zh: '判断词 · 非过去', en: 'Copula · non-past' }));
    if (display === '下さい') return [panel('command', [['礼貌请求', 'Polite request']], ['-い'], ['下さい'], 1)];
  }
  if (language === 'ar' && display === 'يكونوا') {
    return ['arSubj', 'arJussive'].map(key => panel(key, ['هم'], ['يَـ … ـُوا'], ['يَكُونُوا'], 1));
  }
  if (language === 'id' && ['bisa', 'mau', 'adalah'].includes(display)) {
    if (display === 'adalah') return [panel('idCopula', [['肯定定义', 'Affirmative definition'], ['否定名词谓语', 'Negating a noun predicate']],
      [['固定形式', 'Fixed form'], 'bukan'], ['adalah', 'bukan'], 1)];
    const label = display === 'bisa' ? ['能力／可能', 'Ability or possibility'] : ['意愿／打算', 'Willingness or intention'];
    return [panel('modal', [label], [['动词前使用', 'Goes before the verb']], [display], 1)];
  }
  return [];
}

const posSlots = {
  es: new Map(esPeople.map((label, i) => [label, i]).concat([['usted', 4], ['ustedes', 5], ['vos', 2]])),
  fr: new Map(frPeople.map((label, i) => [label, i]).concat([['il / elle', 4], ['ils', 5]])),
  ru: new Map(['я', 'мы', 'ты', 'вы', 'он / она / оно', 'они'].map((label, i) => [label, i])),
  ar: new Map([['أنا', 0], ['نحن', 2], ['أنتَ', 3], ['أنتما', 4], ['أنتم', 5], ['أنتِ', 6], ['أنتنّ', 8],
    ['هو', 9], ['هما (م)', 10], ['هما · مذكر', 10], ['هم', 11], ['هي', 12], ['هما (ف)', 13], ['هما · مؤنث', 13], ['هنّ', 14]]),
};

function useFixedPositions(table, language) {
  const slots = posSlots[language];
  if (!slots || !table.cells.every(cell => slots.has(cell.label[0]))) return table;
  const ar = language === 'ar';
  const grid = Array.from({ length: ar ? 15 : 6 }, () => []);
  for (const cell of table.cells) grid[slots.get(cell.label[0])].push(cell);
  return { ...table, columns: ar ? 3 : 2, cells: grid.map(cells => cells.length < 2 ? cells[0] ?? { empty: true }
    : { variants: cells, selected: cells.some(cell => cell.selected) }) };
}

function referenceFor(entry) {
  const row = verbReferenceData[entry.entryId ?? entry.id];
  if (!row || row.display !== entry.display || row.lemma !== entry.lemma) return [];
  return row.tables.map(([index, selected]) => {
    const table = verbReferenceTables[index];
    return { ...table, source: true, cells: table.cells.map((cell, i) => ({ ...cell, selected: selected.includes(i) })) };
  });
}

function matchesForm(form, display, rawDisplay, language) {
  if (normalize(form, language) !== display) return false;
  if (language !== 'ar') return true;
  const finalVowel = rawDisplay.trim().match(/[َُِْ](?=[\u064b-\u065f]*$)/u)?.[0];
  return !finalVowel || form.endsWith(finalVowel);
}

export function verbTables(entry, language) {
  const provider = providers[language];
  if (!provider || !entry || (entry.pos !== 'verb' && !(language === 'id' && entry.pos === 'adv'))) return [];
  const display = normalize(entry.display, language), sourceLemma = normalize(entry.lemma, language);
  const lemma = aliases[language]?.[sourceLemma] ?? sourceLemma;
  if (!display || !lemma) return [];
  let tables = [...fixedTables(display, language), ...provider(lemma)];
  if (language === 'ja' && display === '説明' && lemma === '説明') tables = [
    affixes('jaPolite', polarity, words('ます ません'), '説明し', 1), affixes('jaPast', polarity, words('ました ませんでした'), '説明し', 1),
  ];
  const matched = tables.map(table => ({ ...table, cells: table.cells.map(cell => ({ ...cell,
    selected: cell.forms.some(form => matchesForm(form, display, entry.display, language)),
  })) })).filter(table => table.cells.some(cell => cell.selected));
  let curated = matched.length || display !== lemma ? matched : tables.filter(table => !previewKeys[language] || previewKeys[language].includes(table.key));
  if (language === 'hi' && ['है', 'हैं'].includes(display)) return curated;
  const reference = referenceFor(entry);
  if (language === 'ar' && reference.some(table => table.key === 'ar-past-active-indicative')) curated = curated.filter(table => table.key !== 'past');
  const sourced = reference.filter(table => !curated.some(existing => existing.key === table.key &&
    (!table.lemma || normalize(table.lemma, language) === lemma)));
  return [...curated, ...sourced].map(table => useFixedPositions(table, language));
}

export function verbTableMarkup(entry, language, ui = 'zh') {
  const tables = verbTables(entry, language);
  if (!tables.length) return '';
  const zh = ui === 'zh', locale = zh ? 0 : 1, columnsLabel = zh ? '动词语法表' : 'Verb forms';
  const preview = tables.every(table => table.cells.every(cell => !cell.selected));
  const caption = preview ? (zh ? '原形卡 · 下表供查阅' : 'Dictionary form · tables for reference') : '';
  const part = cell => `<bdi class="verb-cell-label" dir="auto">${esc(cell.label[locale])}</bdi><strong>${Array.isArray(cell.ending)
    ? esc(cell.ending[locale]) : `<bdi lang="${esc(language)}" dir="${language === 'ar' ? 'rtl' : 'auto'}">${esc(cell.ending)}</bdi>`}</strong>${cell.selected ? `<span class="sr-only">${zh ? '当前词形' : 'Current form'}</span>` : ''}`;
  const cellMarkup = cell => cell.empty ? `<li class="verb-empty" aria-label="${zh ? '无此形式' : 'No form'}">—</li>`
    : `<li${cell.selected ? ' class="verb-match"' : ''}>${cell.variants ? cell.variants.map(variant => `<div class="verb-variant">${part(variant)}</div>`).join('') : part(cell)}</li>`;
  const figures = tables.map(table => `<figure class="verb-table" data-tone="${table.tone}" data-grammar="${table.key}"><figcaption>${esc(zh ? table.zh : table.en)}${table.lemma ? ` <bdi>${esc(table.lemma)}</bdi>` : ''}</figcaption><ul class="verb-cells cols-${table.columns}" role="list">${table.cells.map(cellMarkup).join('')}</ul></figure>`);
  const source = tables.some(table => table.source) ? `<p class="verb-source"><a href="https://en.wiktionary.org/wiki/${esc(encodeURIComponent(entry.lemma))}" target="_blank" rel="noopener noreferrer">${zh ? '变位资料：英语维基词典贡献者' : 'Forms: English Wiktionary contributors'}</a> · <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a></p>` : '';
  return `<section class="verb-tables" lang="${zh ? 'zh' : 'en'}" aria-label="${esc(columnsLabel)}"><h3>${esc(columnsLabel)}</h3>${caption ? `<p>${esc(caption)}</p>` : ''}<div class="verb-table-list">${figures.join('')}</div>${source}</section>`;
}
