import { type VoiceDiagnosticEvent, voiceDiagnosticEventSchema } from '@lingxi/protocol';

type Entry = Omit<VoiceDiagnosticEvent, 'sequence' | 'at'>;

// Ephemeral metadata only: the strict schema has no content, credentials or audio fields.
export class VoiceDiagnostics {
  private enabled = true;
  private sequence = 0;
  private dropped = 0;
  private events: VoiceDiagnosticEvent[] = [];
  private prune() {
    const cutoff = Date.now() - 30 * 60_000;
    const before = this.events.length;
    this.events = this.events.filter((event) => Date.parse(event.at) >= cutoff);
    this.dropped += before - this.events.length;
  }
  record(input: Entry) {
    if (!this.enabled) return;
    const value = voiceDiagnosticEventSchema.safeParse({
      ...input,
      sequence: this.sequence + 1,
      at: new Date().toISOString(),
    });
    if (!value.success) return;
    this.sequence++;
    this.prune();
    this.events.push(value.data);
    if (this.events.length > 128) {
      this.events.shift();
      this.dropped++;
    }
  }
  read() {
    this.prune();
    return {
      enabled: this.enabled,
      capacity: 128 as const,
      retentionMinutes: 30 as const,
      dropped: this.dropped,
      events: this.events.map((event) => ({ ...event })),
    };
  }
  clear() {
    this.events = [];
    this.dropped = 0;
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }
  close() {
    this.setEnabled(false);
  }
}
