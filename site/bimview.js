// =============================================================================
// bimview.js — render a Tabular .bim (semantic model JSON) as a model diagram.
//
// The Pretty tab for a .bim used to be re-indented JSON; a semantic model is
// really tables + relationships, so it now draws what Power BI's model view
// draws: a card per table (columns, measures, partition mode) and an SVG
// overlay of relationship curves with cardinality and filter-direction marks.
//
// Zero dependencies on purpose — cards are plain flex-wrapped HTML, edges are
// one <svg> whose path geometry is computed from getBoundingClientRect after
// layout. That is why renderBim returns { html, mount }: the HTML string can be
// built anywhere, but the edges can only be drawn once the element is visible
// (a hidden element measures 0×0). showDoc calls mount() after unhiding.
//
// Only ever imported when a parseable .bim hits the Pretty tab (docview.js);
// no other file type pays for this module.
// =============================================================================
import { escapeHtml } from './paths.js';

// Rows shown per card before the rest folds behind "+N more" — a 90-column
// fact table must not turn the diagram into a wall.
const ROW_CAP = 12;

const DATA_TYPE = {
  int64: 'int', double: 'num', decimal: 'dec', string: 'text',
  boolean: 'bool', dateTime: 'date', variant: 'any', binary: 'bin',
};

// Power BI injects a hidden date-table pair per date column; they are plumbing,
// not model, and every real modelling tool hides them.
const AUTO_DATE = /^(DateTableTemplate|LocalDateTable)/;

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

// Connected tables adjacent in the flex flow keeps edges short: BFS from the
// highest-degree table (the fact table, in a star), remaining components after.
function orderTables(tables, rels) {
  const byName = new Map(tables.map(t => [t.name, t]));
  const adj = new Map(tables.map(t => [t.name, []]));
  for (const r of rels) {
    adj.get(r.fromTable)?.push(r.toTable);
    adj.get(r.toTable)?.push(r.fromTable);
  }
  const deg = n => adj.get(n)?.length || 0;
  const seen = new Set(), out = [];
  const seeds = [...tables].sort((a, b) => deg(b.name) - deg(a.name));
  for (const seed of seeds) {
    if (seen.has(seed.name)) continue;
    seen.add(seed.name);
    for (const q = [seed.name]; q.length;) {
      const n = q.shift();
      out.push(byName.get(n));
      for (const m of [...adj.get(n)].sort((a, b) => deg(b) - deg(a)))
        if (!seen.has(m)) { seen.add(m); q.push(m); }
    }
  }
  return out;
}

// Vertical placement comes from the relationships themselves: the many side of
// a many-to-one is the table being filtered, so filters flow downhill — a table
// sits one tier below every table it points up to. Pure dimensions end up on
// top, facts sink to the bottom, snowflaked dimensions land in between. No
// naming conventions involved; one-to-one and many-to-many express no
// preference and isolated tables stay in the top tier.
function tierize(tables, rels) {
  const names = new Set(tables.map(t => t.name));
  const upAdj = new Map(tables.map(t => [t.name, []]));
  for (const r of rels) {
    const fromMany = (r.fromCardinality || 'many') === 'many';
    const toMany = (r.toCardinality || 'one') === 'many';
    if (fromMany === toMany) continue;
    const [many, one] = fromMany ? [r.fromTable, r.toTable] : [r.toTable, r.fromTable];
    upAdj.get(many)?.push(one);
  }
  const depth = new Map(), visiting = new Set();
  const height = n => {
    if (depth.has(n)) return depth.get(n);
    if (visiting.has(n)) return 0; // relationship cycle — break it, don't recurse forever
    visiting.add(n);
    const h = Math.max(0, ...upAdj.get(n).filter(m => names.has(m)).map(m => height(m) + 1));
    visiting.delete(n);
    depth.set(n, h);
    return h;
  };
  const tiers = [];
  for (const t of orderTables(tables, rels)) {
    const h = height(t.name);
    (tiers[h] = tiers[h] || []).push(t);
  }
  // Barycenter pass: within a tier, sit under the average position of your
  // neighbours in the tier above — fewer edges crossing on the way down.
  const adj = new Map(tables.map(t => [t.name, []]));
  for (const r of rels) {
    adj.get(r.fromTable)?.push(r.toTable);
    adj.get(r.toTable)?.push(r.fromTable);
  }
  for (let k = 1; k < tiers.length; k++) {
    const above = new Map(tiers[k - 1].map((t, i) => [t.name, i]));
    tiers[k] = tiers[k]
      .map((t, i) => {
        const ns = adj.get(t.name).filter(n => above.has(n)).map(n => above.get(n));
        return { t, i, score: ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : i };
      })
      .sort((a, b) => a.score - b.score || a.i - b.i)
      .map(e => e.t);
  }
  return tiers;
}

