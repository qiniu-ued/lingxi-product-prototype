import type { MessageTime, Task, VoiceTurn } from '@lingxi/protocol';

type TaskEntry = {
  kind: 'task';
  id: string;
  at: number;
  order: number;
  task: Task;
  part: 'prompt' | 'assistant' | 'addition' | 'footer';
  messageId?: string;
};
type VoiceEntry = {
  kind: 'voice';
  id: string;
  at: number;
  order: number;
  voice: VoiceTurn;
  messageIds: string[];
  outcome: boolean;
};

// Times mean first observed locally, not a reconstructed cloud event time.
// Legacy tasks have no per-message clock: retain their original message order
// at the known turn time rather than inventing a historical interleaving.
export function conversationTimeline(tasks: Task[], voices: VoiceTurn[], times: MessageTime[]) {
  const entries: Array<TaskEntry | VoiceEntry> = [];
  const recorded = new Map(
    times.map((entry) => [JSON.stringify([entry.taskId, entry.kind, entry.messageId]), entry]),
  );
  for (const task of tasks) {
    const taskEntries: TaskEntry[] = [];
    const own = (kind: MessageTime['kind'], id: string) =>
      recorded.get(JSON.stringify([task.id, kind, id]));
    let last = Date.parse(task.createdAt);
    const promptAt = voices.flatMap((voice) =>
      voice.handoff?.taskId === task.id
        ? voice.messages
            .filter(
              (message) => message.role === 'user' && message.text.trim() === task.prompt.trim(),
            )
            .map((message) => Date.parse(message.at))
        : [],
    );
    taskEntries.push({
      kind: 'task',
      task,
      part: 'prompt',
      id: `${task.id}:prompt`,
      at: Math.min(last, ...promptAt),
      order: -1,
    });
    for (const [index, message] of task.messages.entries()) {
      const time = own('assistant', message.id);
      const at = time ? Date.parse(time.at) : Date.parse(task.createdAt);
      last = Math.max(last, at);
      taskEntries.push({
        kind: 'task',
        task,
        part: 'assistant',
        messageId: message.id,
        id: `${task.id}:assistant:${message.id}`,
        at,
        order: time?.ordinal ?? index,
      });
    }
    for (const [index, addition] of (task.additions ?? []).entries()) {
      const time = own('addition', addition.id);
      const at = time ? Date.parse(time.at) : Date.parse(task.createdAt);
      last = Math.max(last, at);
      taskEntries.push({
        kind: 'task',
        task,
        part: 'addition',
        messageId: addition.id,
        id: `${task.id}:addition:${addition.id}`,
        at,
        order: time?.ordinal ?? task.messages.length + index,
      });
    }
    taskEntries.push({
      kind: 'task',
      task,
      part: 'footer',
      id: `${task.id}:footer`,
      at: last,
      order: Number.MAX_SAFE_INTEGER,
    });
    entries.push(...taskEntries.sort((a, b) => a.order - b.order));
  }
  for (const voice of voices) {
    const task = tasks.find((task) => task.id === voice.handoff?.taskId);
    const messages = voice.messages.filter(
      (message) => !(message.role === 'user' && task?.prompt.trim() === message.text.trim()),
    );
    for (const message of messages)
      entries.push({
        kind: 'voice',
        id: `voice:${voice.id}:${message.id}`,
        at: Date.parse(message.at),
        order: 0,
        voice,
        messageIds: [message.id],
        outcome: false,
      });
    entries.push({
      kind: 'voice',
      id: `voice:${voice.id}:outcome`,
      at: Math.max(
        Date.parse(voice.at),
        ...voice.messages.map((message) => Date.parse(message.at)),
        ...(task
          ? [
              Date.parse(
                ['completed', 'failed', 'interrupted'].includes(task.status)
                  ? task.updatedAt
                  : task.createdAt,
              ),
            ]
          : []),
      ),
      order: Number.MAX_SAFE_INTEGER,
      voice,
      messageIds: [],
      outcome: true,
    });
  }
  // Stable sort preserves the recorded per-task ordinal at equal timestamps.
  // Equal cross-source timestamps use deterministic input order, not a guessed
  // relative cloud arrival time.
  return entries.sort((a, b) => a.at - b.at);
}
