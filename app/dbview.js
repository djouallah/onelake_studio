// =============================================================================
// dbview.js — a database file's contents: its schemas, tables, views and columns
// =============================================================================
// The tree beside the SQL box, and the two cards that go with it: the whole file, and one table
// or view. All from the file's own catalog (paths.js dbCatalog), so showing them reads no rows.
// Every name in here comes from a file, so it is text or escaped, never markup.
// =============================================================================
import { dbRowsText, dbTreeRows, escapeHtml } from "./paths.js";

const n0 = v => Number(v).toLocaleString("en");
const kv = rows => "<table>" + rows.map(([k, v]) =>
  `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`).join("") + "</table>";
const kindName = o => o.kind === "view" ? "View" : "Table";

// The whole file: what opening it shows. A name there opens that table: `data-object` is its
// place in catalog.objects.
export function dbOverviewHtml(catalog, { engine, size, alias }) {
  const count = kind => catalog.objects.filter(o => o.kind === kind).length;
  const head = kv([["Engine", engine], ["Size", size], ["Schemas", n0(catalog.schemas.length)],
                   ["Tables", n0(count("table"))], ["Views", n0(count("view"))], ["In SQL", alias]]);
  if (!catalog.objects.length) return head + '<p class="statsNote">This file holds no tables or views.</p>';
  const place = new Map(catalog.objects.map((o, i) => [o, i]));
  const schemas = catalog.schemas.map(s => {
    const comments = s.objects.some(o => o.comment);
    const rows = s.objects.map(o => `<tr><td><button class="dbLink" data-object="${place.get(o)}">${escapeHtml(o.name)}</button></td>` +
      `<td>${kindName(o)}</td><td class="num">${escapeHtml(dbRowsText(o))}</td><td class="num">${n0(o.columns.length)}</td>` +
      (comments ? `<td>${escapeHtml(o.comment || "")}</td>` : "") + "</tr>").join("");
    return `<h3>${escapeHtml(s.name)}</h3><table class="dbList"><tr><th>Name</th><th>Kind</th><th class="num">Rows</th><th class="num">Columns</th>` +
      (comments ? "<th>Comment</th>" : "") + `</tr>${rows}</table>`;
  }).join("");
  return head + schemas + `<p class="statsNote">From the file's own catalog: no rows have been read. Pick a table for its columns, keys and rows.</p>`;
}

// One table or view: everything the catalog says about it, and a column nobody filled is left out.
export function dbObjectHtml(o) {
  const facts = [["Kind", kindName(o)], ["Schema", o.schema], ["In SQL", o.sqlName], ["Columns", n0(o.columns.length)]];
  if (o.rows != null) {
    facts.splice(3, 0, ["Rows", o.rowsExact ? dbRowsText(o) : `${dbRowsText(o)} (the file's estimate: deleted rows may still count)`]);
  }
  if (o.comment) facts.push(["Comment", o.comment]);
  const key = c => [c.pk ? "PK" : "", c.fk ? `FK → ${c.fk}` : ""].filter(Boolean).join(", ");
  const parts = [
    ["Name", c => c.name], ["Type", c => c.type], ["Null", c => (c.nullable ? "yes" : "no")],
    ["Default", c => c.dflt ?? ""], ["Key", key], ["Comment", c => c.comment || ""],
  ].filter(([, get], i) => i < 3 || o.columns.some(c => get(c) !== ""));
  const columns = o.columns.length
    ? "<h3>Columns</h3><table class=\"dbList\"><tr>" + parts.map(([h]) => `<th>${h}</th>`).join("") + "</tr>" +
      o.columns.map(c => "<tr>" + parts.map(([, get]) => `<td>${escapeHtml(String(get(c)))}</td>`).join("") + "</tr>").join("") + "</table>"
    : "";
  const constraints = o.constraints.length
    ? "<h3>Constraints</h3><pre class=\"doc\">" + o.constraints.map(c => escapeHtml(c.text)).join("\n") + "</pre>" : "";
  const indexes = o.indexes.length
    ? "<h3>Indexes</h3><pre class=\"doc\">" + o.indexes.map(i => escapeHtml(i.sql || i.name)).join("\n") + "</pre>" : "";
  const definition = o.sql ? `<h3>Definition</h3><pre class="doc">${escapeHtml(o.sql)}</pre>` : "";
  return kv(facts) + columns + constraints + indexes + definition +
    `<p class="statsNote">From the file's own catalog: no rows have been read. Open Data for the first rows.</p>`;
}

const ICONS = { table: "▦", view: "◫", schema: "▤", column: "" };

