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

function renderDateAxis(container, series) {
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

  container.append(axis);
}

function renderBars(container, series, definitions) {
  if (!container) return;
  container.replaceChildren();

  const maximum = Math.max(
    1,
    ...series.flatMap(day => definitions.map(definition => Number(day[definition.key]) || 0))
  );

  const plot = createElement('div', 'stats-chart-plot');
  plot.style.setProperty('--stats-chart-columns', String(series.length));

  series.forEach(day => {
    const column = createElement('div', 'stats-chart-column');
    const bars = createElement('div', 'stats-chart-bars');
    const dateLabel = formatDate(day.date);

    definitions.forEach(definition => {
      const value = Number(day[definition.key]) || 0;
      const bar = createElement('span', `stats-chart-bar ${definition.className}`);
      bar.style.height = `${(value / maximum) * 100}%`;
      bar.dataset.zero = value === 0 ? 'true' : 'false';
      bar.title = `${dateLabel}: ${definition.label} ${value}`;
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', bar.title);
      bars.append(bar);
    });

    column.append(bars);
    plot.append(column);
  });

  container.append(plot);
  renderDateAxis(container, series);
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

  renderBars(activityContainer, series, [
    { key: 'blocked', className: 'blocked', label: labels.blocked },
    { key: 'redirected', className: 'redirected', label: labels.redirected }
  ]);

  renderBars(focusContainer, series, [
    { key: 'focusSessions', className: 'focus', label: labels.focus }
  ]);

  return series;
}
