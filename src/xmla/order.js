'use strict';
// order.js — members in the order Excel shows them: by their sort-by column, numbers as numbers.

const NUMERIC = new Set(['int64', 'double', 'decimal']);

// What a value is ordered by. A big integer or a decimal comes back as text, so the column says.
function sortKey(value, column) {
  if (value == null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return Number(value);
  if (NUMERIC.has(column.dataType) || (column.sortBy && !Number.isNaN(Number(value)) && value !== '')) {
    const n = Number(value);
    if (!Number.isNaN(n)) return n;
  }
  return String(value);
}

const text = new Intl.Collator('en', { sensitivity: 'base' });
function compareOne(a, b) {
  if (a === b) return 0;
  if (a == null) return -1;      // blanks first, as DAX orders them
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return text.compare(String(a), String(b));
}

// A parent before its children: a shorter path sorts first when the longer starts with it.
function compareKeys(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareOne(a[i], b[i]);
    if (c) return c;
  }
  return a.length - b.length;
}

module.exports = { sortKey, compareKeys };
