'use strict';
// =============================================================================
// queryeditor.js — SQL is written in VS Code's own editor and run in the panel
// =============================================================================
// A query is a .sql document: a saved one (the tree's Queries, a file in the account's
// queries folder) or a new one this extension opened (untitled, until Save Query keeps it).
// Other .sql files are not touched: their keys, lenses and completions are their own
// extensions'.
//
// In a query's editor:
//   Ctrl+Enter / OneLake Run the statement under the cursor, or the selection, in the panel
//   OneLake Plan             the same statement's profile and plan, in the panel
//   a CodeLens above each statement for both
//   DuckDB's error           a diagnostic where DuckDB says it is, cleared by the next edit
//   completion               the names the cache holds: catalogs, workspaces, items, schemas,
//                            tables and their columns; a semantic model's measures as AGG("…")
// The panel does the running (app.js run-sql / plan-sql, the same path any query takes there),
// and its answer comes back through `run`.
// =============================================================================

const vscode = require('vscode');
const { statements, statementAt, errorOffset, errorSummary, dottedName, namesIn } = require('./querytext');
const { sqlPart, SQL_KINDS, MODEL_CATALOG } = require('./names');
const { quoteIdent } = require('./sql');

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * @param {object} o
 * @param {(doc: vscode.TextDocument) => boolean} o.isQuery     a query's document
 * @param {(sql: string, x: {plan: boolean, title: string, column: number|undefined}) =>
 *          Promise<{ok: boolean, error: string|null, rewritten: boolean}|null>} o.run
 *        the statement, run (or planned) in the panel; null when it never got there
 * @param {() => Promise<{tables: object[], models: object[]}>} o.names
 *        what the cache can name: tables { kind, workspace, item, schema, table, columns: [{name, type}] }
 *        and models { workspace, model, measures: [name], columns: [{table, name}] }
 * @returns {vscode.Disposable[]}
 */
