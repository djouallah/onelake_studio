'use strict';
// order.js — members in the order Excel shows them: by their sort-by column, numbers as numbers.

const NUMERIC = new Set(['int64', 'double', 'decimal']);

// A timestamp with a zone comes back in this machine's offset, which changes with the season. As
// the UTC it is stored in, it says one thing, sorts as text, and is a literal again in a filter.
const ZONED = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:?\d{2})?$/;
function plainValue(v) {
  if (typeof v !== 'string' || !ZONED.test(v)) return v;
  const iso = v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return v;
  const [day, time] = new Date(ms).toISOString().replace('Z', '').split('T');
  return `${day} ${time.replace(/\.000$/, '')}`;
}

// What a value is ordered by. A big integer or a decimal comes back as text, so the column says.
function sortKey(raw, column) {
  const value = plainValue(raw);
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

module.exports = { plainValue, sortKey, compareKeys };