function columnRow(c) {
  const dim = c.isHidden ? ' dim' : '';
  const mk = c.type === 'calculated' ? 'fx' : '';
  const dt = DATA_TYPE[c.dataType] || c.dataType || '';
  return `<div class="bimRow${dim}"><span class="mk">${mk}</span>` +
    `<span class="nm" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>` +
    `<span class="dt">${escapeHtml(dt)}</span></div>`;
}

function measureRow(m, first) {
  const dax = Array.isArray(m.expression) ? m.expression.join('\n') : (m.expression || '');
  const dim = m.isHidden ? ' dim' : '';
  return `<div class="bimRow meas${first ? ' msep' : ''}${dim}" title="${escapeHtml(dax)}">` +
    `<span class="mk">∑</span><span class="nm">${escapeHtml(m.name)}</span></div>`;
}

function cardHtml(t) {
  const cols = t.columns || [];
  const meas = t.measures || [];
  const rows = cols.map(columnRow).concat(meas.map((m, i) => measureRow(m, i === 0)));
  const shown = rows.slice(0, ROW_CAP).join('');
  const folded = rows.slice(ROW_CAP);
  const more = folded.length
    ? `<div class="moreRows">${folded.join('')}</div>` +
      `<button class="bimMore" data-more="${folded.length}">+${folded.length} more</button>`
    : '';
  const mode = t.partitions?.[0]?.mode;
  const badge = mode ? `<span class="bimBadge">${escapeHtml(mode)}</span>` : '';
  const hid = t.isHidden ? ' hiddenT' : '';
  const hidTag = t.isHidden ? '<span class="dt">(hidden)</span>' : '';
  return `<div class="bimCard${hid}" data-table="${escapeHtml(t.name)}">` +
    `<div class="bimHead"><span class="nm" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>${hidTag}${badge}</div>` +
    shown + more + `</div>`;
}

function relGroup(r) {
  // Default TOM semantics: many-to-one from→to, filter flows to→from.
  const glyph = c => c === 'many' ? '*' : c === 'none' ? '' : '1';
  const gFrom = glyph(r.fromCardinality || 'many');
  const gTo = glyph(r.toCardinality || 'one');
  const both = r.crossFilteringBehavior === 'bothDirections';
  const arrows = both
    ? '<path class="arrow" data-dir="tofrom"></path><path class="arrow" data-dir="fromto"></path>'
    : '<path class="arrow" data-dir="tofrom"></path>';
  const inactive = r.isActive === false ? ' inactive' : '';
  return `<g class="bimRel${inactive}" data-from="${escapeHtml(r.fromTable)}" data-to="${escapeHtml(r.toTable)}">` +
    `<path class="edge"></path>${arrows}` +
    `<text class="glyph gfrom">${gFrom}</text><text class="glyph gto">${gTo}</text></g>`;
}

