// The window: the tree, the tabs and what VS Code would otherwise draw around them. Everything it
// shows comes from the extension (src/desktop/vscode.js): the tree's nodes, the tabs' pages, and the
// menus and commands its package.json declares. This file decides how they look, and nothing else.
import { when } from './when.js';

const VIEW = 'onelakeStudio.explorer';
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
document.getElementById('theme').href = `/theme.css?dark=${dark ? 1 : 0}`;
const $ = id => document.getElementById(id);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const glyph = (icon, extra = '') => {
  if (!icon) return h('span', { class: `glyph ${extra}` });
  const el = h('span', { class: `glyph codicon codicon-${icon.id || icon} ${extra}` });
  if (icon.color) el.style.color = `var(--vscode-${icon.color.replace(/\./g, '-')}, currentColor)`;
  return el;
};

// "$(database) OneLake 0.2.10": the icons as glyphs, the rest as text, never as markup.
function withIcons(text) {
  const out = [];
  let last = 0;
  for (const m of String(text || '').matchAll(/\$\(([a-z0-9-]+)(~spin)?\)/g)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    out.push(h('span', { class: `codicon codicon-${m[1]}${m[2] ? ' spin' : ''}` }));
    last = m.index + m[0].length;
  }
  if (last < String(text || '').length) out.push(document.createTextNode(String(text).slice(last)));
  return out;
}
const plain = text => String(text || '').replace(/\$\([a-z0-9-]+(~spin)?\)\s*/g, '');

// ---------------------------------------------------------------------------
// Talking to the app
// ---------------------------------------------------------------------------
async function call(method, ...args) {
  const r = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.result;
}
// A tab's messages arrive in the order it sent them.
let ordered = Promise.resolve();
const callInOrder = (method, ...args) => { ordered = ordered.then(() => call(method, ...args)).catch(() => {}); };

let boot = null;
const contexts = {};
const commandsById = new Map();
const ctx = extra => ({ ...contexts, ...extra });

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------
const menu = $('menu');
function closeMenu() { menu.hidden = true; menu.replaceChildren(); }

// A contributed menu's entries that apply, in their groups and order: [[{ command, title, icon }]].
function entries(where, context, { inline = null } = {}) {
  const list = ((boot.contributes.menus || {})[where] || [])
    .filter(m => when(m.when, context))
    .filter(m => inline == null || String(m.group || '').startsWith('inline') === inline)
    .map(m => {
      const [group, order] = String(m.group || 'z').split('@');
      const c = commandsById.get(m.command) || { title: m.command };
      return { command: m.command, title: c.title, icon: c.icon, group, order: Number(order) || 0 };
    })
    .sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : a.order - b.order));
  const groups = [];
  for (const e of list) {
    if (!groups.length || groups.at(-1)[0].group !== e.group) groups.push([]);
    groups.at(-1).push(e);
  }
  return groups;
}

function openMenu(x, y, groups, run) {
  closeMenu();
  if (!groups.length) return;
  groups.forEach((g, i) => {
    if (i) menu.append(h('hr'));
    for (const e of g) menu.append(h('div', { class: 'entry', role: 'menuitem', onclick: () => { closeMenu(); run(e.command); } }, e.title));
  });
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
}
addEventListener('pointerdown', e => { if (!menu.contains(e.target)) closeMenu(); });
addEventListener('blur', closeMenu);

const runCommand = id => call('command', id).catch(e => toast({ level: 'error', message: e.message, items: [] }));

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------
const tree = $('tree');
let kids = new Map();          // parent id ('' for the top) -> its nodes, as last drawn
const open = new Set();        // what is expanded
const closed = new Set();      // what someone collapsed, which stays so
let selected = null;

const isOpen = n => n.collapsible && (open.has(n.id) || (n.collapsible === 2 && !closed.has(n.id)));

async function walk(parent, into) {
  const list = await call('tree.children', VIEW, parent || null);
  into.set(parent || '', list);
  await Promise.all(list.filter(isOpen).map(n => walk(n.id, into)));
}

let loading = null, again = false;
async function reload() {
  if (loading) { again = true; return loading; }
  loading = (async () => {
    do {
      again = false;
      const fresh = new Map();
      try { await walk('', fresh); kids = fresh; draw(); }
      catch (e) { console.error(e); }
    } while (again);
  })().finally(() => { loading = null; });
  return loading;
}
let soon = null;
const reloadSoon = () => { clearTimeout(soon); soon = setTimeout(reload, 120); };

