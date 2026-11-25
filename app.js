// Kalko – dnevnik kalorij (PWA, vse se shrani lokalno na telefonu)
// --------------------------------------------------------------
// Viri podatkov:
//  - Open Food Facts (odprta baza izdelkov, vključno s slovenskimi – EAN 383…)
//  - Lastni izdelki (ročno vneseni ali prebrani z etikete) – shranjeni lokalno
//  - Claude API (prepoznava hrane s slike, branje tabele hranilnih vrednosti)

const OFF = 'https://world.openfoodfacts.org';
const OFF_FIELDS = 'code,product_name,product_name_sl,generic_name,brands,quantity,serving_quantity,nutriments,image_front_small_url';
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.6.0/+esm';
const MODEL = 'claude-opus-5-5';

const MEALS = [
  { id: 'zajtrk', name: 'Zajtrk', icon: '🌅' },
  { id: 'kosilo', name: 'Kosilo', icon: '☀️' },
  { id: 'vecerja', name: 'Večerja', icon: '🌙' },
];

// ---------- Shramba (localStorage) ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('kalko.' + key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('kalko.' + key, JSON.stringify(value)); }
    catch { toast('Shranjevanje ni uspelo (poln pomnilnik?)'); }
  },
};

// Razmerja makrohranil (% energije: beljakovine / ogljikovi hidrati / maščobe).
// To so pogoste splošne razdelitve, ne medicinsko priporočilo.
const RATIOS = [
  { id: 'uravnotezeno', name: 'Uravnoteženo', p: 30, c: 40, f: 30 },
  { id: 'beljakovinsko', name: 'Visoko beljakovinsko', p: 40, c: 30, f: 30 },
  { id: 'nizkooh', name: 'Nizko OH', p: 35, c: 20, f: 45 },
  { id: 'sportno', name: 'Športno (več OH)', p: 25, c: 55, f: 20 },
];

/** Iz kcal in razmerja izračuna grame (1 g B/OH = 4 kcal, 1 g M = 9 kcal). */
function goalFromRatio(kcal, ratioId) {
  const r = RATIOS.find((x) => x.id === ratioId) || RATIOS[0];
  return {
    kcal,
    p: Math.round((kcal * r.p) / 100 / 4),
    c: Math.round((kcal * r.c) / 100 / 4),
    f: Math.round((kcal * r.f) / 100 / 9),
  };
}

const DEFAULT_SETTINGS = {
  goal: goalFromRatio(2200, 'uravnotezeno'),
  ratio: 'uravnotezeno',
  goalWeight: 0,         // ciljna teža v kg (0 = ni nastavljena)
  breakfastEnd: '10:30', // do te ure = zajtrk
  lunchEnd: '16:30',     // do te ure = kosilo, potem večerja
  apiKey: '',
};
let settings = { ...DEFAULT_SETTINGS, ...store.get('settings', {}) };
// makri se vedno izračunajo iz kcal + razmerja
settings.goal = goalFromRatio(Number(settings.goal && settings.goal.kcal) || 2200, settings.ratio);

let log = store.get('log', {});          // { 'YYYY-MM-DD': [entry, ...] }
let myFoods = store.get('foods', {});    // { key: food }
let recent = store.get('recent', []);    // [food, ...] zadnjih 30
let weights = store.get('weights', {});  // { 'YYYY-MM-DD': kg }

const state = { date: todayKey() };

// ---------- Pomožne funkcije ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r0 = (n) => Math.round(Number(n) || 0);
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function shiftDay(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  return todayKey(new Date(y, m - 1, d + delta));
}
function dateLabel(key) {
  if (key === todayKey()) return 'Danes';
  if (key === shiftDay(todayKey(), -1)) return 'Včeraj';
  if (key === shiftDay(todayKey(), 1)) return 'Jutri';
  const [y, m, d] = key.split('-').map(Number);
  const dni = ['ned', 'pon', 'tor', 'sre', 'čet', 'pet', 'sob'];
  return `${dni[new Date(y, m - 1, d).getDay()]}, ${d}. ${m}. ${y}`;
}
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Obrok glede na trenutno uro (meje nastaviš v Nastavitvah). */
function mealByTime(date = new Date()) {
  const t = date.getHours() * 60 + date.getMinutes();
  if (t < toMin(settings.breakfastEnd)) return 'zajtrk';
  if (t < toMin(settings.lunchEnd)) return 'kosilo';
  return 'vecerja';
}

/** Hranilne vrednosti za podano količino (per100 = na 100 g). */
function calc(per100, grams) {
  const k = (Number(grams) || 0) / 100;
  return { kcal: per100.kcal * k, p: per100.p * k, c: per100.c * k, f: per100.f * k };
}

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

function saveLog() { store.set('log', log); }
function rememberRecent(food) {
  const key = food.barcode || food.name;
  recent = [food, ...recent.filter((f) => (f.barcode || f.name) !== key)].slice(0, 30);
  store.set('recent', recent);
}

