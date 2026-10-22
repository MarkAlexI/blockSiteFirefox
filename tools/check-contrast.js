import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function luminance(channels) {
  return channels.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
export function contrastRatio(first, second) {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}
const hexChannels = value => value.slice(1).match(/../g).map(channel => parseInt(channel, 16));

// A palette guard complements computed-style/browser checks; it is not a full WCAG audit.
export function checkPalette(css) {
  const palette = Object.fromEntries([...css.matchAll(/--bd-([\w-]+):\s*(#[\da-f]{6});/gi)]
    .map(([, name, value]) => [name, hexChannels(value)]));
  const required = name => {
    if (!palette[name]) throw new Error(`Missing palette color: ${name}`);
    return palette[name];
  };
  const results = [];
  const check = (name, first, second, minimum) => {
    const ratio = contrastRatio(first, second);
    if (ratio < minimum) throw new Error(`${name}: ${ratio.toFixed(2)}:1 is below ${minimum}:1`);
    results.push({ name, ratio, minimum });
  };
  for (const color of ['primary','primary-hover','secondary','secondary-hover','success','success-hover','danger','danger-hover','warning']) {
    check(`white text on ${color}`, required('surface'), required(color), 4.5);
  }
  for (const surface of ['surface','surface-soft','canvas','success-soft','danger-soft','warning-soft']) {
    for (const color of ['text','muted','primary','secondary','success','danger','warning-text']) {
      check(`${color} text on ${surface}`, required(color), required(surface), 4.5);
    }
    check(`focus on ${surface}`, required('focus'), required(surface), 3);
  }
  for (const surface of ['surface','surface-soft','canvas']) {
    check(`control boundary on ${surface}`, required('control-border'), required(surface), 3);
  }
  for (const name of ['gradient','gradient-hover']) {
    const value = css.match(new RegExp(`--bd-${name}:([^;]+);`))?.[1];
    const stops = value?.match(/#[\da-f]{6}/gi);
    if (!stops?.length) throw new Error(`Missing ${name} stops`);
    for (const [index, stop] of stops.entries()) check(`white text on ${name} stop ${index}`, required('surface'), hexChannels(stop), 4.5);
  }
  const alpha = Number(css.match(/--bd-panel:\s*rgb\(255 255 255 \/\s*(\d+)%\)/)?.[1]) / 100;
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) throw new Error('Missing bounded glass opacity');
  // White panel composited over black is the darkest possible panel background.
  const darkestPanel = [255,255,255].map(value => value * alpha);
  for (const color of ['text','muted','primary','secondary','success','danger']) {
    check(`${color} text on glass over black`, required(color), darkestPanel, 4.5);
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const results = checkPalette(readFileSync(new URL('../styles/common.css', import.meta.url), 'utf8'));
    console.log(`Palette contrast check passed (${results.length} text, boundary, focus, gradient and glass pairs).`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