function toggle(n) {
  if (isOpen(n)) { open.delete(n.id); closed.add(n.id); draw(); return; }
  closed.delete(n.id);
  open.add(n.id);
  reload();
}

function row(n, depth) {
  const inline = entries('view/item/context', ctx({ view: VIEW, viewItem: n.contextValue }), { inline: true }).flat();
  const el = h('div', {
    class: `row${selected === n.id ? ' selected' : ''}`, role: 'treeitem', title: n.tooltip || null,
    'aria-expanded': n.collapsible ? String(isOpen(n)) : null, draggable: n.dragText ? 'true' : null,
    onclick: () => {
      selected = n.id;
      if (n.clickable) { draw(); call('tree.click', VIEW, n.id).catch(() => {}); }
      else if (n.collapsible) toggle(n);
      else draw();
    },
    oncontextmenu: e => {
      e.preventDefault();
      selected = n.id;
      draw();
      openMenu(e.clientX, e.clientY, entries('view/item/context', ctx({ view: VIEW, viewItem: n.contextValue }), { inline: false }),
        command => call('tree.run', VIEW, n.id, command).catch(() => {}));
    },
    ondragstart: e => { e.dataTransfer.setData('text/plain', n.dragText); e.dataTransfer.effectAllowed = 'copy'; },
  },
  h('span', { class: `twist codicon ${n.collapsible ? (isOpen(n) ? 'codicon-chevron-down' : 'codicon-chevron-right') : ''}`,
              onclick: e => { if (n.collapsible) { e.stopPropagation(); toggle(n); } } }),
  glyph(n.icon),
  h('span', { class: 'label' }, n.label),
  n.description ? h('span', { class: 'description' }, n.description) : null,
  inline.length ? h('span', { class: 'inline' }, inline.map(a => h('button', {
    class: 'icon', title: a.title,
    onclick: e => { e.stopPropagation(); call('tree.run', VIEW, n.id, a.command).catch(() => {}); },
  }, withIcons(a.icon || '$(play)')))) : null);
  el.style.paddingLeft = `${4 + depth * 12}px`;
  el.dataset.id = n.id;
  return el;
}

function draw() {
  const top = tree.scrollTop;
  const out = [];
  const add = (parent, depth) => {
    for (const n of kids.get(parent) || []) {
      out.push(row(n, depth));
      if (isOpen(n)) add(n.id, depth + 1);
    }
  };
  add('', 0);
  tree.replaceChildren(...out);
  tree.scrollTop = top;
}

tree.addEventListener('keydown', e => {
  const rows = [...tree.querySelectorAll('.row')];
  let i = rows.findIndex(r => r.dataset.id === selected);
  const all = [...kids.values()].flat();
  const node = id => all.find(n => n.id === id);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    i = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    selected = rows[i] && rows[i].dataset.id;
    draw();
    const r = tree.querySelector('.row.selected');
    if (r) r.scrollIntoView({ block: 'nearest' });
  } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && node(selected)) {
    const n = node(selected);
    if (n.collapsible && (e.key === 'ArrowRight') !== isOpen(n)) toggle(n);
  } else if (e.key === 'Enter' && rows[i]) rows[i].click();
  else return;
  e.preventDefault();
});

function drawHeader() {
  const actions = $('side-actions');
  actions.replaceChildren();
  const groups = entries('view/title', ctx({ view: VIEW }));
  const nav = groups.filter(g => g[0].group.startsWith('navigation')).flat();
  const rest = groups.filter(g => !g[0].group.startsWith('navigation'));
  for (const a of nav) actions.append(h('button', { class: 'icon', title: a.title, onclick: () => runCommand(a.command) }, withIcons(a.icon || a.title)));
  if (rest.length) {
    actions.append(h('button', { class: 'icon', title: 'More Actions…', onclick: e => {
      const r = e.currentTarget.getBoundingClientRect();
      openMenu(r.left, r.bottom + 2, rest, runCommand);
    } }, h('span', { class: 'codicon codicon-ellipsis' })));
  }
  const welcome = (boot.contributes.viewsWelcome || []).find(w => w.view === VIEW && when(w.when, ctx({ view: VIEW })));
  const box = $('welcome');
  box.hidden = !welcome;
  tree.hidden = !!welcome;
  if (welcome) {
    const links = [...welcome.contents.matchAll(/\[([^\]]+)\]\(command:([^)]+)\)/g)];
    box.replaceChildren(h('p', {}, boot.welcome),
      ...links.map(([, label, command]) => h('p', {}, h('button', { class: 'primary', onclick: () => runCommand(command) }, label))));
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const tabs = new Map();
let current = null;

