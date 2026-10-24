import { type VoiceDebugEvent, voiceDebugEventSchema } from '@lingxi/protocol';

const hidden = '[REDACTED]';
const limited = '[TRUNCATED]';
const sensitiveKey =
  /authorization|cookie|password|passwd|passphrase|secret|credential|token|key|pwd|deviceid|clientid|sessionid|macaddress|signature/;
type Input = Omit<VoiceDebugEvent, 'sequence' | 'at' | 'payload' | 'truncated'> & {
  payload: unknown;
};

// Never a packet dump: credentials are removed before any length truncation.
export function redactVoicePayload(input: unknown, secrets: readonly string[]) {
  let truncated = false,
    nodes = 0;
  const seen = new WeakSet<object>();
  const redactText = (input: string) => {
    if (input.length > 262144) {
      truncated = true;
      return limited;
    }
    let text = input;
    for (const secret of secrets) {
      if (!secret) continue;
      const variants = new Set([secret]);
      try {
        variants.add(encodeURIComponent(secret));
      } catch {
        /* Invalid Unicode is still removed literally. */
      }
      for (const variant of variants) text = text.split(variant).join(hidden);
    }
    return text
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
        hidden,
      )
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, hidden)
      .replace(/\b(?:authorization|set-cookie|cookie)\s*[:=][^\r\n]*/gi, hidden)
      .replace(
        /(["']?(?:password|passwd|passphrase|pwd|api[_-]?key|access[_-]?key|(?:access[_-]?|refresh[_-]?)?token|secret|credential|device[_-]?id|client[_-]?id|session[_-]?id|密码|令牌|密钥)["']?\s*(?:[:=：]|\bis\b|是)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]]+)/gi,
        `$1${hidden}`,
      )
      .replace(/((?:https?|wss?):\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${hidden}@`)
      .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, hidden)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, hidden)
      .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, hidden);
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 1000 || depth > 8) {
      truncated = true;
      return limited;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      let text: string | undefined;
      if (trimmed.length <= 262144 && /^[[{]/.test(trimmed)) {
        try {
          // Preserve string-valued protocol fields even when they contain JSON.
          text = JSON.stringify(visit(JSON.parse(trimmed), depth + 1));
        } catch {
          /* Plain text. */
        }
      }
      text ??= redactText(value);
      if (text.length > 4096) {
        truncated = true;
        return `${text.slice(0, 4080)}${limited}`;
      }
      return text;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value !== 'object') return '[UNAVAILABLE]';
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[BINARY OMITTED]';
    if (seen.has(value)) {
      truncated = true;
      return '[CIRCULAR]';
    }
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 40) truncated = true;
      return [
        ...value.slice(0, 40).map((item) => visit(item, depth + 1)),
        ...(value.length > 40 ? [limited] : []),
      ];
    }
    const entries = Object.entries(value);
    if (entries.length > 40) truncated = true;
    return Object.fromEntries([
      ...entries
        .slice(0, 40)
        .map(([key, item]) => [
          redactText(key).slice(0, 80),
          sensitiveKey.test(key.toLowerCase().replace(/[^a-z0-9]/g, '')) ||
          ['密码', '令牌', '密钥'].includes(key)
            ? hidden
            : visit(item, depth + 1),
        ]),
      ...(entries.length > 40 ? [['_truncated', true]] : []),
    ]);
  };
  let payload = JSON.stringify(visit(input, 0), null, 2);
  if (payload.length > 8192) {
    truncated = true;
    payload = `${payload.slice(0, 8170)}\n${limited}`;
  }
  return { payload, truncated };
}

export class VoiceDebug {
  private enabled = false;
  private events: VoiceDebugEvent[] = [];
  private dropped = 0;
  private sequence = 0;
  constructor(private secrets: () => readonly string[]) {}
  private prune() {
    const before = this.events.length,
      cutoff = Date.now() - 10 * 60_000;
    this.events = this.events.filter((event) => Date.parse(event.at) >= cutoff);
    this.dropped += before - this.events.length;
  }
  record(input: Input) {
    if (!this.enabled) return;
    const result = voiceDebugEventSchema.safeParse({
      ...input,
      ...redactVoicePayload(input.payload, this.secrets()),
      sequence: this.sequence + 1,
      at: new Date().toISOString(),
    });
    if (!result.success) return;
    this.sequence++;
    this.prune();
    this.events.push(result.data);
    if (this.events.length > 64) {
      this.events.shift();
      this.dropped++;
    }
  }
  read() {
    this.prune();
    return {
      enabled: this.enabled,
      capacity: 64 as const,
      retentionMinutes: 10 as const,
      maxPayloadCharacters: 8192 as const,
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
