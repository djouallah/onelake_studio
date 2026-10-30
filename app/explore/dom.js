// =============================================================================
// explore/dom.js — el(), the one DOM builder Explore's pages share
// =============================================================================
// el(tag, attrs, ...kids): an element, `svg:<tag>` for one in the SVG namespace. An attribute
// that is null or false is left off and true is set empty; `on<event>` adds a listener and
// `style` is the inline style. Kids are nodes or text, flattened, nulls dropped.
// =============================================================================

const SVG = 'http://www.w3.org/2000/svg';

export function el(tag, attrs = {}, ...kids) {
  const n = tag.startsWith('svg:') ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    // setAttribute, not className: an SVG element's className cannot be assigned.
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.flat().filter(k => k != null));
  return n;
}