function addTab(id, title, page, { viewType = null } = {}) {
  const el = h('div', { class: 'tab', role: 'tab', title,
    onclick: () => activate(id),
    onauxclick: e => { if (e.button === 1) closeTab(id); } },
  h('span', { class: 'name' }, title),
  h('button', { class: 'icon close', title: 'Close', onclick: e => { e.stopPropagation(); closeTab(id); } }, h('span', { class: 'codicon codicon-close' })));
  $('tabs').append(el);
  $('pages').append(page);
  tabs.set(id, { id, el, page, viewType, loaded: false, waiting: [] });
  activate(id);
}

function activate(id) {
  current = id;
  for (const t of tabs.values()) {
    t.el.classList.toggle('active', t.id === id);
    t.page.classList.toggle('shown', t.id === id);
  }
  $('empty').hidden = tabs.size > 0;
  const t = tabs.get(id);
  if (t) t.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  call('tab.shown', t && t.viewType ? id : null).catch(() => {});
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (t.viewType) { call('tab.closed', id).catch(() => {}); return; }   // the app says when it's gone
  dropTab(id);
}

function dropTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  t.el.remove();
  t.page.remove();
  tabs.delete(id);
  if (current === id) {
    const last = [...tabs.keys()].pop();
    if (last) activate(last); else { current = null; $('empty').hidden = false; call('tab.shown', null).catch(() => {}); }
  }
}

let localTabs = 0;
function textTab(title, content) {
  addTab(`local-${++localTabs}`, title, h('div', { class: 'page' }, h('pre', { class: 'text-page' }, content)));
}

async function settingsTab() {
  const existing = [...tabs.values()].find(t => t.settings);
  if (existing) { activate(existing.id); return; }
  // One section or a list of them, as VS Code takes either; each under its title.
  const sections = [].concat(boot.contributes.configuration || []);
  const values = await call('settings.get');
  const page = h('div', { class: 'page settings-page' }, h('h2', {}, 'Settings'));
  for (const section of sections) {
    if (sections.length > 1 && section.title) page.append(h('h3', {}, section.title));
    for (const [key, p] of Object.entries(section.properties || {})) {
      const name = key.replace(/^onelakeStudio\./, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
      const set = v => call('settings.set', key, v).catch(e => toast({ level: 'error', message: e.message, items: [] }));
      let input;
      if (p.type === 'boolean') input = h('label', {}, h('input', { type: 'checkbox', checked: values[key] ? true : null, onchange: e => set(e.target.checked) }), ' On');
      else if (p.enum) input = h('select', { onchange: e => set(e.target.value) }, p.enum.map(v => h('option', { value: v, selected: v === values[key] ? true : null }, v)));
      else if (p.type === 'number' || p.type === 'integer') {
        input = h('input', { type: 'number', value: values[key], min: p.minimum, max: p.maximum, onchange: e => {
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n)) set(n);
        } });
      } else input = h('input', { type: 'text', value: values[key] ?? '', spellcheck: 'false', onchange: e => set(e.target.value) });
      page.append(h('div', { class: 'setting' }, h('div', { class: 'name' }, name), h('div', { class: 'about' }, plain(p.markdownDescription || p.description || '')), input));
    }
  }
  const id = `local-${++localTabs}`;
  addTab(id, 'Settings', page);
  tabs.get(id).settings = true;
}

function tabMessage(id, msg) {
  const t = tabs.get(id);
  if (!t) return;
  if (t.loaded) t.page.contentWindow.postMessage(msg, location.origin);
  else t.waiting.push(msg);
}

addEventListener('message', e => {
  if (e.origin !== location.origin || !e.data) return;
  const d = e.data;
  const from = [...tabs.values()].find(t => t.page.contentWindow === e.source);
  if (!from) return;
  if (d.olsTab) callInOrder('tab.message', from.id, d.msg);
  else if (d.olsMenu) {
    const r = from.page.getBoundingClientRect();
    openMenu(r.left + d.x, r.top + d.y, entries('webview/context', ctx({ webviewId: from.viewType, ...d.context })), runCommand);
  } else if (d.olsKey === 'ctrl+alt+o') runCommand('onelakeStudio.goTo');
  else if (d.olsFocus) closeMenu();
});

