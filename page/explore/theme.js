// =============================================================================
// explore/theme.js — Explore's chart theme and series colours, from the page's CSS tokens
// =============================================================================
// Pure: no CDN, no host. view.js, the SQL box's chart and the plan's profile use it.
// =============================================================================

// Series colours, each of them mid-toned enough for a dark or a light card.
export const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#4f9a3a', '#9085e9', '#e66767', '#5aa7b8', '#b0762f', '#a86bc4', '#7f8a9c'];

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
