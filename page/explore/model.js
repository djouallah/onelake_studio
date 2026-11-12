// =============================================================================
// explore/model.js — the Model page: the semantic model (the .bim) as a star, and what the
// model says of the table picked
// =============================================================================
// A dimension is a table a
// relationship points to, a fact any other: the model says it, not the names. Where each
// card and line goes is draw.js's (modelPlaces, modelEdges). Drag a table to move it; hover it
// to see what it reaches; click it for its columns, measures and relationships.
// =============================================================================

import { modelPlaces, modelEdges, modelSize, MODEL_CARD } from './draw.js';
import { el } from './dom.js';

const lines = v => Array.isArray(v) ? v.join('\n') : v ?? '';

// Power BI injects a hidden date-table pair per date column; they are plumbing, not model.
const AUTO_DATE = /^(DateTableTemplate|LocalDateTable)/;

// The .bim's model as the view reads it: every list there (a .bim may leave one out), no
// auto date tables, no row-number columns, and only relationships between tables it keeps.
export function tmslOf(bim) {
  const m = bim?.model ?? bim ?? {};
  const tables = (m.tables ?? []).filter(t => !AUTO_DATE.test(t.name)).map(t => ({
    ...t,
    columns: (t.columns ?? []).filter(c => c.type !== 'rowNumber'),
    measures: t.measures ?? [],
  }));
  const names = new Set(tables.map(t => t.name));
  const relationships = (m.relationships ?? []).filter(r => names.has(r.fromTable) && names.has(r.toTable));
  return { ...m, tables, relationships };
}