// ---------------------------------------------------------------------------
// Status bar, messages, progress
// ---------------------------------------------------------------------------
const statusItems = new Map();
function drawStatus() {
  const left = [], right = [];
  for (const i of [...statusItems.values()].sort((a, b) => (b.priority || 0) - (a.priority || 0))) {
    if (!i.shown) continue;
    const el = h('span', { class: `item${i.command ? ' clickable' : ''}`, title: i.tooltip || null,
      onclick: i.command ? () => runCommand(i.command) : null }, withIcons(i.text));
    (i.alignment === 2 ? right : left).push(el);
  }
  for (const p of progress.values()) if (!p.notify) left.push(h('span', { class: 'item' }, h('span', { class: 'codicon codicon-loading spin' }), ` ${p.title}${p.message ? `: ${p.message}` : ''}`));
  if (flash) left.push(h('span', { class: 'item' }, withIcons(flash)));
  $('status-left').replaceChildren(...left);
  $('status-right').replaceChildren(...right);
}
let flash = null, flashTimer = null;
const progress = new Map();

const LEVEL_ICON = { info: 'info', warning: 'warning', error: 'error' };
function toast({ level = 'info', message, items = [], spinner = false }, answer = () => {}) {
  let done = false;
  const finish = v => { if (done) return; done = true; el.remove(); answer(v); };
  const el = h('div', { class: `toast level-${level}` },
    h('div', { class: 'line' },
      spinner ? h('span', { class: 'glyph codicon codicon-loading spin' }) : glyph(LEVEL_ICON[level]),
      h('span', { class: 'text' }, message),
      spinner ? null : h('button', { class: 'icon', title: 'Close', onclick: () => finish(null) }, h('span', { class: 'codicon codicon-close' }))),
    items.length ? h('div', { class: 'actions' }, items.map((it, i) => h('button', { class: i ? 'secondary' : 'primary', onclick: () => finish(it) }, it))) : null);
  $('toasts').append(el);
  if (!items.length && !spinner) setTimeout(() => finish(null), level === 'error' ? 20000 : 8000);
  return { el, finish, text: el.querySelector('.text') };
}

// One dialog at a time: a question asked while another is open waits its turn.
let overlayTurn = Promise.resolve();
function overlay(build) {
  const turn = overlayTurn.then(() => new Promise(resolve => {
    const box = $('overlay');
    let closed = false;
    const close = v => {
      if (closed) return;
      closed = true;
      box.hidden = true;
      box.replaceChildren();
      resolve(v);
    };
    box.replaceChildren(build(close));
    box.hidden = false;
    box.onpointerdown = e => { if (e.target === box) close(null); };
    const focus = box.querySelector('input, button.primary, button');
    if (focus) focus.focus();
  }));
  overlayTurn = turn.catch(() => {});
  return turn;
}

function modal({ level, message, detail, items }) {
  return overlay(close => {
    const d = h('div', { class: `dialog level-${level}`, role: 'dialog', onkeydown: e => { if (e.key === 'Escape') close(null); } },
      h('div', { class: 'line' }, glyph(LEVEL_ICON[level]), h('span', { class: 'message' }, ` ${message}`)),
      detail ? h('div', { class: 'detail' }, detail) : null,
      h('div', { class: 'actions' },
        items.map((it, i) => h('button', { class: i ? 'secondary' : 'primary', onclick: () => close(it) }, it)),
        h('button', { class: 'secondary', onclick: () => close(null) }, 'Cancel')));
    return d;
  });
}

