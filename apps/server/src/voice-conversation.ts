import { randomUUID } from 'node:crypto';
import type { Task, VoiceState, VoiceTurn } from '@lingxi/protocol';

type Scope = Pick<VoiceTurn, 'projectId' | 'conversationId' | 'sessionId'>;

// Bounded session text for the actual chat UI. Never written to diagnostics or disk.
export class VoiceConversation {
  private turns: VoiceTurn[] = [];
  private revision = 0;
  private speech: { turnId: string; messageId: string; last: string } | null = null;
  private change() {
    this.revision++;
    while (
      this.turns.length > 24 ||
      this.turns.reduce(
        (sum, turn) => sum + turn.messages.reduce((n, message) => n + message.text.length, 0),
        0,
      ) > 64000
    )
      this.turns.shift();
  }
  private create(scope: Scope, captureId: string | null) {
    const turn: VoiceTurn = {
      ...scope,
      id: randomUUID(),
      captureId,
      at: new Date().toISOString(),
      messages: [],
      handoff: null,
      taskStatus: null,
    };
    this.turns.push(turn);
    this.change();
    return turn;
  }
  begin(scope: Scope, captureId: string) {
    this.interrupt();
    this.create(scope, captureId);
  }
  transcript(captureId: string, text: string, final: boolean) {
    const turn = this.turns.find((turn) => turn.captureId === captureId);
    if (!turn) return false;
    let message = turn.messages.find((message) => message.role === 'user');
    if (message?.state === 'final') return false;
    if (message && message.text === text && !final) return false;
    if (!message) {
      message = {
        id: randomUUID(),
        role: 'user',
        text: '',
        state: 'streaming',
        at: new Date().toISOString(),
      };
      if (turn.messages.length >= 8) turn.messages.shift();
      turn.messages.unshift(message);
    }
    message.text = text.slice(0, 4000);
    message.state = final ? 'final' : 'streaming';
    this.change();
    return true;
  }
  startSpeech(scope: Scope, captureId: string | null) {
    if (this.speech) return false;
    let turn = captureId
      ? this.turns.find(
          (turn) =>
            turn.captureId === captureId &&
            turn.projectId === scope.projectId &&
            turn.conversationId === scope.conversationId,
        )
      : undefined;
    if (!turn || turn.messages.length >= 8) turn = this.create(scope, null);
    const message = {
      id: randomUUID(),
      role: 'assistant' as const,
      text: '',
      state: 'streaming' as const,
      at: new Date().toISOString(),
    };
    turn.messages.push(message);
    this.speech = { turnId: turn.id, messageId: message.id, last: '' };
    this.change();
    return true;
  }
  speaking() {
    return this.speech !== null;
  }
  sentence(text: string) {
    if (!this.speech || !text || this.speech.last === text) return false;
    const turn = this.turns.find((turn) => turn.id === this.speech?.turnId),
      message = turn?.messages.find((message) => message.id === this.speech?.messageId);
    if (!message || message.state !== 'streaming') return false;
    this.speech.last = text;
    message.text = (message.text ? `${message.text}\n${text}` : text).slice(0, 8000);
    this.change();
    return true;
  }
  stopSpeech(interrupted = false) {
    if (!this.speech) return false;
    const turn = this.turns.find((turn) => turn.id === this.speech?.turnId),
      message = turn?.messages.find((message) => message.id === this.speech?.messageId);
    if (message) message.state = interrupted ? 'interrupted' : 'final';
    this.speech = null;
    this.change();
    return true;
  }
  handoff(value: NonNullable<VoiceState['handoff']>) {
    const turn = this.turns.find((turn) => turn.captureId === value.captureId);
    if (!turn || JSON.stringify(turn.handoff) === JSON.stringify(value)) return;
    turn.handoff = { ...value };
    this.change();
  }
  submitted(captureId: string, task: Task) {
    const turn = this.turns.find((turn) => turn.captureId === captureId);
    if (!turn || turn.projectId !== task.projectId) return;
    turn.conversationId = task.threadId ?? turn.conversationId;
    turn.taskStatus = task.status;
    this.change();
  }
  task(task: Task) {
    for (const turn of this.turns)
      if (turn.handoff?.taskId === task.id && turn.taskStatus !== task.status) {
        turn.taskStatus = task.status;
        this.change();
      }
  }
  interrupt() {
    this.stopSpeech(true);
    let changed = false;
    for (const turn of this.turns)
      for (const message of turn.messages)
        if (message.state === 'streaming') {
          message.state = 'interrupted';
          changed = true;
        }
    if (changed) this.change();
  }
  read() {
    return {
      revision: this.revision,
      turns: structuredClone(
        this.turns.filter((turn) => turn.messages.some((message) => message.text)),
      ),
    };
  }
  clear() {
    this.turns = [];
    this.speech = null;
    this.change();
  }
}