export function renderBim(parsed) {
  const model = parsed.model || {};
  const all = model.tables || [];
  const tables = all.filter(t => !AUTO_DATE.test(t.name || ''));
  const names = new Set(tables.map(t => t.name));
  const rels = (model.relationships || [])
    .filter(r => names.has(r.fromTable) && names.has(r.toTable));
  const hiddenDates = all.length - tables.length;

  const nMeasures = tables.reduce((n, t) => n + (t.measures?.length || 0), 0);
  const meta = `${tables.length} table${tables.length === 1 ? '' : 's'} · ` +
    `${rels.length} relationship${rels.length === 1 ? '' : 's'} · ` +
    `${nMeasures} measure${nMeasures === 1 ? '' : 's'}`;
  const note = hiddenDates
    ? `<div class="bimNote">${hiddenDates} auto-generated date table${hiddenDates === 1 ? '' : 's'} hidden</div>`
    : '';

  const html =
    `<div class="bimWrap">` +
    `<div class="bimMeta">${meta}</div>` +
    `<svg class="bimEdges" width="0" height="0">${rels.map(relGroup).join('')}</svg>` +
    `<div class="bimCards">${tierize(tables, rels)
      .map(tier => `<div class="bimTier">${tier.map(cardHtml).join('')}</div>`).join('')}</div>` +
    note + `</div>`;
  return { html, mount };
}

// ---------------------------------------------------------------------------
// Edges — drawn after layout, redrawn on resize.
// ---------------------------------------------------------------------------

const f = n => n.toFixed(1);

function bezPoint(p, t) {
  const u = 1 - t;
  return [
    u * u * u * p[0] + 3 * u * u * t * p[2] + 3 * u * t * t * p[4] + t * t * t * p[6],
    u * u * u * p[1] + 3 * u * u * t * p[3] + 3 * u * t * t * p[5] + t * t * t * p[7],
  ];
}

function bezUnitTangent(p, t) {
  const u = 1 - t;
  const x = 3 * u * u * (p[2] - p[0]) + 6 * u * t * (p[4] - p[2]) + 3 * t * t * (p[6] - p[4]);
  const y = 3 * u * u * (p[3] - p[1]) + 6 * u * t * (p[5] - p[3]) + 3 * t * t * (p[7] - p[5]);
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}

function triangle(p, u, s) {
  const nx = -u[1], ny = u[0];
  return `M${f(p[0] + u[0] * s * 1.4)} ${f(p[1] + u[1] * s * 1.4)}` +
    ` L${f(p[0] - u[0] * s + nx * s * 0.9)} ${f(p[1] - u[1] * s + ny * s * 0.9)}` +
    ` L${f(p[0] - u[0] * s - nx * s * 0.9)} ${f(p[1] - u[1] * s - ny * s * 0.9)} Z`;
}

// Each endpoint leaves through the card side facing the other card. Several
// relationships sharing a side get their own slot near the header instead of
// one pile at the mid-height — an expanded fact card would otherwise hang all
// of its curves from its vertical middle, far below the name they belong to.
// The SVG sits under the cards, so a curve through occupied ground is a curve
// nobody sees: when another card blocks the straight corridor (a star schema's
// hub reaching past its neighbour), the edge routes over the top of the row —
// or around the left, for vertically separated pairs — through open space.
function pickSides(ra, rb, clear) {
  const hy = r => r.top + Math.min(24, (r.bottom - r.top) / 2);
  const cx = r => (r.left + r.right) / 2;
  // Vertical separation first: the tiered layout stacks a fact below its
  // dimensions, and a diagonal pair must fan tier-to-tier — the horizontal
  // branch would see the non-overlapping x-ranges and detour over the top.
  if (ra.bottom < rb.top)
    return clear(cx(ra) - 6, ra.bottom, cx(rb) + 6, rb.top) ? ['bottom', 'top'] : ['left', 'left'];
  if (rb.bottom < ra.top)
    return clear(cx(ra) - 6, ra.top, cx(rb) + 6, rb.bottom) ? ['top', 'bottom'] : ['left', 'left'];
  if (ra.right + 8 < rb.left)
    return clear(ra.right, hy(ra) - 6, rb.left, hy(rb) + 6) ? ['right', 'left'] : ['top', 'top'];
  if (rb.right + 8 < ra.left)
    return clear(rb.right, hy(rb) - 6, ra.left, hy(ra) + 6) ? ['left', 'right'] : ['top', 'top'];
  return ['right', 'left']; // overlapping — degenerate but never invisible
}