// Draws `model` (tmslOf's) into `root`, which it fills with the diagram and the side panel.
// A card can be dragged anywhere: its lines follow, and Auto arrange puts every card back in the
// star. Where a card was dragged to lasts as long as the drawing: nothing is written to the model.
export function renderModel(root, model, { title = 'Semantic model' } = {}) {
  let selected = null;
  const rels = model.relationships;
  const keys = name => [...new Set(rels.flatMap(r => [
    ...(r.fromTable === name ? [r.fromColumn] : []), ...(r.toTable === name ? [r.toColumn] : [])]))];
  const tables = model.tables.map(t => ({ ...t, keys: keys(t.name), lines: 1 + keys(t.name).length }));
  const byName = Object.fromEntries(tables.map(t => [t.name, t]));
  // The star, and where each card is now.
  const star = modelPlaces(tables, rels);
  const places = Object.fromEntries(Object.entries(star).map(([k, b]) => [k, { ...b }]));

  const svg = el('svg:svg', { role: 'img', 'aria-label': 'The tables of the semantic model and their relationships' });
  const box = el('div', { class: 'model-panel' });
  const arrange = el('button', { type: 'button', class: 'btn-explore model-arrange', hidden: true,
    title: 'Put every table back where the automatic layout has it', onclick: () => autoArrange() }, 'Auto arrange');
  root.replaceChildren(el('div', { class: 'model-diagram' }, arrange, svg), box);

  const edges = el('svg:g'), cards = el('svg:g');
  let edgeEls = [];
  // `dragging`: a card is held (no hover highlight meanwhile); `dragged`: it moved, so the click
  // that follows is not a pick.
  let dragging = false, dragged = false;
  const { w, head, line } = MODEL_CARD;
  const cardEls = tables.map(t => {
    const b = places[t.name];
    const g = el('svg:g', { class: `m-card ${b.dim ? 'dim' : 'fact'}`, transform: `translate(${b.x},${b.y})`, tabindex: 0, role: 'button', 'aria-label': t.name });
    g.dataset.name = t.name;
    g.append(el('svg:rect', { class: 'm-box', width: w, height: b.h, rx: 8 }));
    g.append(el('svg:text', { class: 'm-name', x: 12, y: 20 }, t.name));
    g.append(el('svg:line', { class: 'm-sep', x1: 0, x2: w, y1: head, y2: head }));
    const n = (a, word) => `${a?.length ?? 0} ${word}${a?.length === 1 ? '' : 's'}`;
    g.append(el('svg:text', { class: 'm-cap', x: 12, y: head + 13 }, `${b.dim ? 'dimension' : 'fact'} · ${n(t.columns, 'column')} · ${n(t.measures, 'measure')}`));
    t.keys.forEach((k, i) => g.append(el('svg:text', { class: 'm-key', x: 12, y: head + 13 + line * (i + 1) }, `⚷ ${k}`)));
    g.addEventListener('pointerenter', () => { if (!dragging) highlight(t.name); });
    g.addEventListener('pointerleave', () => { if (!dragging) highlight(selected); });
    g.addEventListener('focus', () => highlight(t.name));
    g.addEventListener('blur', () => highlight(selected));
    g.addEventListener('pointerdown', e => dragFrom(e, g, t.name));
    g.addEventListener('click', e => {
      e.stopPropagation();
      // The click that ends a drag is not a pick.
      if (dragged) { dragged = false; return; }
      select(t.name);
    });
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(t.name); } });
    cards.append(g);
    return g;
  });
  svg.replaceChildren(edges, cards);
  svg.addEventListener('click', () => { if (dragged) { dragged = false; return; } select(null); });
  drawEdges();
  fit();

  // The lines, from where the cards are.
  function drawEdges() {
    edgeEls = modelEdges(places, rels).map(e => {
      const g = el('svg:g', { class: 'm-rel' });
      g.dataset.from = e.from; g.dataset.to = e.to;
      g.append(el('svg:path', { class: `m-edge${e.active ? '' : ' m-inactive'}`, d: e.d }));
      for (const m of [e.many, e.one]) g.append(el('svg:text', { class: 'm-mark', x: m.x, y: m.y, 'text-anchor': m.anchor }, m.text));
      if (e.both) g.append(el('svg:text', { class: 'm-mark', x: e.mid.x, y: e.mid.y, 'text-anchor': 'middle', dy: '-4' }, '⇅'));
      return g;
    });
    edges.replaceChildren(...edgeEls);
  }
  // The drawing as large as what is in it.
  function fit() {
    const { width, height } = modelSize(places);
    svg.setAttribute('viewBox', `-12 -4 ${width + 24} ${height + 8}`);
    svg.style.maxWidth = `${width + 24}px`;
  }

  // --- A card dragged: it follows the pointer, its lines with it ---
  const SLOP = 4;   // pixels a press may move and still be a click
  function dragFrom(e, g, name) {
    if (e.button !== 0) return;
    const at = places[name], from = { x: at.x, y: at.y, px: e.clientX, py: e.clientY };
    // Screen pixels to the drawing's own, as it is scaled now.
    const m = svg.getScreenCTM();
    const sx = m?.a || 1, sy = m?.d || 1;
    let moved = false;
    const move = v => {
      const dx = v.clientX - from.px, dy = v.clientY - from.py;
      if (!moved && Math.hypot(dx, dy) < SLOP) return;
      if (!moved) {
        moved = dragging = true;
        g.setPointerCapture(e.pointerId);
        g.classList.add('m-drag');
      }
      at.x = Math.max(0, Math.round(from.x + dx / sx));
      at.y = Math.max(0, Math.round(from.y + dy / sy));
      g.setAttribute('transform', `translate(${at.x},${at.y})`);
      drawEdges();
      highlight(name);
    };
    const done = () => {
      for (const [t, f] of [['pointermove', move], ['pointerup', done], ['pointercancel', done]]) g.removeEventListener(t, f);
      if (!moved) return;
      dragging = false;
      dragged = true;
      g.classList.remove('m-drag');
      fit();
      highlight(selected);
      arrange.hidden = !Object.keys(places).some(k => places[k].x !== star[k].x || places[k].y !== star[k].y);
      // A drag let go off its card has no click after it.
      setTimeout(() => { dragged = false; });
    };
    for (const [t, f] of [['pointermove', move], ['pointerup', done], ['pointercancel', done]]) g.addEventListener(t, f);
  }
  // Every card back in the star.
  function autoArrange() {
    for (const g of cardEls) {
      const b = star[g.dataset.name];
      Object.assign(places[g.dataset.name], { x: b.x, y: b.y });
      g.setAttribute('transform', `translate(${b.x},${b.y})`);
    }
    drawEdges();
    fit();
    highlight(selected);
    arrange.hidden = true;
  }

  function highlight(name) {
    const near = new Set(name ? [name] : []);
    for (const g of edgeEls) {
      const on = g.dataset.from === name || g.dataset.to === name;
      if (on) { near.add(g.dataset.from); near.add(g.dataset.to); }
      g.classList.toggle('m-on', on);
      g.classList.toggle('m-off', Boolean(name) && !on);
    }
    for (const g of cardEls) {
      g.classList.toggle('m-on', near.has(g.dataset.name));
      g.classList.toggle('m-off', Boolean(name) && !near.has(g.dataset.name));
      g.classList.toggle('m-sel', g.dataset.name === selected);
    }
  }
  function select(name) {
    selected = name;
    highlight(name);
    panel(name ? byName[name] : null);
  }

  function panel(t) {
    const out = [];
    if (!t) {
      const measures = tables.flatMap(x => x.measures);
      out.push(el('h3', {}, title));
      out.push(el('p', {}, `${tables.length} tables · ${rels.length} relationships · ${measures.length} measures (${measures.filter(m => m.isHidden).length} hidden).`));
      if (model.description) out.push(el('p', {}, lines(model.description)));
      out.push(el('p', { class: 'm-hint' }, 'Drag a table to move it. Hover it to see what it reaches; click it for its columns, measures and relationships.'));
      box.replaceChildren(...out);
      return;
    }
    const isDim = rels.some(r => r.toTable === t.name);
    const heading = el('h3', {}, t.name);
    heading.append(el('span', { class: 'm-tag' }, isDim ? 'dimension' : 'fact'));
    out.push(heading);
    const src = t.partitions?.[0]?.source;
    if (src?.entityName) out.push(el('p', { class: 'm-src' }, `${t.partitions[0].mode ?? ''} · ${src.schemaName ? `${src.schemaName}.` : ''}${src.entityName}`));
    if (t.description) out.push(el('p', {}, lines(t.description)));

    const mine = rels.filter(r => r.fromTable === t.name || r.toTable === t.name);
    if (mine.length) {
      out.push(el('h4', {}, `Relationships (${mine.length})`));
      const ul = el('ul', { class: 'm-rels' });
      for (const r of mine) {
        // Many to one; the other table is a link to it.
        const end = (table, column) => {
          if (table === t.name) return [`[${column}]`];
          const a = el('a', { href: '#' }, table);
          a.addEventListener('click', e => { e.preventDefault(); select(table); });
          return [a, `[${column}]`];
        };
        const li = el('li');
        li.append(...end(r.fromTable, r.fromColumn), ' * → ', ...end(r.toTable, r.toColumn), ' 1');
        if (r.crossFilteringBehavior === 'bothDirections') li.append(el('span', { class: 'm-tag' }, 'both directions'));
        if (r.isActive === false) li.append(el('span', { class: 'm-tag' }, 'inactive'));
        ul.append(li);
      }
      out.push(ul);
    }

    out.push(el('h4', {}, `Columns (${t.columns.length})`));
    const table = el('table', { class: 'explore-table m-cols' });
    const hr = el('tr');
    for (const h of ['Column', 'Type', 'Format']) hr.append(el('th', {}, h));
    table.append(el('thead'), el('tbody'));
    table.tHead.append(hr);
    for (const c of t.columns) {
      const tr = el('tr');
      const name = el('td', {}, c.name);
      if (t.keys.includes(c.name)) name.prepend('⚷ ');
      if (c.isHidden) name.append(el('span', { class: 'm-tag' }, 'hidden'));
      if (c.description) name.append(el('div', { class: 'm-desc' }, lines(c.description)));
      tr.append(name, el('td', {}, c.dataType ?? ''), el('td', {}, c.formatString ?? ''));
      table.tBodies[0].append(tr);
    }
    out.push(table);

    if (t.measures.length) {
      out.push(el('h4', {}, `Measures (${t.measures.length})`));
      for (const m of t.measures) {
        const d = el('details', { class: 'm-measure' });
        const s = el('summary', {}, m.name);
        if (m.isHidden) s.append(el('span', { class: 'm-tag' }, 'hidden'));
        if (m.formatString) s.append(el('span', { class: 'm-fmt' }, m.formatString));
        d.append(s, el('pre', {}, lines(m.expression)));
        if (m.description) d.append(el('p', {}, lines(m.description)));
        out.push(d);
      }
    }
    box.replaceChildren(...out);
    box.scrollTop = 0;
  }

  panel(null);
}
