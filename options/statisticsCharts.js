import { buildStatisticsSeries } from '../pro/statisticsHistory.js';

function createElement(tagName, className) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  return element;
}

function shouldShowDateLabel(index, length) {
  if (length <= 7) return true;
  return index === 0 || index === length - 1 || index % 5 === 0;
}

function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric'
  }).format(date);
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

  series.forEach((day, index) => {
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

    const label = createElement('span', 'stats-chart-date');
    if (shouldShowDateLabel(index, series.length)) {
      label.textContent = dateLabel;
      label.title = dateLabel;
    } else {
      label.setAttribute('aria-hidden', 'true');
    }

    column.append(bars, label);
    plot.append(column);
  });

  container.append(plot);
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
