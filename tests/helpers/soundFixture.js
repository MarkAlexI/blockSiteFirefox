export function audioFixture({ resume, autoEnd = true, failAt = null } = {}) {
  const contexts = [];
  class AudioContext {
    constructor() { this.state = 'suspended'; this.currentTime = 10; this.destination = {}; this.nodes = []; this.closed = 0; contexts.push(this); }
    async resume() { if (resume) await resume(); if (this.state !== 'closed') this.state = 'running'; }
    close() { this.closed++; this.state = 'closed'; return Promise.resolve(); }
    createOscillator() {
      if (failAt === this.nodes.length) throw new Error('audio device unavailable');
      const node = { frequency: { setValueAtTime: (value, at) => { node.frequencyValue = value; node.frequencyAt = at; } },
        connect(target) { this.target = target; }, disconnect() { this.disconnected = true; },
        start(at) { this.startAt = at; }, stop(at) { if (at !== undefined) { this.stopAt = at; if (autoEnd) queueMicrotask(() => this.onended?.()); } } };
      this.nodes.push(node); return node;
    }
    createGain() {
      const gain = { envelope: [], connect(target) { this.target = target; }, disconnect() { this.disconnected = true; } };
      gain.gain = Object.fromEntries(['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime']
        .map(method => [method, (value, at) => gain.envelope.push({ method, value, at })]));
      return gain;
    }
  }
  return { AudioContext, contexts };
}