// ---------- Izris glavnega zaslona ----------
function render() {
  $('#dateLabel').textContent = dateLabel(state.date);
  const entries = log[state.date] || [];
  const tot = { kcal: 0, p: 0, c: 0, f: 0 };
  entries.forEach((e) => { const n = calc(e.per100, e.grams); for (const k in tot) tot[k] += n[k]; });

  // Obroč
  const goal = settings.goal.kcal || 1;
  const left = goal - tot.kcal;
  const ratio = Math.min(tot.kcal / goal, 1);
  const C = 2 * Math.PI * 52;
  const ring = $('#ringFg');
  ring.style.strokeDasharray = C;
  ring.style.strokeDashoffset = C * (1 - ratio);
  ring.classList.toggle('over', left < 0);
  ring.style.opacity = tot.kcal > 0 ? 1 : 0; // brez pike pri 0 kcal
  $('#kcalLeft').textContent = r0(Math.abs(left));
  $('#kcalLeftLabel').textContent = left >= 0 ? 'kcal ostane' : 'kcal preko';
  $('#kcalEaten').textContent = r0(tot.kcal) + ' kcal';
  $('#kcalGoal').textContent = r0(goal) + ' kcal';

  // Makrohranila
  const macro = (label, val, g, color) => `
    <div class="macro-row">
      <div class="lbl"><span>${label}</span><b>${r0(val)} / ${r0(g)} g</b></div>
      <div class="bar"><i style="width:${Math.min(100, (val / (g || 1)) * 100)}%;background:${color}"></i></div>
    </div>`;
  $('#macros').innerHTML =
    macro('Beljakovine', tot.p, settings.goal.p, 'var(--protein)') +
    macro('Ogljikovi hidrati', tot.c, settings.goal.c, 'var(--carbs)') +
    macro('Maščobe', tot.f, settings.goal.f, 'var(--fat)');

  renderWeightCard();

  // Obroki
  $('#meals').innerHTML = MEALS.map((m) => {
    const list = entries.filter((e) => e.meal === m.id);
    const kcal = list.reduce((s, e) => s + calc(e.per100, e.grams).kcal, 0);
    const rows = list.map((e) => `
      <button class="entry" data-id="${e.id}">
        ${e.img ? `<img class="entry-img" src="${esc(e.img)}" alt="">` : `<div class="entry-img">${e.source === 'ai' ? '✨' : '🍽'}</div>`}
        <div class="entry-main">
          <div class="entry-name">${esc(e.name)}</div>
          <div class="entry-sub">${r0(e.grams)} g${e.brand ? ' · ' + esc(e.brand) : ''}</div>
        </div>
        <div class="entry-kcal">${r0(calc(e.per100, e.grams).kcal)}</div>
      </button>`).join('');
    return `
      <section class="card">
        <div class="meal-head">
          <div class="meal-title">${m.icon} ${m.name}</div>
          <div class="meal-kcal">${r0(kcal)} kcal</div>
        </div>
        ${rows || '<div class="meal-empty">Še nič vneseno.</div>'}
        <button class="add-mini" data-add="${m.id}">+ Dodaj</button>
      </section>`;
  }).join('');
}

