// =============================================================================
// explore/theme.js — Explore's chart theme and series colours, from the page's CSS tokens
// =============================================================================
// Pure: no CDN, no host. view.js uses it in the panel, and Export to Fabric's page
// (src/exportapp.js) uses the same file, so a chart looks the same in both.
// =============================================================================

// Series colours, on a dark card (the dashboard's palette).
export const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#4f9a3a', '#9085e9', '#e66767', '#5aa7b8', '#b0762f', '#a86bc4', '#7f8a9c'];

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
    categoryAxis: axis, valueAxis: axis, timeAxis: axis,
    dataZoom: { borderColor: 'transparent', backgroundColor: split, fillerColor: css('--hover'),
      textStyle: { color: muted } },
    visualMap: { textStyle: { color: muted }, handleStyle: { color: css('--card'), borderColor: muted } },
  });
}
