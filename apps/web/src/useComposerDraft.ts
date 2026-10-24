import type { ContextAttachment, PreviewSelection, WorkbenchState } from '@lingxi/protocol';
import { type SetStateAction, useCallback, useEffect, useState } from 'react';

type Draft = {
  text: string;
  annotation: string;
  attachments: ContextAttachment[];
  selection: PreviewSelection | null;
  voiceDraft: { text: string; id: string } | null;
};
const empty: Draft = {
  text: '',
  annotation: '',
  attachments: [],
  selection: null,
  voiceDraft: null,
};
export const composerTarget = (state: WorkbenchState | null) =>
  `${state?.project?.id ?? 'none'}:${state?.selectedThreadId ?? 'new'}`;

// Drafts stay local and separate from durable executed history. Async actions
// keep their original target instead of writing into a newly selected thread.
export function useComposerDraft(target: string) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  useEffect(() => {
    if (target === 'none:new') return;
    setDrafts((old) => {
      if (!old['none:new']) return old;
      const { 'none:new': initial, ...rest } = old;
      return { ...rest, [target]: old[target] ?? initial };
    });
  }, [target]);
  const patch = useCallback((key: string, change: (draft: Draft) => Partial<Draft>) => {
    setDrafts((old) => {
      const draft = old[key] ?? empty;
      return { ...old, [key]: { ...draft, ...change(draft) } };
    });
  }, []);
  const set = useCallback(
    <K extends keyof Draft>(key: K, value: SetStateAction<Draft[K]>) => {
      patch(target, (draft) => ({
        [key]:
          typeof value === 'function'
            ? (value as (previous: Draft[K]) => Draft[K])(draft[key])
            : value,
      }));
    },
    [patch, target],
  );
  return {
    ...(drafts[target] ?? empty),
    patch,
    setText: useCallback((value: SetStateAction<string>) => set('text', value), [set]),
    setAnnotation: useCallback((value: SetStateAction<string>) => set('annotation', value), [set]),
    setAttachments: useCallback(
      (value: SetStateAction<ContextAttachment[]>) => set('attachments', value),
      [set],
    ),
    setSelection: useCallback(
      (value: SetStateAction<PreviewSelection | null>) => set('selection', value),
      [set],
    ),
    setVoiceDraft: useCallback(
      (value: SetStateAction<Draft['voiceDraft']>) => set('voiceDraft', value),
      [set],
    ),
  };
}
