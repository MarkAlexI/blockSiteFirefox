// Deterministic PCM model of the native oscillator + AudioParam schedule
// captured by the production-player fixture. This checks signal energy and
// headroom, not speaker loudness, OS mixing or native browser playback.
export function renderSoundGraph(nodes, sampleRate = 48000) {
  const origin = Math.min(...nodes.map(node => node.startAt)) - 0.025;
  const samples = new Float64Array(sampleRate);
  function valueAt(events, at) {
    let previous = { value: 0, at: origin };
    for (const event of events) {
      if (at < event.at) {
        const part = (at - previous.at) / (event.at - previous.at);
        if (event.method === 'linearRampToValueAtTime') return previous.value + (event.value - previous.value) * part;
        if (event.method === 'exponentialRampToValueAtTime') return previous.value * (event.value / previous.value) ** part;
        return previous.value;
      }
      previous = event;
    }
    return previous.value;
  }
  for (let index = 0; index < samples.length; index++) {
    const at = origin + index / sampleRate;
    for (const node of nodes) {
      if (at < node.startAt || at >= node.stopAt) continue;
      const envelope = valueAt(node.target.envelope, at);
      samples[index] += envelope * Math.sin(2 * Math.PI * node.frequencyValue * (at - node.startAt));
    }
  }
  const peak = samples.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
  const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  return { peak, rms, rmsDbfs: 20 * Math.log10(rms), headroomDb: -20 * Math.log10(peak), samples };
}