// ---------- Teža ----------
/** Vse meritve, urejene po datumu: [{date, kg}] */
const weightList = () => Object.keys(weights).sort().map((date) => ({ date, kg: weights[date] }));
const fmtKg = (n) => (Math.round(n * 10) / 10).toLocaleString('sl-SI', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const shortDate = (key) => { const [, m, d] = key.split('-').map(Number); return `${d}. ${m}.`; };

/** Povprečje meritev v obdobju (endKey-days, endKey]. Vrne null, če ni meritev. */
function avgWeight(list, endKey, days) {
  const from = shiftDay(endKey, -days);
  const sel = list.filter((p) => p.date > from && p.date <= endKey);
  return sel.length ? sel.reduce((s, p) => s + p.kg, 0) / sel.length : null;
}
/** Drseče 7-dnevno povprečje za vsako meritev (glajenje dnevnih nihanj). */
const movingAvg = (list) => list.map((p) => ({ date: p.date, kg: avgWeight(list, p.date, 7) }));
/** Povprečen dnevni vnos kcal v zadnjih `days` dneh (šteje samo dneve z vnosi). */
function avgKcal(endKey, days) {
  let sum = 0, n = 0;
  for (let i = 0; i < days; i++) {
    const e = log[shiftDay(endKey, -i)];
    if (e && e.length) { sum += e.reduce((s, x) => s + calc(x.per100, x.grams).kcal, 0); n++; }
  }
  return n ? { kcal: sum / n, days: n } : null;
}
const signed = (d) => `${d > 0 ? '+' : ''}${fmtKg(d)}`;
const trendCls = (d) => (d < -0.05 ? 'down' : d > 0.05 ? 'up' : '');

/** SVG graf teže. Os X je časovna (po dnevih), ne po številu meritev. */
function weightChart(list, { w = 340, h = 180, axes = true, goal = 0 } = {}) {
  if (list.length < 2) return '';
  const pad = axes ? { l: 34, r: 8, t: 10, b: 20 } : { l: 3, r: 3, t: 4, b: 4 };
  const day = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  const x0 = day(list[0].date), x1 = Math.max(day(list[list.length - 1].date), x0 + 1);
  const vals = list.map((p) => p.kg).concat(axes && goal ? [goal] : []);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
  const X = (k) => pad.l + ((day(k) - x0) / (x1 - x0)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  const pts = list.map((p) => `${X(p.date).toFixed(1)},${Y(p.kg).toFixed(1)}`).join(' ');
  const area = `${X(list[0].date)},${h - pad.b} ${pts} ${X(list[list.length - 1].date)},${h - pad.b}`;
  let extra = '';
  if (axes) {
    for (let i = 0; i <= 3; i++) {
      const v = lo + ((hi - lo) * i) / 3, y = Y(v);
      extra += `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}"/><text x="${pad.l - 6}" y="${y + 4}" text-anchor="end">${fmtKg(v)}</text>`;
    }
    extra += `<text x="${pad.l}" y="${h - 4}">${shortDate(list[0].date)}</text><text x="${w - pad.r}" y="${h - 4}" text-anchor="end">${shortDate(list[list.length - 1].date)}</text>`;
    if (goal) extra += `<line class="goal" x1="${pad.l}" x2="${w - pad.r}" y1="${Y(goal)}" y2="${Y(goal)}"/>`;
  }
  const last = list[list.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="${axes ? 'w-chart' : 'w-spark'}" aria-hidden="true">
    <defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22c55e" stop-opacity=".22"/><stop offset="1" stop-color="#22c55e" stop-opacity="0"/></linearGradient></defs>
    ${extra}
    <polygon points="${area}" fill="url(#wg)"/>
    ${axes && list.length >= 3 ? `<polyline points="${movingAvg(list).map((p) => `${X(p.date).toFixed(1)},${Y(p.kg).toFixed(1)}`).join(' ')}" fill="none" stroke="#0f5132" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round" vector-effect="non-scaling-stroke" opacity=".7"/>` : ''}
    <polyline points="${pts}" fill="none" stroke="#16a34a" stroke-width="${axes ? 2.5 : 2}" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    ${axes ? `<circle cx="${X(last.date)}" cy="${Y(last.kg)}" r="4" fill="#16a34a"/>` : ''}
  </svg>`;
}

function renderWeightCard() {
  const list = weightList();
  const card = $('#weightCard');
  if (!list.length) {
    card.innerHTML = `<div class="w-main"><div class="w-label">Teža</div><div class="w-num" style="font-size:17px">Vnesi prvo meritev</div></div>
      <div style="flex:1"></div><div class="w-add">+</div>`;
    return;
  }
  const last = list[list.length - 1];
  // povprečje zadnjih 7 dni proti povprečju 7 dni pred tem (bolj zanesljivo kot posamezne meritve)
  const now = todayKey();
  const a7 = avgWeight(list, now, 7);
  const p7 = avgWeight(list, shiftDay(now, -7), 7);
  let diff = `<div class="w-diff">${shortDate(last.date)}</div>`;
  if (a7 != null && p7 != null) {
    const d = a7 - p7;
    diff = `<div class="w-diff ${trendCls(d)}">Ø 7 dni ${fmtKg(a7)} · ${signed(d)} kg/teden</div>`;
  } else if (a7 != null) {
    diff = `<div class="w-diff">Ø 7 dni ${fmtKg(a7)} kg</div>`;
  }
  card.innerHTML = `<div class="w-main"><div class="w-label">Teža</div>
      <div class="w-num">${fmtKg(last.kg)} <small>kg</small></div>${diff}</div>
    ${weightChart(list.slice(-30), { w: 160, h: 56, axes: false }) || '<div style="flex:1"></div>'}
    <div class="w-add">+</div>`;
}

function openWeight() {
  const list = weightList();
  const last = list[list.length - 1];
  const dateK = state.date;
  const goal = Number(settings.goalWeight) || 0;
  let range = 30;

  openSheet(`
    <h2>Teža</h2>
    <div class="row" style="align-items:flex-end">
      <label class="field" style="margin:0"><span>${dateLabel(dateK)} (kg)</span>
        <input class="input" id="wIn" type="text" inputmode="decimal" autocomplete="off"
          value="${(weights[dateK] ?? (last ? last.kg : '')).toString().replace('.', ',')}"></label>
      <button class="btn" id="wSave" style="margin:0;flex:.6">Shrani</button>
    </div>
    ${goal && last ? `<div class="note">Cilj: <b>${fmtKg(goal)} kg</b> · še ${fmtKg(Math.abs(last.kg - goal))} kg ${last.kg > goal ? 'dol' : 'gor'}</div>` : ''}
    <div class="ratio-calc" id="wStats" style="margin-top:14px"></div>
    <div id="wChartBox"></div>
    <h3>Meritve</h3>
    <div id="wList"></div>
    <p class="muted">Črtkana temna črta na grafu je drseče 7-dnevno povprečje – kaže pravi trend brez dnevnih nihanj (voda, sol, prebava). Ciljno težo nastaviš v Nastavitvah. Za primerljive rezultate se tehtaj vsak dan ob isti uri (npr. zjutraj).</p>
  `);

  const drawStats = () => {
    const all = weightList(), now = todayKey();
    const a7 = avgWeight(all, now, 7), p7 = avgWeight(all, shiftDay(now, -7), 7), a30 = avgWeight(all, now, 30);
    const k7 = avgKcal(now, 7);
    const d = a7 != null && p7 != null ? a7 - p7 : null;
    const kcalTxt = k7 ? `${r0(k7.kcal)}` : '–';
    const kcalSub = k7 ? `Ø kcal/dan (${k7.days} ${k7.days === 1 ? 'dan' : k7.days === 2 ? 'dneva' : k7.days < 5 ? 'dnevi' : 'dni'})` : 'Ø kcal/dan';
    $('#wStats').innerHTML = `
      <div><b>${a7 != null ? fmtKg(a7) : '–'}</b>Ø zadnjih 7 dni</div>
      <div><b>${p7 != null ? fmtKg(p7) : '–'}</b>Ø prejšnjih 7 dni</div>
      <div><b class="w-diff ${d != null ? trendCls(d) : ''}" style="font-size:16px">${d != null ? signed(d) : '–'}</b>kg / teden</div>
      <div><b>${a30 != null ? fmtKg(a30) : '–'}</b>Ø 30 dni</div>
      <div><b>${kcalTxt}</b>${kcalSub}</div>
      <div><b>${r0(settings.goal.kcal)}</b>cilj kcal/dan</div>`;
  };

  const drawChart = () => {
    drawStats();
    const all = weightList();
    const from = range ? shiftDay(todayKey(), -range) : '';
    const sel = all.filter((p) => p.date >= from);
    $('#wChartBox').innerHTML = all.length < 2
      ? '<div class="note">Graf se prikaže po dveh meritvah.</div>'
      : `<div class="seg" id="wRange">${[[30, '30 dni'], [90, '90 dni'], [365, 'Leto'], [0, 'Vse']]
          .map(([v, l]) => `<button data-r="${v}" class="${v === range ? 'on' : ''}">${l}</button>`).join('')}</div>
        ${sel.length >= 2 ? weightChart(sel, { goal }) : '<div class="note">V tem obdobju sta manj kot dve meritvi.</div>'}`;
    const r = $('#wRange');
    if (r) r.onclick = (e) => { const b = e.target.closest('button'); if (b) { range = Number(b.dataset.r); drawChart(); } };
    $('#wList').innerHTML = all.length
      ? [...all].reverse().slice(0, 60).map((p, i, arr) => {
          const prev = arr[i + 1];
          const d = prev ? p.kg - prev.kg : 0;
          return `<div class="list-item">
            <div class="entry-main"><div class="entry-name">${fmtKg(p.kg)} kg</div><div class="entry-sub">${dateLabel(p.date)}</div></div>
            ${prev ? `<span class="w-diff ${d < 0 ? 'down' : d > 0 ? 'up' : ''}">${d > 0 ? '+' : ''}${fmtKg(d)}</span>` : ''}
            <button class="icon-btn" style="width:34px;height:34px;font-size:15px;box-shadow:none;background:#f6f7fb" data-del="${p.date}" aria-label="Izbriši">✕</button>
          </div>`;
        }).join('')
      : '<p class="muted">Še ni meritev.</p>';
  };
  drawChart();

  $('#wList').onclick = (e) => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    if (!confirm(`Izbrišem meritev ${dateLabel(b.dataset.del)}?`)) return;
    delete weights[b.dataset.del]; store.set('weights', weights); drawChart(); render();
  };
  $('#wSave').onclick = () => {
    const kg = Number(String($('#wIn').value).replace(',', '.'));
    if (!(kg >= 20 && kg <= 400)) return toast('Vpiši veljavno težo v kg');
    weights[dateK] = Math.round(kg * 10) / 10;
    store.set('weights', weights);
    render(); drawChart(); toast('Teža shranjena');
  };
  setTimeout(() => $('#wIn') && $('#wIn').select(), 300);
}

// ---------- Spodnji list (sheet) ----------
let onSheetClose = null;
function openSheet(html, onClose) {
  closeSheet(true);
  $('#sheetBody').innerHTML = html;
  $('#sheet').hidden = false;
  $('#backdrop').hidden = false;
  $('#sheet').scrollTop = 0;
  onSheetClose = onClose || null;
}
function closeSheet(silent) {
  if (onSheetClose) { const f = onSheetClose; onSheetClose = null; f(); }
  if (silent !== true) { $('#sheet').hidden = true; $('#backdrop').hidden = true; }
}

// ---------- Open Food Facts ----------
function offToFood(p) {
  const n = p.nutriments || {};
  let kcal = n['energy-kcal_100g'];
  if (kcal == null && n.energy_100g != null) kcal = n.energy_100g / 4.184; // kJ -> kcal
  return {
    name: p.product_name_sl || p.product_name || p.generic_name || 'Neznan izdelek',
    brand: (p.brands || '').split(',')[0].trim(),
    barcode: p.code || '',
    quantity: p.quantity || '',
    serving: Number(p.serving_quantity) || 0,
    img: p.image_front_small_url || '',
    per100: {
      kcal: Number(kcal) || 0,
      p: Number(n.proteins_100g) || 0,
      c: Number(n.carbohydrates_100g) || 0,
      f: Number(n.fat_100g) || 0,
    },
    hasNutrition: kcal != null,
    source: 'off',
  };
}

async function fetchProduct(code) {
  // 1) lastni izdelki imajo prednost (popravljeni podatki)
  if (myFoods['bc:' + code]) return myFoods['bc:' + code];
  // 2) Open Food Facts
  const res = await fetch(`${OFF}/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`);
  if (!res.ok && res.status !== 404) throw new Error('Baza ni dosegljiva (' + res.status + ')');
  const data = await res.json();
  if (data.status !== 1 || !data.product) return null;
  return offToFood(data.product);
}

async function searchOFF(q) {
  const base = `${OFF}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=25&fields=${OFF_FIELDS}`;
  // najprej izdelki iz Slovenije, nato (če jih je malo) še globalno
  const si = await fetch(base + '&tagtype_0=countries&tag_contains_0=contains&tag_0=slovenia').then((r) => r.json()).catch(() => ({ products: [] }));
  let products = si.products || [];
  if (products.length < 8) {
    const all = await fetch(base).then((r) => r.json()).catch(() => ({ products: [] }));
    const seen = new Set(products.map((p) => p.code));
    products = products.concat((all.products || []).filter((p) => !seen.has(p.code)));
  }
  return products.map(offToFood).filter((f) => f.hasNutrition);
}

// ---------- Vnos / urejanje živila ----------
/**
 * Prikaže izdelek, vnos teže in izbiro obroka.
 * opts.entry  -> urejanje obstoječega vnosa
 * opts.meal   -> vnaprej izbran obrok (sicer glede na uro)
 */
function showFoodSheet(food, opts = {}) {
  const editing = !!opts.entry;
  let grams = editing ? opts.entry.grams : (food.serving || 100);
  let meal = editing ? opts.entry.meal : (opts.meal || mealByTime());

  const quick = [50, 100, 150, 200, 250];
  if (food.serving && !quick.includes(food.serving)) quick.unshift(food.serving);

  openSheet(`
    <div class="product">
      ${food.img ? `<img src="${esc(food.img)}" alt="">` : `<div class="ph">${food.source === 'ai' ? '✨' : '🍽'}</div>`}
      <div>
        <div class="product-name">${esc(food.name)}</div>
        <div class="product-sub">${esc([food.brand, food.quantity, food.barcode].filter(Boolean).join(' · '))}</div>
        <div class="product-sub">${r0(food.per100.kcal)} kcal / 100 g</div>
      </div>
    </div>
    ${food.hasNutrition === false ? '<div class="note">⚠️ Ta izdelek v bazi nima hranilnih vrednosti. Popravi jih spodaj z “Uredi podatke”.</div>' : ''}

    <label class="field"><span>Količina (g)</span>
      <input class="input" id="gramsIn" type="number" inputmode="decimal" min="0" step="1" value="${r0(grams)}">
    </label>
    <div class="seg" id="quickG">${quick.map((q) => `<button data-g="${q}">${q}${q === food.serving ? ' (porcija)' : ''}</button>`).join('')}</div>

    <div class="nutri" id="nutriBox"></div>

    <div class="field"><span>Obrok ${editing ? '' : '(samodejno po uri vnosa)'}</span>
      <div class="seg" id="mealSeg">${MEALS.map((m) => `<button data-meal="${m.id}">${m.name}</button>`).join('')}</div>
    </div>

    <button class="btn" id="saveEntry">${editing ? 'Shrani' : 'Dodaj v ' + MEALS.find((m) => m.id === meal).name.toLowerCase()}</button>
    <button class="btn secondary" id="editFood">Uredi podatke izdelka</button>
    ${editing ? '<button class="btn danger" id="delEntry">Izbriši vnos</button>' : ''}
  `);

  const gIn = $('#gramsIn');
  const refresh = () => {
    grams = Number(gIn.value) || 0;
    const n = calc(food.per100, grams);
    $('#nutriBox').innerHTML = `
      <div class="k"><b>${r0(n.kcal)}</b><span>kcal</span></div>
      <div><b>${r1(n.p)}</b><span>belj. g</span></div>
      <div><b>${r1(n.c)}</b><span>OH g</span></div>
      <div><b>${r1(n.f)}</b><span>maš. g</span></div>`;
    document.querySelectorAll('#mealSeg button').forEach((b) => b.classList.toggle('on', b.dataset.meal === meal));
    if (!editing) $('#saveEntry').textContent = 'Dodaj v ' + MEALS.find((m) => m.id === meal).name.toLowerCase();
  };
  gIn.addEventListener('input', refresh);
  $('#quickG').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { gIn.value = b.dataset.g; refresh(); } });
  $('#mealSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { meal = b.dataset.meal; refresh(); } });
  refresh();
  if (!editing) setTimeout(() => gIn.select(), 300);

  $('#saveEntry').onclick = () => {
    if (!(grams > 0)) return toast('Vpiši količino v gramih');
    const list = (log[state.date] = log[state.date] || []);
    if (editing) {
      Object.assign(opts.entry, { grams, meal });
    } else {
      list.push({
        id: uid(), meal, grams, name: food.name, brand: food.brand || '', barcode: food.barcode || '',
        per100: food.per100, img: food.img || '', source: food.source || 'off', time: Date.now(),
      });
      rememberRecent(food);
    }
    saveLog(); render(); closeSheet();
    toast(editing ? 'Shranjeno' : `Dodano: ${MEALS.find((m) => m.id === meal).name}`);
  };
  $('#editFood').onclick = () => showCustomFoodSheet(food, opts);
  if (editing) $('#delEntry').onclick = () => {
    log[state.date] = (log[state.date] || []).filter((e) => e !== opts.entry);
    saveLog(); render(); closeSheet(); toast('Izbrisano');
  };
}

/** Ročni vnos / popravek izdelka (shrani se med “Moje izdelke”). */
function showCustomFoodSheet(food = {}, opts = {}) {
  const p = food.per100 || { kcal: '', p: '', c: '', f: '' };
  openSheet(`
    <h2>${food.name ? 'Uredi izdelek' : 'Nov izdelek'}</h2>
    ${food.barcode ? `<div class="note">Črtna koda: <b>${esc(food.barcode)}</b><br>Podatki se shranijo samo na tvojem telefonu.</div>` : ''}
    <button class="btn secondary" id="readLabel">📷 Preberi z etikete (AI)</button>
    <h3>Podatki na 100 g</h3>
    <label class="field"><span>Ime</span><input class="input" id="cfName" value="${esc(food.name || '')}"></label>
    <label class="field"><span>Znamka</span><input class="input" id="cfBrand" value="${esc(food.brand || '')}"></label>
    <div class="row">
      <label class="field"><span>kcal</span><input class="input" id="cfK" type="number" inputmode="decimal" value="${p.kcal === '' ? '' : r1(p.kcal)}"></label>
      <label class="field"><span>Porcija (g)</span><input class="input" id="cfS" type="number" inputmode="decimal" value="${food.serving || ''}"></label>
    </div>
    <div class="row">
      <label class="field"><span>Beljakovine</span><input class="input" id="cfP" type="number" inputmode="decimal" value="${p.p === '' ? '' : r1(p.p)}"></label>
      <label class="field"><span>Oglj. hidrati</span><input class="input" id="cfC" type="number" inputmode="decimal" value="${p.c === '' ? '' : r1(p.c)}"></label>
      <label class="field"><span>Maščobe</span><input class="input" id="cfF" type="number" inputmode="decimal" value="${p.f === '' ? '' : r1(p.f)}"></label>
    </div>
    <button class="btn" id="cfSave">Shrani in nadaljuj</button>
  `);

  $('#readLabel').onclick = () => {
    pendingLabel = (data) => {
      if (data.ime) $('#cfName').value = data.ime;
      if (data.znamka) $('#cfBrand').value = data.znamka;
      $('#cfK').value = r1(data.kcal_100g); $('#cfP').value = r1(data.beljakovine_100g);
      $('#cfC').value = r1(data.oh_100g); $('#cfF').value = r1(data.mascobe_100g);
      if (data.porcija_g > 0) $('#cfS').value = r0(data.porcija_g);
      toast('Preberi in preveri številke 👀', 3000);
    };
    $('#labelInput').click();
  };

  $('#cfSave').onclick = () => {
    const name = $('#cfName').value.trim();
    if (!name) return toast('Vpiši ime');
    const nf = {
      ...food, name, brand: $('#cfBrand').value.trim(),
      serving: Number($('#cfS').value) || 0,
      per100: { kcal: Number($('#cfK').value) || 0, p: Number($('#cfP').value) || 0, c: Number($('#cfC').value) || 0, f: Number($('#cfF').value) || 0 },
      hasNutrition: true, source: food.source === 'ai' ? 'ai' : 'custom',
    };
    const key = nf.barcode ? 'bc:' + nf.barcode : 'nm:' + name.toLowerCase();
    myFoods[key] = nf; store.set('foods', myFoods);
    if (opts.entry) { // popravi tudi obstoječi vnos
      Object.assign(opts.entry, { name: nf.name, brand: nf.brand, per100: nf.per100 });
      saveLog(); render();
    }
    showFoodSheet(nf, opts);
  };
}

// ---------- Skener črtne kode ----------
function openScanner(meal) {
  let controls = null;
  openSheet(`
    <h2>Skeniraj črtno kodo</h2>
    <div class="scanner">
      <video id="scanVideo" playsinline muted autoplay></video>
      <div class="scan-frame"></div><div class="scan-line"></div>
    </div>
    <p class="hint">Usmeri kamero v črtno kodo na embalaži.</p>
    <div class="row">
      <input class="input" id="manualCode" inputmode="numeric" placeholder="ali vpiši kodo ročno">
      <button class="btn" id="manualGo" style="margin:0;flex:.4">OK</button>
    </div>
  `, () => { try { controls && controls.stop(); } catch { /* ignore */ } });

  const handle = async (code) => {
    try { controls && controls.stop(); } catch { /* ignore */ }
    $('#sheetBody').innerHTML = `<div class="spinner"></div><p class="center muted">Iščem ${esc(code)}…</p>`;
    try {
      const food = await fetchProduct(code);
      if (food) return showFoodSheet(food, { meal });
      toast('Izdelka ni v bazi – dodaj ga', 2600);
      showCustomFoodSheet({ barcode: code }, { meal });
    } catch (err) {
      $('#sheetBody').innerHTML = `<h2>Napaka</h2><div class="note">${esc(err.message)}<br>Preveri internetno povezavo.</div>
        <button class="btn" id="retry">Poskusi znova</button>`;
      $('#retry').onclick = () => openScanner(meal);
    }
  };

  $('#manualGo').onclick = () => { const c = $('#manualCode').value.replace(/\D/g, ''); if (c) handle(c); };

  if (!window.ZXingBrowser) { toast('Skener se ni naložil – vpiši kodo ročno'); return; }
  const reader = new window.ZXingBrowser.BrowserMultiFormatReader();
  reader.decodeFromConstraints(
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
    $('#scanVideo'),
    (result, _err, ctrl) => {
      if (result && !handle.done) { handle.done = true; ctrl.stop(); handle(result.getText()); }
    }
  ).then((c) => {
    controls = c;
    if ($('#sheet').hidden || !$('#scanVideo')) c.stop(); // sheet medtem zaprt
  }).catch((err) => {
    toast(err && err.name === 'NotAllowedError' ? 'Dovoli dostop do kamere v nastavitvah' : 'Kamera ni na voljo', 3200);
  });
}

// ---------- Iskanje ----------
function openSearch(meal) {
  const mine = Object.values(myFoods);
  const item = (f, i, src) => `
    <button class="list-item" data-src="${src}" data-i="${i}">
      ${f.img ? `<img class="entry-img" src="${esc(f.img)}" alt="">` : `<div class="entry-img">${f.source === 'ai' ? '✨' : '🍽'}</div>`}
      <div class="entry-main">
        <div class="entry-name">${esc(f.name)}</div>
        <div class="entry-sub">${esc([f.brand, f.quantity].filter(Boolean).join(' · '))}</div>
      </div>
      <div class="entry-kcal">${r0(f.per100.kcal)}<span class="muted"> /100g</span></div>
    </button>`;

  openSheet(`
    <h2>Dodaj živilo</h2>
    <form id="searchForm" class="row">
      <input class="input" id="q" type="search" placeholder="npr. jogurt, kruh, Mercator…" enterkeyhint="search">
      <button class="btn" style="margin:0;flex:.4">Išči</button>
    </form>
    <div id="results">
      ${recent.length ? '<h3>Nedavno</h3>' + recent.map((f, i) => item(f, i, 'recent')).join('') : ''}
      ${mine.length ? '<h3>Moji izdelki</h3>' + mine.map((f, i) => item(f, i, 'mine')).join('') : ''}
      ${!recent.length && !mine.length ? '<p class="note">Poišči izdelek po imenu ali znamki. Najprej se prikažejo izdelki iz Slovenije (Open Food Facts).</p>' : ''}
    </div>
    <button class="btn secondary" id="newCustom">+ Ročni vnos novega izdelka</button>
  `);

  let results = [];
  $('#results').addEventListener('click', (e) => {
    const b = e.target.closest('.list-item'); if (!b) return;
    const src = { recent, mine, res: results }[b.dataset.src];
    showFoodSheet(src[Number(b.dataset.i)], { meal });
  });
  $('#newCustom').onclick = () => showCustomFoodSheet({}, { meal });
  $('#searchForm').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('#q').value.trim(); if (!q) return;
    $('#q').blur();
    const box = $('#results');
    box.innerHTML = '<div class="spinner"></div>';
    // lastni izdelki + Open Food Facts
    const ql = q.toLowerCase();
    const local = mine.filter((f) => (f.name + ' ' + (f.brand || '')).toLowerCase().includes(ql));
    try { results = local.concat(await searchOFF(q)); }
    catch { results = local; toast('Spletna baza ni dosegljiva'); }
    box.innerHTML = results.length
      ? results.map((f, i) => item(f, i, 'res')).join('')
      : '<p class="note">Ni zadetkov. Poskusi drugačen izraz ali dodaj izdelek ročno.</p>';
  };
  setTimeout(() => $('#q') && $('#q').focus(), 300);
}

// ---------- Claude (AI) ----------
let anthropicMod = null;
async function claude(content, schema, effort) {
  if (!settings.apiKey) {
    toast('Najprej v Nastavitvah vpiši Claude API ključ', 3200);
    openSettings();
    throw new Error('Ni API ključa');
  }
  if (!anthropicMod) anthropicMod = await import(SDK_URL);
  const Anthropic = anthropicMod.default;
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // če model zavrne, odgovori nadomestni model
      output_config: { effort, format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content }],
    });
    if (response.stop_reason === 'refusal') throw new Error('AI je zavrnil zahtevo.');
    const text = response.content.find((b) => b.type === 'text');
    if (!text) throw new Error('Prazen odgovor AI.');
    return JSON.parse(text.text);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('Napačen API ključ.');
    if (err instanceof Anthropic.RateLimitError) throw new Error('Preveč zahtev – poskusi čez minuto.');
    if (err instanceof Anthropic.APIConnectionError) throw new Error('Ni povezave z AI strežnikom.');
    if (err instanceof Anthropic.APIStatusError) throw new Error('AI napaka: ' + err.message);
    throw err;
  }
}

/** Pomanjša sliko (hitrejši prenos, manjša poraba) in vrne base64 JPEG. */
async function fileToJpeg(file, max = 1280) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    const dataUrl = cv.toDataURL('image/jpeg', 0.82);
    return { dataUrl, b64: dataUrl.split(',')[1] };
  } finally { URL.revokeObjectURL(url); }
}

const FOOD_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ime: { type: 'string' },
          grami: { type: 'number' },
          kcal: { type: 'number' },
          beljakovine: { type: 'number' },
          oh: { type: 'number' },
          mascobe: { type: 'number' },
          zaupanje: { type: 'string', enum: ['visoka', 'srednja', 'nizka'] },
        },
        required: ['ime', 'grami', 'kcal', 'beljakovine', 'oh', 'mascobe', 'zaupanje'],
        additionalProperties: false,
      },
    },
    opomba: { type: 'string' },
  },
  required: ['items', 'opomba'],
  additionalProperties: false,
};

const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    ime: { type: 'string' },
    znamka: { type: 'string' },
    kcal_100g: { type: 'number' },
    beljakovine_100g: { type: 'number' },
    oh_100g: { type: 'number' },
    mascobe_100g: { type: 'number' },
    porcija_g: { type: 'number' },
  },
  required: ['ime', 'znamka', 'kcal_100g', 'beljakovine_100g', 'oh_100g', 'mascobe_100g', 'porcija_g'],
  additionalProperties: false,
};

async function analyzePhoto(file, meal) {
  openSheet('<h2>Prepoznavam hrano…</h2><div class="spinner"></div>');
  let img;
  try { img = await fileToJpeg(file); }
  catch { return openSheet('<h2>Napaka</h2><div class="note">Slike ni bilo mogoče prebrati.</div>'); }
  openSheet(`<h2>Prepoznavam hrano…</h2><img class="photo-preview" src="${img.dataUrl}" alt=""><div class="spinner"></div>
    <p class="center muted">AI ocenjuje živila in količine (nekaj sekund).</p>`);

  let data;
  try {
    data = await claude([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.b64 } },
      { type: 'text', text:
        'Na sliki je obrok. Prepoznaj vsako ločeno živilo/jed in oceni količino v gramih glede na velikost ' +
        'krožnika, pribora in embalaže. Za vsako postavko podaj SKUPNE vrednosti za ocenjeno količino ' +
        '(kcal, beljakovine, ogljikovi hidrati, maščobe v gramih) in zaupanje v oceno. Imena napiši v ' +
        'slovenščini, kratko (npr. "pečen piščančji file", "riž kuhan", "solata z oljem"). Upoštevaj vidno ' +
        'olje/omake. Če na sliki ni hrane, vrni prazen seznam. V "opomba" na kratko (1 stavek) napiši, kaj je ' +
        'najbolj negotovo.' },
    ], FOOD_SCHEMA, 'medium');
  } catch (err) {
    return openSheet(`<h2>Napaka</h2><div class="note">${esc(err.message)}</div>`);
  }

  const items = (data.items || []).filter((i) => i.grami > 0);
  if (!items.length) return openSheet(`<h2>Ni prepoznane hrane</h2><img class="photo-preview" src="${img.dataUrl}" alt="">
    <div class="note">${esc(data.opomba || 'Poskusi s sliko od zgoraj, pri dobri svetlobi.')}</div>`);

  // pretvori v per100, da lahko uporabnik spreminja grame
  const foods = items.map((i) => ({
    name: i.ime, brand: '', source: 'ai', img: '', conf: i.zaupanje, grams: r0(i.grami), on: true,
    per100: { kcal: i.kcal / i.grami * 100, p: i.beljakovine / i.grami * 100, c: i.oh / i.grami * 100, f: i.mascobe / i.grami * 100 },
    hasNutrition: true,
  }));
  let selMeal = meal || mealByTime();
  const confCls = { visoka: '', srednja: 'mid', nizka: 'low' };

  openSheet(`
    <h2>Prepoznano</h2>
    <img class="photo-preview" src="${img.dataUrl}" alt="">
    <div id="aiList">${foods.map((f, i) => `
      <div class="ai-item" data-i="${i}">
        <div class="top-line">
          <input type="checkbox" checked data-on="${i}">
          <span class="nm">${esc(f.name)}</span>
          <span class="badge ${confCls[f.conf] || ''}">${esc(f.conf)}</span>
        </div>
        <div class="row">
          <label class="field" style="margin:0"><span>Grami</span>
            <input class="input" type="number" inputmode="decimal" value="${f.grams}" data-g="${i}"></label>
          <div class="field" style="margin:0"><span>kcal</span><div class="input" id="aiK${i}" style="background:#fff">${r0(calc(f.per100, f.grams).kcal)}</div></div>
        </div>
      </div>`).join('')}</div>
    ${data.opomba ? `<div class="note">ℹ️ ${esc(data.opomba)}<br>Številke so ocena – po potrebi popravi grame.</div>` : ''}
    <div class="field"><span>Obrok</span>
      <div class="seg" id="mealSeg">${MEALS.map((m) => `<button data-meal="${m.id}">${m.name}</button>`).join('')}</div>
    </div>
    <button class="btn" id="aiAdd">Dodaj izbrano</button>
  `);

  const total = () => foods.filter((f) => f.on).reduce((s, f) => s + calc(f.per100, f.grams).kcal, 0);
  const refresh = () => {
    document.querySelectorAll('#mealSeg button').forEach((b) => b.classList.toggle('on', b.dataset.meal === selMeal));
    $('#aiAdd').textContent = `Dodaj izbrano (${r0(total())} kcal)`;
  };
  $('#aiList').addEventListener('input', (e) => {
    if (e.target.dataset.g != null) {
      const i = Number(e.target.dataset.g);
      foods[i].grams = Number(e.target.value) || 0;
      $('#aiK' + i).textContent = r0(calc(foods[i].per100, foods[i].grams).kcal);
    }
    if (e.target.dataset.on != null) foods[Number(e.target.dataset.on)].on = e.target.checked;
    refresh();
  });
  $('#mealSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { selMeal = b.dataset.meal; refresh(); } });
  refresh();

  $('#aiAdd').onclick = () => {
    const chosen = foods.filter((f) => f.on && f.grams > 0);
    if (!chosen.length) return toast('Nič ni izbrano');
    const list = (log[state.date] = log[state.date] || []);
    chosen.forEach((f) => list.push({
      id: uid(), meal: selMeal, grams: f.grams, name: f.name, brand: '', barcode: '',
      per100: f.per100, img: '', source: 'ai', time: Date.now(),
    }));
    saveLog(); render(); closeSheet();
    toast(`Dodano ${chosen.length}× v ${MEALS.find((m) => m.id === selMeal).name.toLowerCase()}`);
  };
}

let pendingLabel = null;
async function analyzeLabel(file) {
  const cb = pendingLabel; pendingLabel = null;
  if (!cb) return;
  toast('Berem etiketo…', 6000);
  try {
    const img = await fileToJpeg(file, 1600);
    const data = await claude([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.b64 } },
      { type: 'text', text:
        'To je embalaža živila s tabelo hranilnih vrednosti. Preberi vrednosti NA 100 g (ali 100 ml): ' +
        'energijsko vrednost v kcal, beljakovine, ogljikove hidrate in maščobe v gramih. Prepiši točno, kar ' +
        'piše, ne ugibaj. Če je navedena velikost porcije v gramih, jo podaj, sicer 0. Ime izdelka in ' +
        'znamko prepiši z embalaže, če sta vidna, sicer prazen niz.' },
    ], LABEL_SCHEMA, 'low');
    cb(data);
  } catch (err) {
    toast(err.message, 3500);
  }
}

// ---------- Nastavitve ----------
function openSettings() {
  let ratio = settings.ratio;
  openSheet(`
    <h2>Nastavitve</h2>
    <h3>Dnevni cilj</h3>
    <div class="row">
      <label class="field"><span>Kalorije (kcal)</span><input class="input" id="sK" type="number" inputmode="numeric" value="${settings.goal.kcal}"></label>
      <label class="field"><span>Ciljna teža (kg)</span><input class="input" id="sW" type="text" inputmode="decimal" placeholder="neobvezno" value="${settings.goalWeight ? String(settings.goalWeight).replace('.', ',') : ''}"></label>
    </div>
    <div class="field"><span>Razmerje makrohranil (beljakovine / OH / maščobe)</span>
      <div id="ratioBox">${RATIOS.map((r) => `
        <button class="ratio-opt" data-r="${r.id}"><b>${r.name}</b><span>${r.p} / ${r.c} / ${r.f} %</span></button>`).join('')}</div>
    </div>
    <div class="ratio-calc" id="ratioCalc"></div>
    <p class="muted">Grami se izračunajo samodejno iz kalorij in razmerja. Razmerja so splošne razdelitve – za posebne potrebe se posvetuj s strokovnjakom.</p>

    <h3>Samodejna razporeditev obrokov</h3>
    <div class="row">
      <label class="field"><span>Zajtrk do</span><input class="input" id="sB" type="time" value="${settings.breakfastEnd}"></label>
      <label class="field"><span>Kosilo do</span><input class="input" id="sL" type="time" value="${settings.lunchEnd}"></label>
    </div>
    <p class="muted">Po uri “Kosilo do” gre vnos v večerjo.</p>

    <h3>AI prepoznava (Claude API)</h3>
    <label class="field"><span>API ključ</span>
      <input class="input" id="sKey" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(settings.apiKey)}"></label>
    <div class="note">Ključ ustvariš na console.anthropic.com → API Keys. Shrani se samo v tem telefonu.
      Priporočam, da v konzoli nastaviš mesečno omejitev porabe. Vsaka slika je en klic AI (plačljivo po porabi).</div>

    <button class="btn" id="sSave">Shrani</button>

    <h3>Podatki</h3>
    <div class="row">
      <button class="btn secondary" id="sExport">Izvozi varnostno kopijo</button>
      <button class="btn secondary" id="sImport">Uvozi</button>
    </div>
    <p class="muted center" style="margin-top:16px">Kalko · podatki o izdelkih: Open Food Facts (ODbL)</p>
  `);

  const updRatio = () => {
    const g = goalFromRatio(Number($('#sK').value) || 0, ratio);
    document.querySelectorAll('#ratioBox .ratio-opt').forEach((b) => b.classList.toggle('on', b.dataset.r === ratio));
    $('#ratioCalc').innerHTML = `<div><b>${g.p} g</b>beljakovine</div><div><b>${g.c} g</b>oglj. hidrati</div><div><b>${g.f} g</b>maščobe</div>`;
  };
  $('#sK').addEventListener('input', updRatio);
  $('#ratioBox').onclick = (e) => { const b = e.target.closest('.ratio-opt'); if (b) { ratio = b.dataset.r; updRatio(); } };
  updRatio();

  $('#sSave').onclick = () => {
    const kcal = Number($('#sK').value);
    if (!(kcal >= 800 && kcal <= 8000)) return toast('Vpiši kalorije med 800 in 8000');
    settings.ratio = ratio;
    settings.goal = goalFromRatio(Math.round(kcal), ratio);
    settings.goalWeight = Number(String($('#sW').value).replace(',', '.')) || 0;
    settings.breakfastEnd = $('#sB').value || DEFAULT_SETTINGS.breakfastEnd;
    settings.lunchEnd = $('#sL').value || DEFAULT_SETTINGS.lunchEnd;
    settings.apiKey = $('#sKey').value.trim();
    store.set('settings', settings);
    render(); closeSheet(); toast('Nastavitve shranjene');
  };
  $('#sExport').onclick = async () => {
    const blob = new Blob([JSON.stringify({ log, weights, foods: myFoods, recent, settings: { ...settings, apiKey: '' } }, null, 1)], { type: 'application/json' });
    const file = new File([blob], `kalko-${todayKey()}.json`, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Kalko varnostna kopija' }); } catch { /* preklicano */ }
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
    }
  };
  $('#sImport').onclick = () => $('#importInput').click();
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data.log) throw new Error();
    if (!confirm('Uvoz bo prepisal trenutne podatke. Nadaljujem?')) return;
    log = data.log; myFoods = data.foods || {}; recent = data.recent || []; weights = data.weights || {};
    if (data.settings) { settings = { ...settings, ...data.settings, apiKey: settings.apiKey }; settings.goal = goalFromRatio(Number(settings.goal && settings.goal.kcal) || 2200, settings.ratio); }
    store.set('log', log); store.set('weights', weights); store.set('foods', myFoods); store.set('recent', recent); store.set('settings', settings);
    render(); closeSheet(); toast('Podatki uvoženi');
  } catch { toast('Neveljavna datoteka'); }
}

// ---------- Dogodki ----------
$('#prevDay').onclick = () => { state.date = shiftDay(state.date, -1); render(); };
$('#nextDay').onclick = () => { state.date = shiftDay(state.date, 1); render(); };
$('#dateLabel').onclick = () => { state.date = todayKey(); render(); };
$('#btnScan').onclick = () => openScanner();
$('#btnSearch').onclick = () => openSearch();
$('#btnPhoto').onclick = () => { photoMeal = null; $('#photoInput').click(); };
$('#btnSettings').onclick = openSettings;
$('#weightCard').onclick = openWeight;
$('#btnWeight').onclick = openWeight;
$('#backdrop').onclick = () => closeSheet();

let photoMeal = null;
$('#photoInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) analyzePhoto(f, photoMeal); };
$('#labelInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) analyzeLabel(f); };
$('#importInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); };

$('#meals').addEventListener('click', (e) => {
  const add = e.target.closest('[data-add]');
  if (add) return openSearch(add.dataset.add);
  const row = e.target.closest('.entry');
  if (row) {
    const entry = (log[state.date] || []).find((x) => x.id === row.dataset.id);
    if (entry) showFoodSheet({ ...entry, hasNutrition: true }, { entry });
  }
});

// Ko se aplikacija vrne v ospredje naslednji dan, skoči na “Danes”
let lastToday = todayKey();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && todayKey() !== lastToday) {
    if (state.date === lastToday) state.date = todayKey();
    lastToday = todayKey(); render();
  }
});

render();

// Service worker – aplikacija se odpre tudi brez interneta
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