function anchorAt(r, side, i, n) {
  const vertical = side === 'left' || side === 'right';
  if (vertical) {
    const first = r.top + Math.min(28, (r.bottom - r.top) / 2);
    const step = Math.min(16, (r.bottom - r.top - 16) / Math.max(1, n));
    return [side === 'left' ? r.left : r.right, Math.min(first + i * step, r.bottom - 10)];
  }
  const x = r.left + (r.right - r.left) * (i + 1) / (n + 1);
  return [x, side === 'top' ? r.top : r.bottom];
}

const OUT = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

function bezierBetween(a, sideA, b, sideB) {
  const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
  // Same-side = a detour arc; long handles would swing it far into foreign
  // rows, so it hugs the cards it is climbing over instead.
  const d = sideA === sideB
    ? Math.min(48, Math.max(28, dist / 8))
    : Math.min(120, Math.max(40, dist / 2));
  const ua = OUT[sideA], ub = OUT[sideB];
  return [a[0], a[1], a[0] + ua[0] * d, a[1] + ua[1] * d,
          b[0] + ub[0] * d, b[1] + ub[1] * d, b[0], b[1]];
}

function placeGlyph(text, p, t) {
  const [x, y] = bezPoint(p, t);
  const u = bezUnitTangent(p, t);
  text.setAttribute('x', f(x - u[1] * 8));
  text.setAttribute('y', f(y + u[0] * 8 + 3));
}

function redraw(wrap) {
  const svg = wrap.querySelector('.bimEdges');
  if (!svg || !wrap.isConnected) return;
  svg.setAttribute('width', wrap.offsetWidth);
  svg.setAttribute('height', wrap.offsetHeight);
  const wr = wrap.getBoundingClientRect();
  const rel = el => {
    const r = el.getBoundingClientRect();
    return { left: r.left - wr.left, right: r.right - wr.left, top: r.top - wr.top, bottom: r.bottom - wr.top };
  };
  const cards = new Map();
  for (const el of wrap.querySelectorAll('.bimCard')) cards.set(el.dataset.table, el);

  // Pass 1: choose sides; count how many curves share each card side so each
  // gets its own slot. Sorting a side's curves by where their far end sits
  // keeps neighbours from crossing right at the card edge.
  const rects = new Map();
  for (const [name, el] of cards) rects.set(name, rel(el));
  const jobs = [], sideUse = new Map();
  const claim = (table, side, job, end, far) => {
    const key = table + '|' + side;
    if (!sideUse.has(key)) sideUse.set(key, []);
    sideUse.get(key).push({ job, end, far });
  };
  for (const g of svg.querySelectorAll('g.bimRel')) {
    const from = cards.get(g.dataset.from), to = cards.get(g.dataset.to);
    if (!from || !to) { g.setAttribute('display', 'none'); continue; }
    g.removeAttribute('display');
    const ra = rects.get(g.dataset.from), rb = rects.get(g.dataset.to);
    const clear = (x1, y1, x2, y2) => {
      if (x2 < x1) [x1, x2] = [x2, x1];
      if (y2 < y1) [y1, y2] = [y2, y1];
      for (const [n, r] of rects) {
        if (n === g.dataset.from || n === g.dataset.to) continue;
        if (r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1) return false;
      }
      return true;
    };
    const [sideA, sideB] = pickSides(ra, rb, clear);
    const job = { g, ra, rb, sideA, sideB, a: null, b: null };
    jobs.push(job);
    const mid = r => [(r.left + r.right) / 2, (r.top + r.bottom) / 2];
    claim(g.dataset.from, sideA, job, 'a', mid(rb));
    claim(g.dataset.to, sideB, job, 'b', mid(ra));
  }
  for (const [key, list] of sideUse) {
    const side = key.slice(key.lastIndexOf('|') + 1);
    const axis = side === 'left' || side === 'right' ? 1 : 0;
    list.sort((x, y) => x.far[axis] - y.far[axis]);
    list.forEach((e, i) => {
      const r = e.end === 'a' ? e.job.ra : e.job.rb;
      e.job[e.end] = anchorAt(r, side, i, list.length);
    });
  }

  for (const { g, sideA, sideB, a, b } of jobs) {
    const p = bezierBetween(a, sideA, b, sideB);
    g.querySelector('.edge').setAttribute('d',
      `M${f(p[0])} ${f(p[1])} C${f(p[2])} ${f(p[3])}, ${f(p[4])} ${f(p[5])}, ${f(p[6])} ${f(p[7])}`);
    const arrows = g.querySelectorAll('.arrow');
    for (let i = 0; i < arrows.length; i++) {
      const t = arrows.length === 1 ? 0.5 : (i === 0 ? 0.42 : 0.58);
      const u = bezUnitTangent(p, t);
      // Filter flows to→from by default — against the a→b path direction.
      const dir = arrows[i].dataset.dir === 'tofrom' ? [-u[0], -u[1]] : u;
      arrows[i].setAttribute('d', triangle(bezPoint(p, t), dir, 5));
    }
    placeGlyph(g.querySelector('.gfrom'), p, 0.08);
    placeGlyph(g.querySelector('.gto'), p, 0.92);
  }
}

