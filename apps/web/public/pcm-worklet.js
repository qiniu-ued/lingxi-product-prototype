class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new ArrayBuffer(640);
    this.view = new DataView(this.frame);
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      const normalized = Math.max(-1, Math.min(1, sample));
      this.view.setInt16(
        this.offset * 2,
        Math.round(normalized * (normalized < 0 ? 32768 : 32767)),
        true,
      );
      this.offset++;
      if (this.offset === 320) {
        this.port.postMessage(this.frame, [this.frame]);
        this.frame = new ArrayBuffer(640);
        this.view = new DataView(this.frame);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('lingxi-pcm-capture', PcmCapture);
