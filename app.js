'use strict';

/* ================= Telegram ================= */
const tg = window.Telegram && window.Telegram.WebApp;
const inTg = !!(tg && tg.initData);
const tgAtLeast = v => inTg && typeof tg.isVersionAtLeast === 'function' && tg.isVersionAtLeast(v);

if (inTg) {
  tg.ready();
  tg.expand();
  if (tgAtLeast('6.1')) {
    try { tg.setHeaderColor('secondary_bg_color'); tg.setBackgroundColor('secondary_bg_color'); } catch (e) {}
  }
}

function haptic(kind) {
  try { if (tgAtLeast('6.1')) tg.HapticFeedback.notificationOccurred(kind); } catch (e) {}
}

function confirmDialog(message) {
  return new Promise(resolve => {
    if (tgAtLeast('6.2')) tg.showConfirm(message, ok => resolve(!!ok));
    else resolve(window.confirm(message));
  });
}

/* ================= Хранилище прогресса =================
   CloudStorage: значение ≤ 4096 символов, поэтому JSON режется на куски
   p0, p1, … и количество кусков пишется в ключ pn.
   Вне Telegram — localStorage. */
const LOCAL_KEY = 'matan_progress_v1';
const FILTER_KEY = 'matan_filter_v1';
const CHUNK = 4000;
const useCloud = tgAtLeast('6.9') && !!tg.CloudStorage;

function cs(method, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CloudStorage timeout')), 6000);
    tg.CloudStorage[method](...args, (err, val) => {
      clearTimeout(timer);
      err ? reject(err) : resolve(val);
    });
  });
}

function localGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function localSet(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }

let cloudChunks = 0;

async function loadProgress() {
  const empty = { v: 1, b: {} };
  let local = null;
  try { local = JSON.parse(localGet(LOCAL_KEY)); } catch (e) {}
  if (useCloud) {
    try {
      const n = parseInt(await cs('getItem', 'pn'), 10) || 0;
      cloudChunks = n;
      if (n > 0) {
        const keys = Array.from({ length: n }, (_, i) => 'p' + i);
        const vals = await cs('getItems', keys);
        const obj = JSON.parse(keys.map(k => vals[k] || '').join(''));
        if (obj && obj.b) return obj;
      }
      // В облаке пусто — переносим то, что было на устройстве.
      if (local && local.b) { progress = local; saveProgress(); }
    } catch (e) {
      console.warn('CloudStorage недоступен, используется localStorage', e);
    }
  }
  return local && local.b ? local : empty;
}

let saving = false, savePending = false;
async function saveProgress() {
  const str = JSON.stringify(progress);
  localSet(LOCAL_KEY, str);
  if (!useCloud) return;
  if (saving) { savePending = true; return; }
  saving = true;
  try {
    const chunks = [];
    for (let i = 0; i < str.length; i += CHUNK) chunks.push(str.slice(i, i + CHUNK));
    for (let i = 0; i < chunks.length; i++) await cs('setItem', 'p' + i, chunks[i]);
    await cs('setItem', 'pn', String(chunks.length));
    if (cloudChunks > chunks.length) {
      const extra = [];
      for (let i = chunks.length; i < cloudChunks; i++) extra.push('p' + i);
      await cs('removeItems', extra);
    }
    cloudChunks = chunks.length;
  } catch (e) {
    console.warn('Не удалось сохранить в CloudStorage', e);
  } finally {
    saving = false;
    if (savePending) { savePending = false; saveProgress(); }
  }
}

/* ================= Данные и состояние ================= */
let CARDS = [];
let PARAGRAPHS = [];          // [{id, title, count}] в порядке появления
let progress = { v: 1, b: {} };  // b: { cardId: коробка 1..5 }; нет записи — новая карточка