// ---------------------------------------------------------------------------
// mount — one diagram can be live at a time (there is a single #docView), so
// the observer is a module-level singleton: each mount disconnects the last.
// Listeners go on the wrapper itself and die with it on the next innerHTML.
// ---------------------------------------------------------------------------

let _ro = null;
let _raf = 0;
let _hover = null;

function applyHover(wrap, card) {
  const name = card?.dataset.table;
  const related = new Set(name ? [name] : []);
  for (const g of wrap.querySelectorAll('g.bimRel')) {
    const hit = !!name && (g.dataset.from === name || g.dataset.to === name);
    g.classList.toggle('hl', hit);
    g.classList.toggle('dimmed', !!name && !hit);
    if (hit) { related.add(g.dataset.from); related.add(g.dataset.to); }
  }
  for (const c of wrap.querySelectorAll('.bimCard'))
    c.classList.toggle('dimmed', !!name && !related.has(c.dataset.table));
}

function mount(docViewEl) {
  const wrap = docViewEl.querySelector('.bimWrap');
  if (!wrap) return;
  if (_ro) _ro.disconnect();
  _hover = null;
  const schedule = () => {
    if (_raf) return;
    _raf = requestAnimationFrame(() => { _raf = 0; redraw(wrap); });
  };
  _ro = new ResizeObserver(schedule);
  // The wrapper alone is not enough: a card expanding in a short column can
  // reroute its edges without changing the wrapper's own box.
  _ro.observe(wrap);
  for (const c of wrap.querySelectorAll('.bimCard')) _ro.observe(c);
  wrap.addEventListener('click', e => {
    const b = e.target.closest('.bimMore');
    if (!b) return;
    const card = b.closest('.bimCard');
    card.classList.toggle('open');
    b.textContent = card.classList.contains('open') ? 'show less' : `+${b.dataset.more} more`;
  });
  wrap.addEventListener('mouseover', e => {
    const card = e.target.closest('.bimCard');
    if (card === _hover) return;
    _hover = card;
    applyHover(wrap, card);
  });
  wrap.addEventListener('mouseleave', () => { _hover = null; applyHover(wrap, null); });
  redraw(wrap);
}
