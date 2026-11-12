// =============================================================================
// explore/theme.js — Explore's chart theme and series colours, from the page's CSS tokens
// =============================================================================
// Pure: no CDN, no host. view.js uses it in the panel, and Export to Fabric's page
// (fabric_app/export/exportapp.js) uses the same file, so a chart looks the same in both.
// =============================================================================

// Series colours, each of them mid-toned enough for a dark or a light card.
export const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#4f9a3a', '#9085e9', '#e66767', '#5aa7b8', '#b0762f', '#a86bc4', '#7f8a9c'];

// A Report's colours (its theme's `palette`), Studio's first; each as mid-toned as PALETTE.
export const PALETTES = {
  studio: PALETTE,
  ocean: ['#2f7fc1', '#1fa2a6', '#5b6fd6', '#3cae7a', '#7d93c9', '#2a9bd8', '#6a5acd', '#4bb3c8', '#3a6ea5', '#58b38c'],
  warm: ['#d95926', '#c98500', '#d55181', '#b0762f', '#e66767', '#c06a2b', '#a8558a', '#d9932b', '#b8483a', '#cf7a52'],
  mono: ['#4a6fa5', '#6d8fbf', '#8fa9cf', '#3a5580', '#a9bcd9', '#5a7db3', '#2e4466', '#7f9cc7', '#c2d0e5', '#1f2f47'],
  // A style's own (STYLES): earth colours on paper, bright ones on midnight, one blue then greys on slate.
  paper: ['#b5532a', '#3f7d6e', '#c9973b', '#5b6c9a', '#8f4f6b', '#6f8f3e', '#a8703d', '#3d7fa3', '#93613f', '#7a7466'],
  midnight: ['#5ea0ff', '#ff8a5c', '#3ddbb0', '#ffc857', '#ff6fa8', '#9b8cff', '#5fd4f0', '#b6e36a', '#ff7b7b', '#c59bff'],
  slate: ['#2f6fde', '#4b5563', '#7b8794', '#a3acb9', '#1f2937', '#c5ccd6', '#64748b', '#94a3b8', '#374151', '#d1d5db'],
};

// A Report's style (its theme's `style`): the whole look at once. Each is a class on the report's
// page (explore.css rp-style-<name>: its page's, tiles' and text's colours, its corners, its
// titles' font), its own palette (PALETTES, by its name) until the theme picks another, and what
// its charts add (styleChart). None is Studio: the editor's colours, or the theme's background.
export const STYLES = {
  paper: { name: 'Paper' },
  midnight: { name: 'Midnight' },
  slate: { name: 'Slate' },
};

/**
 * A chart's option as the Report's `style` draws it: on midnight a line glows in its own colour,
 * on slate a bar's ends are square. The option given is not changed; any other style, as it is.
 */
export function styleChart(option, style) {
  if (!Array.isArray(option?.series) || (style !== 'midnight' && style !== 'slate')) return option;
  return { ...option, series: option.series.map(s => {
    if (style === 'midnight' && s.type === 'line' && s.lineStyle) {
      return { ...s, lineStyle: { ...s.lineStyle, shadowBlur: 10, shadowColor: s.lineStyle.color ?? s.itemStyle?.color } };
    }
    if (style === 'slate' && s.type === 'bar' && s.itemStyle?.borderRadius) return { ...s, itemStyle: { ...s.itemStyle, borderRadius: 0 } };
    return s;
  }) };
}

// Registers ECharts theme `name`, its colours read off the page's tokens (`css(name)`).
export function registerChartTheme(echarts, css, name = 'studio') {
  const text = css('--text'), muted = css('--muted'), line = css('--border'), split = css('--row-line');
  // Grid lines are dashed: they are read past, not read.
  const axis = { axisLine: { lineStyle: { color: line } }, axisTick: { lineStyle: { color: line } },
    axisLabel: { color: muted, fontSize: 11 }, splitLine: { lineStyle: { color: split, type: [3, 4] } }, nameTextStyle: { color: muted } };
  echarts.registerTheme(name, {
    backgroundColor: 'transparent',
    textStyle: { color: muted, fontFamily: getComputedStyle(document.body).fontFamily },
    title: { textStyle: { color: text } },
    legend: { icon: 'circle', itemWidth: 9, itemHeight: 9, itemGap: 14, textStyle: { color: muted, fontSize: 12 },
      pageTextStyle: { color: muted }, pageIconColor: muted, pageIconInactiveColor: css('--disabled') },
    tooltip: { backgroundColor: css('--raised'), borderColor: line, borderWidth: 1, padding: [8, 12],
      axisPointer: { lineStyle: { color: muted, type: 'dashed' }, shadowStyle: { color: css('--hover') || 'rgba(128,128,128,0.12)' } },
      textStyle: { color: text, fontSize: 12 }, extraCssText: `border-radius:10px;box-shadow:${css('--shadow')};` },
    // A value axis is its grid lines and its labels: no line of its own, no ticks. A category
    // axis is its line and its labels: no ticks.
    categoryAxis: { ...axis, axisTick: { show: false } },
    valueAxis: { ...axis, axisLine: { show: false }, axisTick: { show: false } }, timeAxis: axis,
    dataZoom: { borderColor: 'transparent', backgroundColor: split, fillerColor: css('--hover'),
      textStyle: { color: muted } },
    visualMap: { textStyle: { color: muted }, handleStyle: { color: css('--card'), borderColor: muted } },
  });
}