// A list to pick from: Go To, a question with choices, the filter.
function picker({ title, placeholder, items, busy = false, accept, button = null, cancel }) {
  // Items can come before the list is on screen: another dialog may be in its way.
  let list = items, on = 0, shown = [];
  let setItems = null, setBusy = null;
  const done = overlay(close => {
    const input = h('input', { type: 'text', placeholder: placeholder || '', spellcheck: 'false', 'aria-label': title || placeholder || 'Pick' });
    const status = h('div', { class: 'prompt' }, busy ? 'Loading…' : '');
    const box = h('div', { class: 'picks', role: 'listbox' });
    const render = () => {
      const q = input.value.trim().toLowerCase();
      shown = list.filter(it => !q || `${plain(it.label)} ${it.description || ''}`.toLowerCase().includes(q)).slice(0, 300);
      on = Math.min(on, Math.max(0, shown.length - 1));
      box.replaceChildren(...shown.map((it, k) => h('div', {
        class: `pick${k === on ? ' on' : ''}`, role: 'option', title: it.detail || null,
        onclick: () => { close(true); accept(it.i); },
        onpointermove: () => { if (on !== k) { on = k; render(); } },
      }, h('span', { class: 'label' }, withIcons(it.label)), h('span', { class: 'description' }, it.description || ''),
      (it.buttons || []).map(b => h('button', { class: 'icon', title: b.tooltip, onclick: e => { e.stopPropagation(); close(true); button(it.i); } },
        glyph(b.icon))))));
      if (!busy) status.textContent = shown.length ? '' : 'Nothing matches.';
    };
    setItems = v => { list = v; render(); };
    setBusy = v => { busy = v; status.textContent = v ? 'Loading…' : ''; render(); };
    input.addEventListener('input', () => { on = 0; render(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { on = Math.max(0, Math.min(shown.length - 1, on + (e.key === 'ArrowDown' ? 1 : -1))); render(); box.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
      else if (e.key === 'Enter' && shown[on]) { close(true); accept(shown[on].i); }
      else if (e.key === 'Escape') close(null);
    });
    render();
    return h('div', { class: 'picker' }, title ? h('div', { class: 'title' }, title) : null, input, status, box);
  }).then(v => { if (v == null) cancel(); });
  return { done, items: v => { list = v; if (setItems) setItems(v); }, busy: v => { busy = v; if (setBusy) setBusy(v); } };
}

function inputBox({ id, title, value, prompt, placeholder }) {
  return overlay(close => {
    const input = h('input', { type: 'text', value, placeholder, spellcheck: 'false', 'aria-label': title || prompt });
    const note = h('div', { class: 'prompt' }, prompt);
    let bad = null, checking = 0;
    const check = async () => {
      const mine = ++checking;
      const said = await call('validate', id, input.value).catch(() => null);
      if (mine !== checking) return;
      bad = said;
      note.textContent = said || prompt;
      note.classList.toggle('bad', !!said);
    };
    input.addEventListener('input', check);
    input.addEventListener('keydown', async e => {
      if (e.key === 'Enter') { await check(); if (!bad) close(input.value); }
      else if (e.key === 'Escape') close(null);
    });
    check();
    return h('div', { class: 'picker' }, title ? h('div', { class: 'title' }, title) : null, input, note);
  });
}

const pickers = new Map();
async function ask(m) {
  const answer = v => { if (m.id) call('answer', m.id, v).catch(() => {}); };
  if (m.kind === 'message') {
    if (m.modal) answer(await modal(m));
    else toast(m, answer);
  } else if (m.kind === 'input') answer(await inputBox(m));
  else if (m.kind === 'pick') {
    let chosen = null;
    picker({ ...m, accept: i => { chosen = i; }, cancel: () => {} }).done.then(() => answer(chosen));
  }
}

// ---------------------------------------------------------------------------
// What the app says
// ---------------------------------------------------------------------------
const notices = new Map();
function on(m) {
  switch (m.t) {
    case 'context':
      contexts[m.key] = m.value;
      drawHeader();
      draw();
      break;
    case 'tree-created': case 'tree-changed': reloadSoon(); break;
    case 'view-title': $('side-title').textContent = m.title; document.title = m.title && m.title !== 'OneLake Studio' ? `OneLake Studio: ${m.title}` : 'OneLake Studio'; break;
    case 'view-description': $('side-description').textContent = m.description; break;
    case 'tab-open': {
      const frame = h('iframe', { title: m.title, allow: 'clipboard-write' });
      addTab(m.id, m.title, frame, { viewType: m.viewType });
      const t = tabs.get(m.id);
      frame.addEventListener('load', () => {
        t.loaded = true;
        for (const msg of t.waiting.splice(0)) frame.contentWindow.postMessage(msg, location.origin);
      });
      break;
    }
    case 'tab-html': {
      const t = tabs.get(m.id);
      if (!t) break;
      t.loaded = false;
      t.page.src = `/tab/${encodeURIComponent(m.id)}?dark=${dark ? 1 : 0}&rev=${m.rev}`;
      break;
    }
    case 'tab-post': tabMessage(m.id, m.msg); break;
    case 'tab-title': {
      const t = tabs.get(m.id);
      if (t) { t.el.querySelector('.name').textContent = m.title; t.el.title = m.title; }
      break;
    }
    case 'tab-reveal': if (tabs.has(m.id)) activate(m.id); break;
    case 'tab-close': dropTab(m.id); break;
    case 'text-tab': textTab(m.title, m.content); break;
    case 'open-settings': settingsTab(); break;
    case 'status-item': statusItems.set(m.item.id, m.item); drawStatus(); break;
    case 'status-item-gone': statusItems.delete(m.id); drawStatus(); break;
    case 'status-message':
      flash = m.text;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flash = null; drawStatus(); }, m.ms);
      drawStatus();
      break;
    case 'progress':
      progress.set(m.id, m);
      if (m.notify) {
        const n = notices.get(m.id) || toast({ level: 'info', message: '', spinner: true });
        n.text.textContent = m.message ? `${m.title}: ${m.message}` : m.title;
        notices.set(m.id, n);
      }
      drawStatus();
      break;
    case 'progress-end':
      progress.delete(m.id);
      if (notices.has(m.id)) { notices.get(m.id).finish(null); notices.delete(m.id); }
      drawStatus();
      break;
    case 'ask': ask(m); break;
    case 'pick-open': {
      const p = picker({ title: m.title, placeholder: m.placeholder, items: m.items, busy: m.busy,
        accept: i => call('pick.accept', m.id, i).catch(() => {}),
        button: i => call('pick.button', m.id, i).catch(() => {}),
        cancel: () => call('pick.hide', m.id).catch(() => {}) });
      pickers.set(m.id, p);
      break;
    }
    case 'pick-items': pickers.get(m.id)?.items(m.items); break;
    case 'pick-busy': pickers.get(m.id)?.busy(m.busy); break;
    case 'pick-close': pickers.delete(m.id); break;
  }
}