function registerQueryEditor({ isQuery, run, names }) {
  const diagnostics = vscode.languages.createDiagnosticCollection('onelakeStudio');

  // The statement to run: the selection when there is one, else the one under the cursor; or,
  // from a CodeLens, the one starting at `at`.
  function target(doc, at, editor) {
    const text = doc.getText();
    if (at == null && editor && !editor.selection.isEmpty) {
      const start = doc.offsetAt(editor.selection.start), end = doc.offsetAt(editor.selection.end);
      return text.slice(start, end).trim() ? { start, end } : null;
    }
    const offset = at != null ? at : editor ? doc.offsetAt(editor.selection.active) : 0;
    return statementAt(statements(text), offset);
  }

  const titleOf = doc => (doc.isUntitled ? doc.uri.path : doc.uri.path.split('/').pop()).replace(/\.sql$/i, '');

  async function runAt(plan, uri, at) {
    const active = vscode.window.activeTextEditor;
    // From a CodeLens or the editor's title bar the document comes with the command (the title
    // bar gives no statement: the cursor's, when it is that editor).
    const doc = uri instanceof vscode.Uri ? await vscode.workspace.openTextDocument(uri) : active && active.document;
    if (!doc || !isQuery(doc)) return;
    const editor = active && active.document === doc ? active : null;
    const span = target(doc, typeof at === 'number' ? at : null, editor);
    if (!span) { vscode.window.setStatusBarMessage('OneLake Studio: no statement here to run', 3000); return; }
    const sql = doc.getText().slice(span.start, span.end);
    const version = doc.version;
    diagnostics.delete(doc.uri);
    const r = await run(sql, { plan, title: titleOf(doc), column: editor ? editor.viewColumn : undefined });
    if (!r || r.ok || !r.error || doc.isClosed || doc.version !== version) return;
    // Where DuckDB says the error is, as the statement is written; a semantic model's query ran
    // as the SQL it compiles to, whose positions are not the editor's: its first line then.
    const at2 = r.rewritten ? null : errorOffset(r.error, sql);
    let range;
    if (at2 != null) {
      const pos = doc.positionAt(span.start + at2);
      range = doc.getWordRangeAtPosition(pos) || new vscode.Range(pos, pos.translate(0, 1));
    } else {
      const first = doc.positionAt(span.start);
      range = new vscode.Range(first, doc.lineAt(first.line).range.end);
    }
    const message = String(r.error).replace(/\n+LINE \d+:[\s\S]*$/, '').trim() || errorSummary(r.error);
    const d = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
    d.source = 'OneLake Studio';
    diagnostics.set(doc.uri, [d]);
  }

  // A statement's ▶ Run and Plan, above its first line.
  const lenses = {
    provideCodeLenses(doc) {
      if (!isQuery(doc)) return [];
      return statements(doc.getText()).flatMap(st => {
        const p = doc.positionAt(st.start);
        const range = new vscode.Range(p, p);
        return [
          new vscode.CodeLens(range, { title: '▶ OneLake Run', command: 'onelakeStudio.runQuery', arguments: [doc.uri, st.start],
                                       tooltip: 'Run this statement in the OneLake Studio panel (Ctrl+Enter)' }),
          new vscode.CodeLens(range, { title: 'OneLake Plan', command: 'onelakeStudio.planQuery', arguments: [doc.uri, st.start],
                                       tooltip: 'Where this statement spends its time (it runs once to measure)' }),
        ];
      });
    },
  };

  // Completion: the dotted name being typed, one level at a time, from what the cache holds.
  // A bare word also gets the columns of the tables the statement names, and a model's
  // measures as AGG("measure").
  const completions = {
    async provideCompletionItems(doc, pos) {
      if (!isQuery(doc)) return undefined;
      const prefix = doc.lineAt(pos.line).text.slice(0, pos.character);
      const typed = dottedName(prefix);
      if (!typed) return undefined;
      const { tables, models } = await names();
      const range = new vscode.Range(pos.line, typed.start, pos.line, pos.character);
      const items = [];
      const K = vscode.CompletionItemKind;
      const add = (label, kind, detail, insert = sqlPart(label)) => {
        const it = new vscode.CompletionItem(label, kind);
        it.detail = detail;
        it.insertText = insert;
        it.range = range;
        // Matched against what was typed, quote and all.
        it.filterText = typed.quoted ? `"${label}` : label;
        items.push(it);
      };
      // The tables and models the statement under the cursor names, by their full SQL names.
      const named = () => {
        const text = doc.getText();
        const st = statementAt(statements(text), doc.offsetAt(pos));
        const found = { tables: [], models: [] };
        for (const p of st ? namesIn(text.slice(st.start, st.end)) : []) {
          if (p.length === 5) {
            const t = tables.find(x => same(x.kind, p[0]) && same(x.workspace, p[1]) && same(x.item, p[2]) &&
                                       same(x.schema, p[3]) && same(x.table, p[4]));
            if (t) found.tables.push(t);
          } else if (p.length === 3 && same(p[0], MODEL_CATALOG)) {
            const m = models.find(x => same(x.workspace, p[1]) && same(x.model, p[2]));
            if (m) found.models.push(m);
          }
        }
        return found;
      };
      const columnsOf = list => {
        for (const t of list) for (const c of t.columns || []) add(c.name, K.Field, `${t.table} · ${c.type || ''}`.trim());
      };
      const distinct = list => [...new Map(list.map(x => [String(x).toLowerCase(), x])).values()];
      const [kind, ws, item, schema, table] = typed.parts;
      const n = typed.parts.length;
      if (n === 0) {
        for (const k of [...SQL_KINDS, MODEL_CATALOG]) add(k, K.Module, 'catalog');
        // The statement's own tables' columns, and its models' measures and columns.
        const { tables: its, models: itsModels } = named();
        columnsOf(its);
        for (const m of itsModels) {
          for (const name of m.measures || []) {
            add(`AGG("${name}")`, K.Function, `measure of ${m.model}`, `AGG(${quoteIdent(name)})`);
            items[items.length - 1].filterText = `${name} AGG`;   // found by the measure's name
          }
          for (const c of m.columns || []) add(`${c.table}.${c.name}`, K.Field, `column of ${m.model}`, `${sqlPart(c.table)}.${sqlPart(c.name)}`);
        }
      } else if (same(kind, MODEL_CATALOG)) {
        if (n === 1) for (const w of distinct(models.map(m => m.workspace))) add(w, K.Folder, 'workspace');
        else if (n === 2) for (const m of models.filter(m => same(m.workspace, ws))) add(m.model, K.Class, 'semantic model');
      } else if (SQL_KINDS.some(k => same(k, kind))) {
        const of = tables.filter(t => same(t.kind, kind));
        if (n === 1) for (const w of distinct(of.map(t => t.workspace))) add(w, K.Folder, 'workspace');
        else if (n === 2) for (const i of distinct(of.filter(t => same(t.workspace, ws)).map(t => t.item))) add(i, K.Module, kind);
        else if (n === 3) {
          for (const s of distinct(of.filter(t => same(t.workspace, ws) && same(t.item, item)).map(t => t.schema))) add(s, K.Folder, 'schema');
        } else if (n === 4) {
          for (const t of of.filter(t => same(t.workspace, ws) && same(t.item, item) && same(t.schema, schema))) {
            add(t.table, K.Class, `table · ${(t.columns || []).length} columns`);
          }
        } else if (n === 5) {
          const t = of.find(t => same(t.workspace, ws) && same(t.item, item) && same(t.schema, schema) && same(t.table, table));
          for (const c of (t && t.columns) || []) add(c.name, K.Field, c.type || '');
        }
      } else if (n === 1) {
        // alias.col: the columns of every table the statement names, whichever the alias is.
        columnsOf(named().tables);
      }
      return items;
    },
  };

  // Every document, and isQuery picks: a query's language may be another SQL extension's.
  const docs = [{ scheme: 'untitled' }, { scheme: 'file' }];
  return [
    diagnostics,
    vscode.commands.registerCommand('onelakeStudio.runQuery', (uri, at) => runAt(false, uri, at)),
    vscode.commands.registerCommand('onelakeStudio.planQuery', (uri, at) => runAt(true, uri, at)),
    vscode.languages.registerCodeLensProvider(docs, lenses),
    vscode.languages.registerCompletionItemProvider(docs, completions, '.', '"'),
    // A diagnostic is about the text DuckDB saw: an edit makes it stale.
    vscode.workspace.onDidChangeTextDocument(e => { if (e.contentChanges.length) diagnostics.delete(e.document.uri); }),
    vscode.workspace.onDidCloseTextDocument(doc => diagnostics.delete(doc.uri)),
  ];
}

module.exports = { registerQueryEditor };