const TYPE_LABEL = { definition: 'Определение', theorem: 'Теорема', lemma: 'Лемма', property: 'Свойство', corollary: 'Следствие' };
const TYPE_ACC = { definition: 'определение', theorem: 'теорему', lemma: 'лемму', property: 'свойство', corollary: 'следствие' };
const BOX_WEIGHT = [6, 16, 8, 4, 2, 1]; // индекс = коробка, 0 = новая
const LEARNED_BOX = 4;

const state = {
  stack: ['home'],
  session: null,
  query: '',
  filter: loadFilter(),
};

function loadFilter() {
  try {
    const f = JSON.parse(localGet(FILTER_KEY));
    if (f && Array.isArray(f.pars)) return { type: f.type || 'all', pars: f.pars };
  } catch (e) {}
  return { type: 'all', pars: [] };
}

const isDef = c => c.type === 'definition';
const hasProof = c => Array.isArray(c.proof_steps) && c.proof_steps.length > 0;
const boxOf = c => progress.b[c.id] || 0;

function filtered() {
  const { type, pars } = state.filter;
  return CARDS.filter(c =>
    (pars.length === 0 || pars.includes(c.paragraph)) &&
    (type === 'all' || (type === 'def' ? isDef(c) : !isDef(c))));
}

function rate(card, r) {
  const box = boxOf(card);
  let nb;
  if (r === 0) nb = 1;                         // Не знаю → в коробку 1
  else if (r === 1) nb = Math.max(1, box);     // С трудом → остаётся
  else nb = Math.min(5, Math.max(1, box) + 1); // Знаю → на коробку выше
  progress.b[card.id] = nb;
  haptic(r === 0 ? 'error' : r === 1 ? 'warning' : 'success');
  saveProgress();
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function weightedPick(pool, recent) {
  const k = Math.min(5, pool.length - 1);
  const avoid = new Set(k > 0 ? recent.slice(-k) : []);
  const cand = pool.filter(c => !avoid.has(c.id));
  const total = cand.reduce((s, c) => s + BOX_WEIGHT[boxOf(c)], 0);
  let x = Math.random() * total;
  for (const c of cand) { x -= BOX_WEIGHT[boxOf(c)]; if (x <= 0) return c; }
  return cand[cand.length - 1];
}

/* ================= DOM-помощники ================= */
const $ = sel => document.querySelector(sel);
const app = $('#app');

const MATH_DELIMS = [
  { left: '$$', right: '$$', display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '\\(', right: '\\)', display: false },
  { left: '$', right: '$', display: false },
];

function tex(el, text) {
  el.classList.add('tex');
  el.textContent = text || '';
  if (window.renderMathInElement) {
    window.renderMathInElement(el, { delimiters: MATH_DELIMS, throwOnError: false, errorColor: '#e5534b' });
  }
  return el;
}

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'tex') tex(el, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function boxLabel(c) {
  const b = boxOf(c);
  return b ? `коробка ${b}` : 'новая';
}

function cardMeta(c) {
  return h('div', { class: 'meta' },
    h('span', { class: 'tag', text: TYPE_LABEL[c.type] || c.type }),
    `${c.paragraph} · ${boxLabel(c)}`);
}

function questionEl(c, withProof) {
  const verb = withProof && hasProof(c) ? `Сформулируй и докажи ${TYPE_ACC[c.type] || 'утверждение'}` : `Сформулируй ${TYPE_ACC[c.type] || 'утверждение'}`;
  return h('div', { class: 'question' }, verb + ' ', h('span', { tex: '«' + c.title + '»' }));
}

function statementEl(c) {
  return [h('div', { class: 'label', text: TYPE_LABEL[c.type] || 'Ответ' }), h('div', { tex: c.statement })];
}

function stepsEl(c, count) {
  const n = count == null ? c.proof_steps.length : count;
  return h('ol', { class: 'steps' }, c.proof_steps.slice(0, n).map(s => h('li', { tex: s })));
}

function notesEl(c) {
  return c.notes ? [h('div', { class: 'label', text: 'Заметки' }), h('div', { class: 'notes', tex: c.notes })] : [];
}

function fullAnswer(c) {
  return h('div', { class: 'answer' },
    statementEl(c),
    hasProof(c) ? [h('div', { class: 'label', text: 'Доказательство' }), stepsEl(c)] : null,
    notesEl(c));
}

function rateRow(c, after) {
  const mk = (r, cls, text) => h('button', { class: cls, text, onclick: () => { rate(c, r); after(r); } });
  return h('div', { class: 'rate' }, mk(0, 'r0', 'Не знаю'), mk(1, 'r1', 'С трудом'), mk(2, 'r2', 'Знаю'));
}

function btn(text, onclick, cls = '') {
  return h('button', { class: 'btn ' + cls, text, onclick });
}

function emptyMsg(text) {
  return h('div', { class: 'card center' },
    h('p', { text }),
    btn('Изменить фильтр', openFilter, 'primary wide'));
}

/* ================= Навигация ================= */
const TITLES = {
  home: 'Матанализ', cards: 'Карточки', proof: 'Доказательства', srs: 'Повторение',
  ticket: 'Билет', progress: 'Прогресс', detail: 'Карточка', paragraphs: 'По параграфам', learn: 'Параграф',
};

function go(view, session) {
  state.stack.push(view);
  state.session = session || null;
  render();
  window.scrollTo(0, 0);
}

function back() {
  if (state.stack.length > 1) state.stack.pop();
  state.session = null;
  const v = current();
  if (INIT[v]) state.session = INIT[v]();
  render();
}

const current = () => state.stack[state.stack.length - 1];

const backBtn = $('#backBtn');
backBtn.addEventListener('click', back);
if (tgAtLeast('6.1')) tg.BackButton.onClick(back);

function render() {
  const v = current();
  $('#screenTitle').textContent =
    v === 'srs' && state.session && state.session.weak ? 'Слабые карточки'
      : v === 'learn' && state.session ? `${state.session.par.id} ${state.session.par.title}`
        : TITLES[v];
  const root = state.stack.length <= 1;
  if (tgAtLeast('6.1')) {
    root ? tg.BackButton.hide() : tg.BackButton.show();
    backBtn.hidden = true;
  } else {
    backBtn.hidden = root;
  }
  $('#filterBtn').hidden = ['progress', 'detail', 'paragraphs', 'learn'].includes(v);
  updateFilterChip();
  app.replaceChildren(...[].concat(VIEWS[v]()).flat().filter(x => x != null && x !== false));
}

/* ================= Экраны ================= */
const INIT = {
  cards: (shuffled = false) => ({ list: shuffled ? shuffle(filtered()) : filtered(), i: 0, revealed: false, shuffled, stats: [0, 0, 0] }),
  proof: () => ({ list: filtered().filter(hasProof), i: 0, shown: 0 }),
  srs: (weak = false) => ({ weak, card: null, revealed: false, recent: [], done: 0 }),
  ticket: () => makeTicket(),
};

const VIEWS = {
  home() {
    const list = filtered();
    const weak = list.filter(c => boxOf(c) > 0 && boxOf(c) <= 2).length;
    const tile = (ico, title, sub, onclick) =>
      h('button', { class: 'tile', onclick }, h('div', { class: 'ico', text: ico }), h('b', { text: title }), h('span', { text: sub }));

    const results = h('div');
    const search = h('input', {
      class: 'search', type: 'search', placeholder: 'Поиск по названию…', value: state.query,
      oninput: e => { state.query = e.target.value; renderSearch(results); },
    });
    renderSearch(results);

    return [
      search,
      results,
      h('p', { class: 'muted small', text: `В выборке: ${list.length} из ${CARDS.length} карточек` }),
      h('div', { class: 'tiles' },
        h('button', { class: 'tile wide', onclick: () => go('paragraphs') },
          h('div', { class: 'ico', text: '📚' }), h('b', { text: 'По параграфам' }),
          h('span', { text: lastPos() ? `Продолжить: ${lastPos().par.id}, карточка ${lastPos().i + 1} из ${lastPos().list.length}` : 'Учить §1, §2, … по порядку' })),
        tile('🃏', 'Карточки', 'Вопрос → ответ → самооценка', () => go('cards', INIT.cards())),
        tile('🪜', 'Доказательства', 'Шаги открываются по одному', () => go('proof', INIT.proof())),
        tile('🔁', 'Повторение', 'Лейтнер, 5 коробок', () => go('srs', INIT.srs(false))),
        tile('🎫', 'Билет', '2–3 вопроса как на коллоквиуме', () => go('ticket', INIT.ticket()))),
      btn(`Повторить слабые (${weak})`, () => go('srs', INIT.srs(true)), 'wide'),
      btn('Прогресс', () => go('progress'), 'wide'),
    ];
  },

  detail() {
    const c = state.session.card;
    return h('div', { class: 'card' },
      cardMeta(c),
      h('h3', { tex: c.title }),
      h('div', { class: 'meta', text: c.paragraph_title }),
      fullAnswer(c),
      rateRow(c, () => render()));
  },

  cards() {
    const s = state.session;
    const top = h('div', { class: 'row-between' },
      h('span', { class: 'muted small', text: s.list.length ? `${Math.min(s.i + 1, s.list.length)} / ${s.list.length}` : '' }),
      h('button', { class: 'chip' + (s.shuffled ? ' on' : ''), text: 'Перемешать', onclick: () => { state.session = INIT.cards(!s.shuffled); render(); } }));
    if (!s.list.length) return emptyMsg('Нет карточек для выбранного фильтра.');
    if (s.i >= s.list.length) {
      return [top, h('div', { class: 'card center' },
        h('h3', { text: 'Круг пройден' }),
        h('p', { class: 'muted', text: `Знаю: ${s.stats[2]} · С трудом: ${s.stats[1]} · Не знаю: ${s.stats[0]}` }),
        btn('Ещё раз', () => { state.session = INIT.cards(s.shuffled); render(); }, 'primary wide'))];
    }
    const c = s.list[s.i];
    const next = r => { if (r != null) s.stats[r]++; s.i++; s.revealed = false; render(); window.scrollTo(0, 0); };
    return [top, h('div', { class: 'card' },
      cardMeta(c),
      questionEl(c, false),
      s.revealed
        ? [h('div', { class: 'answer' }, statementEl(c), notesEl(c)), rateRow(c, next)]
        : h('div', { class: 'btn-row' },
          btn('Пропустить', () => next(null)),
          btn('Показать ответ', () => { s.revealed = true; render(); }, 'primary')))];
  },

  proof() {
    const s = state.session;
    if (!s.list.length) return emptyMsg('В выборке нет утверждений с доказательством.');
    const c = s.list[s.i];
    const total = c.proof_steps.length;
    const move = d => { s.i = (s.i + d + s.list.length) % s.list.length; s.shown = 0; render(); window.scrollTo(0, 0); };
    const nav = h('div', { class: 'row-between' },
      h('button', { class: 'chip', text: '‹ Пред.', onclick: () => move(-1) }),
      h('span', { class: 'muted small', text: `${s.i + 1} / ${s.list.length}` }),
      h('button', { class: 'chip', text: 'След. ›', onclick: () => move(1) }));
    return [nav, h('div', { class: 'card' },
      cardMeta(c),
      h('h3', { tex: c.title }),
      h('div', { tex: c.statement }),
      h('div', { class: 'answer' },
        h('div', { class: 'label', text: `Доказательство · ${s.shown} из ${total}` }),
        s.shown ? stepsEl(c, s.shown) : h('p', { class: 'muted small', text: 'Вспомни первый шаг и открой его.' }),
        s.shown < total
          ? h('div', { class: 'btn-row' },
            btn('Показать все', () => { s.shown = total; render(); }),
            btn('Следующий шаг', () => { s.shown++; render(); }, 'primary'))
          : [notesEl(c), rateRow(c, () => move(1))]))];
  },

  srs() {
    const s = state.session;
    const pool = s.weak
      ? filtered().filter(c => boxOf(c) > 0 && boxOf(c) <= 2)
      : filtered();
    if (!pool.length) {
      return s.weak
        ? h('div', { class: 'card center' },
          h('h3', { text: s.done ? 'Слабые карточки закончились 🎉' : 'Слабых карточек нет' }),
          h('p', { class: 'muted', text: 'Слабые — карточки из коробок 1 и 2.' }),
          btn('Обычное повторение', () => { state.session = INIT.srs(false); render(); }, 'primary wide'))
        : emptyMsg('Нет карточек для выбранного фильтра.');
    }
    if (!s.card) s.card = weightedPick(pool, s.recent);
    const c = s.card;
    const counts = [0, 0, 0, 0, 0, 0];
    pool.forEach(x => counts[boxOf(x)]++);
    const next = () => { s.recent.push(c.id); s.done++; s.card = null; s.revealed = false; render(); window.scrollTo(0, 0); };
    return [
      h('div', { class: 'muted small', style: 'margin-bottom:8px' },
        `Повторено: ${s.done} · ` + counts.map((n, b) => `${b ? b : 'нов.'}: ${n}`).join(' · ')),
      h('div', { class: 'card' },
        cardMeta(c),
        questionEl(c, true),
        s.revealed
          ? [fullAnswer(c), rateRow(c, next)]
          : btn('Показать ответ', () => { s.revealed = true; render(); }, 'primary wide')),
    ];
  },

  ticket() {
    const s = state.session;
    if (!s.cards.length) return emptyMsg('В выборке нет теорем с доказательством — билет не собрать.');
    return [
      h('div', { class: 'card' },
        h('h3', { text: `Билет № ${s.number}` }),
        h('p', { class: 'muted small', text: s.ready ? 'Сравни свой ответ и оцени себя.' : 'Подготовь ответы на листочке, затем нажми «Готов».' }),
        s.cards.map((c, i) => h('div', { class: 'ticket-q' },
          h('div', { class: 'meta', text: `Вопрос ${i + 1} · ${c.paragraph}` }),
          questionEl(c, true),
          s.ready ? [fullAnswer(c), s.rated[i] == null
            ? rateRow(c, r => { s.rated[i] = r; render(); })
            : h('p', { class: 'muted small', text: `Оценка: ${['Не знаю', 'С трудом', 'Знаю'][s.rated[i]]} → ${boxLabel(c)}` })] : null))),
      s.ready
        ? btn('Новый билет', () => { state.session = makeTicket(); render(); window.scrollTo(0, 0); }, 'primary wide')
        : btn('Готов', () => { s.ready = true; render(); }, 'primary wide'),
    ];
  },

  progress() {
    const counts = [0, 0, 0, 0, 0, 0];
    CARDS.forEach(c => counts[boxOf(c)]++);
    const learned = CARDS.filter(c => boxOf(c) >= LEARNED_BOX).length;
    const colors = ['var(--sep)', 'var(--bad)', '#f08c3a', 'var(--mid)', '#8bc34a', 'var(--good)'];
    const bar = cs => h('div', { class: 'bar' },
      [1, 2, 3, 4, 5].map(b => cs[b] ? h('i', { style: `width:${cs[b] / cs.total * 100}%;background:${colors[b]}` }) : null));

    return [
      h('div', { class: 'card' },
        h('h3', { text: `Выучено: ${Math.round(learned / CARDS.length * 100)}%` }),
        h('p', { class: 'muted small', text: `${learned} из ${CARDS.length} карточек в коробках ${LEARNED_BOX}–5` }),
        h('div', { class: 'boxes' },
          counts.map((n, b) => h('div', { class: 'box' }, h('b', { text: n }), h('span', { text: b ? `коробка ${b}` : 'новые' }))))),
      h('div', { class: 'card' },
        h('div', { class: 'label', style: 'margin-top:0', text: 'По параграфам' }),
        PARAGRAPHS.map(p => {
          const cs = { total: 0 };
          let l = 0;
          CARDS.filter(c => c.paragraph === p.id).forEach(c => { const b = boxOf(c); cs[b] = (cs[b] || 0) + 1; cs.total++; if (b >= LEARNED_BOX) l++; });
          return h('div', { class: 'par-row' },
            h('div', { class: 'row-between' },
              h('span', null, h('b', { text: p.id + ' ' }), p.title),
              h('span', { class: 'muted', text: `${Math.round(l / cs.total * 100)}%` })),
            bar(cs));
        })),
      btn('Сбросить прогресс', async () => {
        if (await confirmDialog('Сбросить весь прогресс? Все карточки вернутся в «новые». Отменить это нельзя.')) {
          progress = { v: 1, b: {} };
          await saveProgress();
          haptic('warning');
          render();
        }
      }, 'danger wide'),
      h('p', { class: 'muted small center', text: useCloud ? 'Прогресс хранится в Telegram и синхронизируется между устройствами.' : 'Прогресс хранится в этом браузере (localStorage).' }),
    ];
  },
};

/* ---------- Учить по параграфам ---------- */
function lastPos() {
  const pos = progress.pos;
  if (!pos) return null;
  const par = PARAGRAPHS.find(p => p.id === pos.p);
  if (!par) return null;
  const list = CARDS.filter(c => c.paragraph === par.id);
  return pos.i < list.length ? { par, list, i: pos.i } : null;
}

function setPos(s) {
  if (s.i < s.list.length) progress.pos = { p: s.par.id, i: s.i };
  else {
    const next = PARAGRAPHS[PARAGRAPHS.indexOf(s.par) + 1];
    progress.pos = next ? { p: next.id, i: 0 } : null;
  }
  saveProgress();
}

function openPar(par, i = 0, replace = false) {
  const session = { par, list: CARDS.filter(c => c.paragraph === par.id), i, revealed: false, shown: 0, stats: [0, 0, 0] };
  setPos(session);
  if (replace) { state.session = session; render(); window.scrollTo(0, 0); }
  else go('learn', session);
}

function parStats(par) {
  const list = CARDS.filter(c => c.paragraph === par.id);
  const cs = { total: list.length };
  let learned = 0;
  list.forEach(c => { const b = boxOf(c); cs[b] = (cs[b] || 0) + 1; if (b >= LEARNED_BOX) learned++; });
  return { cs, learned };
}

const BOX_COLORS = ['var(--sep)', 'var(--bad)', '#f08c3a', 'var(--mid)', '#8bc34a', 'var(--good)'];
function boxBar(cs) {
  return h('div', { class: 'bar' },
    [1, 2, 3, 4, 5].map(b => cs[b] ? h('i', { style: `width:${cs[b] / cs.total * 100}%;background:${BOX_COLORS[b]}` }) : null));
}

VIEWS.paragraphs = function () {
  const lp = lastPos();
  return [
    lp ? btn(`Продолжить: ${lp.par.id}, карточка ${lp.i + 1} из ${lp.list.length}`, () => openPar(lp.par, lp.i), 'primary wide') : null,
    h('p', { class: 'muted small', text: 'Карточки параграфа идут в том порядке, как в конспекте. Оценки двигают карточки по коробкам, как в остальных режимах.' }),
    h('div', { class: 'list' }, PARAGRAPHS.map(p => {
      const { cs, learned } = parStats(p);
      const isCur = lp && lp.par === p;
      return h('button', { class: 'list-item', onclick: () => openPar(p, isCur ? lp.i : 0) },
        h('div', { class: 'row-between', style: 'margin:0' },
          h('span', null, h('b', { text: p.id + ' ' }), p.title),
          h('span', { class: 'muted small', style: 'white-space:nowrap', text: `${learned}/${cs.total}` })),
        boxBar(cs),
        isCur ? h('div', { class: 'meta', text: `▶ остановился на карточке ${lp.i + 1}` }) : null);
    })),
  ];
};

VIEWS.learn = function () {
  const s = state.session;
  const next = PARAGRAPHS[PARAGRAPHS.indexOf(s.par) + 1];
  if (s.i >= s.list.length) {
    const { cs, learned } = parStats(s.par);
    return h('div', { class: 'card center' },
      h('h3', { text: `${s.par.id} пройден` }),
      h('p', { class: 'muted', text: `Знаю: ${s.stats[2]} · С трудом: ${s.stats[1]} · Не знаю: ${s.stats[0]}` }),
      h('p', { class: 'muted small', text: `Выучено в параграфе: ${learned} из ${cs.total}` }),
      next
        ? btn(`Дальше: ${next.id} ${next.title}`, () => openPar(next, 0, true), 'primary wide')
        : h('p', { text: 'Это был последний параграф 🎉' }),
      btn('Пройти параграф ещё раз', () => openPar(s.par, 0, true), 'wide'),
      btn('К списку параграфов', back, 'wide'));
  }
  const c = s.list[s.i];
  const total = hasProof(c) ? c.proof_steps.length : 0;
  const move = d => {
    s.i = Math.max(0, s.i + d); s.revealed = false; s.shown = 0;
    setPos(s); render(); window.scrollTo(0, 0);
  };
  const nav = h('div', { class: 'row-between' },
    h('button', { class: 'chip', text: '‹ Пред.', disabled: s.i === 0, onclick: () => move(-1) }),
    h('span', { class: 'muted small', text: `${s.i + 1} / ${s.list.length}` }),
    h('button', { class: 'chip', text: 'След. ›', onclick: () => move(1) }));

  let body;
  if (!s.revealed) {
    body = h('div', { class: 'btn-row' },
      btn('Пропустить', () => move(1)),
      btn('Показать ответ', () => { s.revealed = true; render(); }, 'primary'));
  } else {
    const proofDone = s.shown >= total;
    body = [
      h('div', { class: 'answer' },
        statementEl(c),
        total ? [
          h('div', { class: 'label', text: `Доказательство · ${s.shown} из ${total}` }),
          s.shown ? stepsEl(c, s.shown) : h('p', { class: 'muted small', text: 'Вспомни первый шаг и открой его.' }),
          proofDone ? null : h('div', { class: 'btn-row' },
            btn('Показать все', () => { s.shown = total; render(); }),
            btn('Следующий шаг', () => { s.shown++; render(); }, 'primary')),
        ] : null,
        proofDone ? notesEl(c) : null),
      proofDone ? rateRow(c, r => { s.stats[r]++; move(1); }) : null,
    ];
  }
  return [nav, h('div', { class: 'card' }, cardMeta(c), questionEl(c, true), body)];
};

function renderSearch(container) {
  const q = state.query.trim().toLowerCase();
  if (!q) { container.replaceChildren(); return; }
  const found = CARDS.filter(c => c.title.toLowerCase().includes(q)).slice(0, 50);
  container.replaceChildren(found.length
    ? h('div', { class: 'list' }, found.map(c => h('button', {
      class: 'list-item',
      onclick: () => go('detail', { card: c }),
    }, h('div', { tex: c.title }), h('div', { class: 'meta', text: `${TYPE_LABEL[c.type]} · ${c.paragraph} · ${boxLabel(c)}` }))))
    : h('p', { class: 'muted small', text: 'Ничего не найдено.' }));
}

let ticketNo = 0;
function makeTicket() {
  const pool = filtered();
  const proofs = pool.filter(c => !isDef(c) && hasProof(c));
  if (!proofs.length) return { cards: [], ready: false, rated: [] };
  const n = Math.random() < 0.5 ? 2 : 3;
  const main = proofs[Math.floor(Math.random() * proofs.length)];
  const rest = shuffle(pool.filter(c => c.id !== main.id)).slice(0, n - 1);
  const cards = [...rest.filter(isDef), main, ...rest.filter(c => !isDef(c))];
  return { cards, ready: false, rated: [], number: ++ticketNo };
}

/* ================= Фильтр ================= */
const sheet = $('#filterSheet');
let draft = null;

function updateFilterChip() {
  const f = state.filter;
  const on = f.type !== 'all' || f.pars.length > 0;
  const chip = $('#filterBtn');
  chip.classList.toggle('on', on);
  const parts = [];
  if (f.pars.length) parts.push(f.pars.length === 1 ? f.pars[0] : `${f.pars.length} §`);
  if (f.type !== 'all') parts.push(f.type === 'def' ? 'опр.' : 'теор.');
  chip.textContent = on ? parts.join(' · ') : 'Фильтр';
}

function openFilter() {
  draft = { type: state.filter.type, pars: state.filter.pars.slice() };
  drawFilter();
  sheet.hidden = false;
}

function drawFilter() {
  document.querySelectorAll('#typeSeg button').forEach(b => b.classList.toggle('on', b.dataset.type === draft.type));
  $('#parList').replaceChildren(...PARAGRAPHS.map(p => {
    const cnt = CARDS.filter(c => c.paragraph === p.id && (draft.type === 'all' || (draft.type === 'def' ? isDef(c) : !isDef(c)))).length;
    return h('label', null,
      h('input', {
        type: 'checkbox', checked: draft.pars.includes(p.id),
        onchange: e => {
          draft.pars = e.target.checked ? [...draft.pars, p.id] : draft.pars.filter(x => x !== p.id);
        },
      }),
      h('span', null, h('b', { text: p.id + ' ' }), p.title),
      h('span', { class: 'cnt', text: cnt }));
  }));
}

$('#filterBtn').addEventListener('click', openFilter);
$('#filterClose').addEventListener('click', () => { sheet.hidden = true; });
sheet.addEventListener('click', e => { if (e.target === sheet) sheet.hidden = true; });
$('#typeSeg').addEventListener('click', e => {
  const t = e.target.closest('button');
  if (t) { draft.type = t.dataset.type; drawFilter(); }
});
$('#parAll').addEventListener('click', () => { draft.pars = PARAGRAPHS.map(p => p.id); drawFilter(); });
$('#parNone').addEventListener('click', () => { draft.pars = []; drawFilter(); });
$('#filterApply').addEventListener('click', () => {
  // «Все параграфы отмечены» = «без фильтра по параграфам»
  if (draft.pars.length === PARAGRAPHS.length) draft.pars = [];
  state.filter = draft;
  localSet(FILTER_KEY, JSON.stringify(draft));
  sheet.hidden = true;
  const v = current();
  if (INIT[v]) state.session = v === 'srs' ? INIT.srs(state.session.weak) : INIT[v]();
  render();
});

/* ================= Запуск ================= */
async function start() {
  try {
    const res = await fetch('cards.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    CARDS = (data.cards || []).filter(c => c && c.id && c.title);
    if (data.subject) document.title = data.subject;
  } catch (e) {
    app.replaceChildren(h('div', { class: 'card' },
      h('h3', { text: 'Не удалось загрузить cards.json' }),
      h('p', { class: 'muted', text: String(e.message || e) }),
      h('p', { class: 'muted small', text: 'Если файл открыт напрямую с диска (file://), запусти локальный сервер или открой страницу на GitHub Pages.' })));
    return;
  }
  const seen = new Map();
  for (const c of CARDS) {
    if (!seen.has(c.paragraph)) seen.set(c.paragraph, { id: c.paragraph, title: c.paragraph_title, count: 0 });
    seen.get(c.paragraph).count++;
  }
  PARAGRAPHS = [...seen.values()];
  state.filter.pars = state.filter.pars.filter(p => seen.has(p));

  progress = await loadProgress();
  render();
}

start();
