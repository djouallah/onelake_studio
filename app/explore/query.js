// =============================================================================
// explore/query.js — Explore's SQL over the model, compiled to SQL over its tables
// =============================================================================
// Explore asks in SQL over the model (explore.js's modelSql: SELECT "table"."column",
// AGG("measure") … FROM <model>), and so does Show SQL's box, where that SELECT may be the whole
// text or a relation inside any other SQL. dax-sql compiles each SELECT over the model in place
// (compileStatement): DAX's filter context, context transition, relationships and blanks, as
// the measures say. One compiler per model, built by the host with its own `tableSource` (the
// panel: the engine's views of the Direct Lake tables; the Fabric app: v_<table>) and these
// output casts. The same file in the panel and in Export to Fabric's app.
// =============================================================================

// The compiler's output casts (dax-sql's castOutput): Explore's rows go straight to the page,
// so a date comes back as text, a whole number as BIGINT and any other number as DOUBLE — what
// JS can hold. Not INTEGER: that is 32-bit, and a SUM or a key past 2^31 failed as an overflow.
// The extension hands a BIGINT over as a Number whenever it fits in one; DuckDB-WASM (the
// Fabric app) is opened with castBigIntToDouble.
export const EXPLORE_CASTS = {
  int: s => `CAST(${s} AS BIGINT)`,
  double: s => `CAST(${s} AS DOUBLE)`,
  decimal: s => `CAST(${s} AS DOUBLE)`,
  datetime: s => `CAST(CAST(${s} AS DATE) AS VARCHAR)`,
};

// SQL text with SELECTs over model `name` in it, as the SQL that runs: each of them compiled in
// place, the rest as written. DAX text is refused: Explore takes SQL.
export function compileModelSql(compiler, text, name = 'model') {
  if (compiler.isDax?.(text)) throw new Error('Explore takes SQL: SELECT … FROM the model, or SQL over the tables');
  return compiler.compileStatement(text, name).sql;
}
