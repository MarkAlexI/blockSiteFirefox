import { buildStatisticsSeries } from '../pro/statisticsHistory.js';

function createElement(tagName, className) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  return element;
}

function getVisibleDateIndices(length) {
  if (length <= 7) {
    return Array.from({ length }, (_, index) => index);
  }

  const indices = [];
  for (let index = 0; index < length; index += 1) {
    if (index === 0 || index === length - 1 || index % 5 === 0) {
      indices.push(index);
    }
  }
  return indices;
}

export function buildDateTickPlan(series) {
  const indices = getVisibleDateIndices(series.length);
  let previousVisibleMonth = null;

  return indices.map((index, tickIndex) => {
    const date = series[index].date;
    const month = date.getMonth();
    const includeMonth = series.length <= 7 || tickIndex === 0 || month !== previousVisibleMonth;
    previousVisibleMonth = month;

    return {
      index,
      date,
      includeMonth
    };
  });
}

export function summarizeStatisticsSeries(series) {
  return series.reduce((totals, day) => ({
    blocked: totals.blocked + (Number(day.blocked) || 0),
    redirected: totals.redirected + (Number(day.redirected) || 0),
    focusSessions: totals.focusSessions + (Number(day.focusSessions) || 0)
  }), {
    blocked: 0,
    redirected: 0,
    focusSessions: 0
  });
}

export function buildChartScale(series, definitions) {
  const maximumValue = Math.max(
    0,
    ...series.flatMap(day => definitions.map(definition => Number(day[definition.key]) || 0))
  );

  if (maximumValue <= 1) {
    return {
      maximum: 1,
      ticks: [1, 0]
    };
  }

  const roughStep = maximumValue / 5;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = Math.max(1, factor * magnitude);
  const maximum = Math.ceil(maximumValue / step) * step;
  const ticks = [];

  for (let value = maximum; value >= 0; value -= step) {
    ticks.push(Number(value.toFixed(10)));
  }

  return { maximum, ticks };
}

function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric'
  }).format(date);
}

function formatAxisDate(date, includeMonth) {
  return new Intl.DateTimeFormat(undefined, includeMonth ? {
    month: 'short',
    day: 'numeric'
  } : {
    day: 'numeric'
  }).format(date);
}

function formatDaySummary(day, definitions) {
  const values = definitions.map(definition =>
    `${definition.label}: ${Number(day[definition.key]) || 0}`
  );
  return `${formatDate(day.date)} · ${values.join(' · ')}`;
}

function createDateAxis(series) {
  const axis = createElement('div', 'stats-chart-axis');
  const ticks = buildDateTickPlan(series);
  const columnCount = Math.max(1, series.length);

  ticks.forEach(({ index, date, includeMonth }, tickIndex) => {
    const tick = createElement('span', 'stats-chart-date');
    const fullDate = formatDate(date);
    tick.textContent = formatAxisDate(date, includeMonth);
    tick.title = fullDate;
    tick.style.left = `${((index + 0.5) / columnCount) * 100}%`;

    if (series.length > 7 && tickIndex === 0) {
      tick.dataset.edge = 'start';
    } else if (series.length > 7 && tickIndex === ticks.length - 1) {
      tick.dataset.edge = 'end';
    }

    axis.append(tick);
  });

  return axis;
}

function createValueAxis(ticks) {
  const axis = createElement('div', 'stats-chart-y-axis');
  axis.setAttribute('aria-hidden', 'true');

  ticks.forEach(value => {
    const tick = createElement('span', 'stats-chart-y-tick');
    tick.textContent = String(value);
    axis.append(tick);
  });

  return axis;
}

function renderBars(container, series, definitions) {
  if (!container) return;
  container.replaceChildren();

  const { maximum, ticks } = buildChartScale(series, definitions);
  const layout = createElement('div', 'stats-chart-layout');
  const main = createElement('div', 'stats-chart-main');
  const plot = createElement('div', 'stats-chart-plot');
  const detail = createElement('div', 'stats-chart-detail');
  const columns = [];
  let selectedIndex = Math.max(0, series.length - 1);

  plot.style.setProperty('--stats-chart-columns', String(series.length));
  plot.style.setProperty('--stats-chart-grid-size', `${100 / Math.max(1, ticks.length - 1)}%`);

  const updateDetail = index => {
    const day = series[index];
    if (!day) return;
    detail.textContent = formatDaySummary(day, definitions);
  };

  const selectColumn = (index, { focus = false } = {}) => {
    const column = columns[index];
    if (!column) return;

    selectedIndex = index;
    columns.forEach((item, itemIndex) => {
      const selected = itemIndex === index;
      item.dataset.selected = selected ? 'true' : 'false';
      item.setAttribute('aria-pressed', String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    updateDetail(index);
    if (focus) column.focus();
  };

  series.forEach((day, index) => {
    const column = createElement('div', 'stats-chart-column');
    const bars = createElement('div', 'stats-chart-bars');
    const summary = formatDaySummary(day, definitions);

    column.dataset.selected = 'false';
    column.tabIndex = index === selectedIndex ? 0 : -1;
    column.setAttribute('role', 'button');
    column.setAttribute('aria-pressed', 'false');
    column.setAttribute('aria-label', summary);
    column.title = summary;

    definitions.forEach(definition => {
      const value = Number(day[definition.key]) || 0;
      const bar = createElement('span', `stats-chart-bar ${definition.className}`);
      bar.style.height = `${(value / maximum) * 100}%`;
      bar.dataset.zero = value === 0 ? 'true' : 'false';
      bar.setAttribute('aria-hidden', 'true');
      bars.append(bar);
    });

    column.append(bars);
    column.addEventListener('mouseenter', () => updateDetail(index));
    column.addEventListener('click', () => selectColumn(index));
    column.addEventListener('focus', () => selectColumn(index));
    column.addEventListener('keydown', event => {
      let nextIndex = null;
      if (event.key === 'ArrowLeft') nextIndex = Math.max(0, index - 1);
      if (event.key === 'ArrowRight') nextIndex = Math.min(series.length - 1, index + 1);
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = series.length - 1;
      if (nextIndex === null || nextIndex === index) return;
      event.preventDefault();
      selectColumn(nextIndex, { focus: true });
    });

    columns.push(column);
    plot.append(column);
  });

  plot.addEventListener('mouseleave', () => updateDetail(selectedIndex));

  main.append(plot, createDateAxis(series));
  layout.append(createValueAxis(ticks), main);
  container.append(layout, detail);
  selectColumn(selectedIndex);
}

export function renderStatisticsCharts({
  stats,
  days,
  activityContainer,
  focusContainer,
  labels,
  now = new Date()
}) {
  const series = buildStatisticsSeries(stats, days, now);
  const totals = summarizeStatisticsSeries(series);

  renderBars(activityContainer, series, [
    { key: 'blocked', className: 'blocked', label: labels.blocked },
    { key: 'redirected', className: 'redirected', label: labels.redirected }
  ]);

  renderBars(focusContainer, series, [
    { key: 'focusSessions', className: 'focus', label: labels.focus }
  ]);

  return { series, totals };
}
