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
};

// Registers ECharts theme `name`, its colours read off the page's tokens (`css(name)`).
export function registerChartTheme(echarts, css, name = 'studio') {
  const text = css('--text'), muted = css('--muted'), line = css('--border'), split = css('--row-line');
  const axis = { axisLine: { lineStyle: { color: line } }, axisTick: { lineStyle: { color: line } },
    axisLabel: { color: muted, fontSize: 12 }, splitLine: { lineStyle: { color: split } }, nameTextStyle: { color: muted } };
  echarts.registerTheme(name, {
    backgroundColor: 'transparent',
    textStyle: { color: muted, fontFamily: getComputedStyle(document.body).fontFamily },
    title: { textStyle: { color: text } },
    legend: { icon: 'circle', itemWidth: 9, itemHeight: 9, itemGap: 14, textStyle: { color: muted, fontSize: 12 },
      pageTextStyle: { color: muted }, pageIconColor: muted, pageIconInactiveColor: css('--disabled') },
    tooltip: { backgroundColor: css('--raised'), borderColor: line, borderWidth: 1, padding: [8, 12],
      textStyle: { color: text, fontSize: 12 }, extraCssText: `border-radius:10px;box-shadow:${css('--shadow')};` },
    // A value axis is its grid lines and its labels: no line of its own, no ticks.
    categoryAxis: { ...axis, axisTick: { ...axis.axisTick, alignWithLabel: true } },
    valueAxis: { ...axis, axisLine: { show: false }, axisTick: { show: false } }, timeAxis: axis,
    dataZoom: { borderColor: 'transparent', backgroundColor: split, fillerColor: css('--hover'),
      textStyle: { color: muted } },
    visualMap: { textStyle: { color: muted }, handleStyle: { color: css('--card'), borderColor: muted } },
  });
}
