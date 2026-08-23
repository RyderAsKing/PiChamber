export const DICTATION_AUDIO_WORKLET_SOURCE = `
class PiChamberDictationProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.outputRate = 16000;
    this.step = sampleRate / this.outputRate;
    this.position = 0;
    this.source = [];
    this.pending = [];
    this.chunkSamples = 4000;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'flush') {
        if (this.pending.length > 0) {
          const samples = Int16Array.from(this.pending.splice(0));
          this.port.postMessage({ type: 'chunk', buffer: samples.buffer }, [samples.buffer]);
        }
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;
    let sum = 0;
    for (let i = 0; i < input.length; i += 1) { this.source.push(input[i]); sum += input[i] * input[i]; }
    this.port.postMessage({ type: 'level', value: Math.min(1, Math.sqrt(sum / input.length) * 3) });
    while (this.position + 1 < this.source.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const sample = this.source[index] + (this.source[index + 1] - this.source[index]) * fraction;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.pending.push(clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767));
      this.position += this.step;
    }
    const consumed = Math.floor(this.position);
    if (consumed > 0) { this.source.splice(0, consumed); this.position -= consumed; }
    while (this.pending.length >= this.chunkSamples) {
      const samples = Int16Array.from(this.pending.splice(0, this.chunkSamples));
      this.port.postMessage({ type: 'chunk', buffer: samples.buffer }, [samples.buffer]);
    }
    return true;
  }
}
registerProcessor('pichamber-dictation', PiChamberDictationProcessor);
`;