// ---------------------------------------------------------------------------
// Starting, and the window around it
// ---------------------------------------------------------------------------
const events = new EventSource('/events');
let lostTimer = null;
events.onmessage = e => { try { on(JSON.parse(e.data)); } catch (err) { console.error(err); } };
events.onopen = () => { clearTimeout(lostTimer); $('lost').hidden = true; };
events.onerror = () => {
  clearTimeout(lostTimer);
  lostTimer = setTimeout(() => { if (events.readyState !== EventSource.OPEN) $('lost').hidden = false; }, 4000);
};

boot = await call('boot');
for (const c of boot.contributes.commands || []) commandsById.set(c.command, { title: c.title, icon: c.icon });
Object.assign(contexts, boot.contexts);
for (const i of boot.statusItems) statusItems.set(i.id, i);
drawStatus();
drawHeader();
reload();

$('empty-query').addEventListener('click', () => runCommand('onelakeStudio.newQuery'));

addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (e.ctrlKey && e.altKey && k === 'o') { e.preventDefault(); runCommand('onelakeStudio.goTo'); }
  else if (e.ctrlKey && k === 'w' && current) { e.preventDefault(); closeTab(current); }
  else if (k === 'f5' || (e.ctrlKey && k === 'r')) e.preventDefault();   // a reload would lose every tab
  else if (k === 'escape') closeMenu();
});
addEventListener('contextmenu', e => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); });

// The sidebar's width, dragged.
const sash = $('sash');
sash.addEventListener('pointerdown', e => {
  sash.setPointerCapture(e.pointerId);
  sash.classList.add('moving');
  document.querySelectorAll('#pages iframe').forEach(f => { f.style.pointerEvents = 'none'; });
  const move = ev => { $('side').style.width = `${Math.max(160, Math.min(innerWidth * 0.7, ev.clientX))}px`; };
  const up = () => {
    sash.classList.remove('moving');
    document.querySelectorAll('#pages iframe').forEach(f => { f.style.pointerEvents = ''; });
    sash.removeEventListener('pointermove', move);
  };
  sash.addEventListener('pointermove', move);
  sash.addEventListener('pointerup', up, { once: true });
});
