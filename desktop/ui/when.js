// A `when` clause from package.json's menus, against what's known now. The forms the extension uses:
// a key, !key, key == value, key != value, key =~ /regex/, joined by && and ||. An unknown key is false.

const literal = text => {
  const t = text.trim();
  if (/^'.*'$/.test(t) || /^".*"$/.test(t)) return t.slice(1, -1);
  if (t === 'true') return true;
  if (t === 'false') return false;
  return t;
};

function term(text, context) {
  const t = text.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  const regex = /^(\S+)\s*=~\s*\/(.*)\/([a-z]*)$/.exec(t);
  if (regex) return new RegExp(regex[2], regex[3]).test(String(context[regex[1]] ?? ''));
  const compare = /^(\S+)\s*(==|!=)\s*(.+)$/.exec(t);
  if (compare) {
    const equal = String(context[compare[1]] ?? '') === String(literal(compare[3]));
    return compare[2] === '==' ? equal : !equal;
  }
  if (t.startsWith('!')) return !context[t.slice(1).trim()];
  return !!context[t];
}

export function when(clause, context) {
  if (!clause) return true;
  return clause.split('||').some(any => any.split('&&').every(all => term(all, context)));
}