// The tree, in `root`. onOverview: the file was picked; onPick(object): a table or view was;
// onInsert(text): its name, for the box.
export function mountDbBrowser(root, { title, catalog, onOverview, onPick, onInsert, quote }) {
  const closed = new Set(), open = new Set();
  let filter = "", selected = "overview", focusKey = "overview";

  const input = document.createElement("input");
  input.type = "search";
  input.className = "dbFilter";
  input.placeholder = "Filter tables and columns";
  input.setAttribute("aria-label", "Filter tables and columns");
  input.spellcheck = false;
  const tree = document.createElement("div");
  tree.className = "dbTree";
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", `What ${title} holds`);
  root.replaceChildren(input, tree);

  const rowsNow = () => [
    { key: "overview", level: 0, type: "file", name: title },
    ...dbTreeRows(catalog, { closed, open, filter }),
  ];
  let rows = [];

  function rowEl(r) {
    const el = document.createElement("div");
    el.className = `dbRow dbRow-${r.type}`;
    el.dataset.key = r.key;
    el.setAttribute("role", "treeitem");
    el.setAttribute("aria-level", String(r.level + 1));
    el.setAttribute("aria-selected", String(r.key === selected));
    el.tabIndex = r.key === focusKey ? 0 : -1;
    el.style.paddingLeft = `${0.3 + r.level * 0.85}rem`;
    if (r.expanded != null) el.setAttribute("aria-expanded", String(r.expanded));
    const part = (cls, text) => {
      const s = document.createElement("span");
      s.className = cls;
      s.textContent = text;
      el.append(s);
    };
    part("dbTwisty", r.expanded == null ? "" : r.expanded ? "▾" : "▸");
    if (ICONS[r.type]) part("dbIcon", ICONS[r.type]);
    part("dbName", r.name);
    el.title = r.name;
    if (r.type === "schema") part("dbNote", n0(r.count));
    if (r.object && r.type !== "column") {
      part("dbNote", dbRowsText(r.object));
      el.title = `${kindName(r.object)} ${r.object.sqlName}`;
    }
    if (r.type === "column") {
      const c = r.column;
      if (c.pk) part("dbBadge", "PK");
      if (c.fk) part("dbBadge", "FK");
      part("dbNote", c.type);
      el.title = `${c.name} ${c.type}${c.nullable ? "" : " NOT NULL"}${c.fk ? `, references ${c.fk}` : ""}`;
    }
    if (r.object) {
      const b = document.createElement("button");
      b.className = "dbInsert";
      b.tabIndex = -1;
      b.textContent = "↳";
      b.title = "Put its name in the box (i)";
      b.setAttribute("aria-label", `Put ${r.name} in the box`);
      el.append(b);
    }
    return el;
  }

  function draw({ focus = false } = {}) {
    rows = rowsNow();
    if (!rows.some(r => r.key === focusKey)) focusKey = rows[0].key;
    tree.replaceChildren(...rows.map(rowEl));
    if (focus) tree.querySelector(`[tabindex="0"]`)?.focus();
  }

  const toggle = r => {
    if (r.type === "schema") {
      if (r.expanded) closed.add(r.name); else closed.delete(r.name);
    } else if (r.object && r.type !== "column") {
      if (r.expanded) open.delete(r.object.id); else open.add(r.object.id);
    }
  };
  const insert = r => onInsert(r.type === "column" ? quote(r.name) : r.object.sqlName);
  function activate(r) {
    if (r.type === "file") { onOverview(); return; }
    if (r.type === "schema") { toggle(r); draw({ focus: true }); return; }
    if (r.type !== "column") onPick(r.object);
  }

  tree.addEventListener("click", e => {
    const el = e.target.closest(".dbRow");
    const r = el && rows.find(x => x.key === el.dataset.key);
    if (!r) return;
    focusKey = r.key;
    if (e.target.closest(".dbInsert")) { insert(r); return; }
    if (e.target.closest(".dbTwisty") && r.expanded != null) { toggle(r); draw({ focus: true }); return; }
    activate(r);
    draw({ focus: true });
  });

  tree.addEventListener("keydown", e => {
    const at = rows.findIndex(x => x.key === focusKey);
    const r = rows[at];
    if (!r) return;
    const go = i => { if (rows[i]) { focusKey = rows[i].key; draw({ focus: true }); } };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(rows.length - 1);
    else if (e.key === "ArrowRight") {
      if (r.expanded === false) { toggle(r); draw({ focus: true }); } else if (r.expanded) go(at + 1);
    } else if (e.key === "ArrowLeft") {
      if (r.expanded) { toggle(r); draw({ focus: true }); } else {
        // Up to the row it sits under.
        for (let i = at - 1; i >= 0; i--) if (rows[i].level < r.level) { go(i); break; }
      }
    } else if (e.key === "Enter" || e.key === " ") { activate(r); draw({ focus: true }); }
    else if (e.key === "i" && r.object) insert(r);
    else return;
    e.preventDefault();
  });

  input.addEventListener("input", () => { filter = input.value; draw(); });

  draw();
  return {
    // What the tab is showing: an object's id, "overview" for the file, null for neither.
    select(id) {
      selected = id == null ? null : id === "overview" ? "overview" : `object:${id}`;
      if (selected) focusKey = selected;
      draw();
    },
    destroy() { root.replaceChildren(); },
  };
}
