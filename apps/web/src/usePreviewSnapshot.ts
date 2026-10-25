import { type PreviewSnapshot, previewSnapshotSchema } from '@lingxi/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

// A timeout reports failure without releasing the single-flight guard: interval
// retries must not accumulate native captures that never return. Manual retry is
// a new logical attempt; all late results from the old attempt are ignored.
export function usePreviewSnapshot(bindingKey: string, picking: boolean) {
  const currentBinding = useRef(bindingKey);
  currentBinding.current = bindingKey;
  const [attempt, setAttempt] = useState(0);
  const [image, setImage] = useState<{ key: string; value: PreviewSnapshot } | null>(null);
  const [failure, setFailure] = useState<{ key: string; attempt: number } | null>(null);
  const accept = useCallback((snapshot: PreviewSnapshot) => {
    const key = JSON.stringify(snapshot.binding);
    if (key !== currentBinding.current) return;
    setImage({ key, value: snapshot });
    setFailure(null);
  }, []);
  useEffect(() => {
    if (!bindingKey) return;
    let active = true;
    let pending = false;
    let failures = 0;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      if (active) setFailure({ key: bindingKey, attempt });
    };
    const update = async () => {
      if (pending || !active) return;
      pending = true;
      deadline = setTimeout(fail, 5000);
      try {
        const value = await window.lingxiDesktop?.snapshot();
        if (!value) throw new Error('preview_unavailable');
        const snapshot = previewSnapshotSchema.parse(value);
        if (JSON.stringify(snapshot.binding) !== bindingKey) throw new Error('stale_preview');
        if (active) {
          setImage({ key: bindingKey, value: snapshot });
          setFailure(null);
          failures = 0;
        }
      } catch (error) {
        // A newer pointer action can invalidate an in-flight image normally.
        // Fetch the next image without reporting a native capture fault.
        if (!(error instanceof Error && /\bpreview_changed\b/.test(error.message))) {
          failures++;
          fail();
        }
      } finally {
        pending = false;
        clearTimeout(deadline);
        // Three consecutive failures stop automatic polling. A good capture
        // restores the normal cadence; user retry starts a fresh bounded run.
        if (active && failures < 3)
          timer = setTimeout(
            () => void update(),
            failures ? 1200 * 2 ** (failures - 1) : picking ? 200 : 1200,
          );
      }
    };
    void update();
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(deadline);
    };
  }, [bindingKey, picking, attempt]);
  return {
    accept,
    shot: image?.key === bindingKey ? image.value : null,
    error: failure?.key === bindingKey ? '暂时无法同步大屏作品。请打开大屏后重试。' : '',
    retrying: failure?.key === bindingKey && failure.attempt !== attempt,
    retry: () => setAttempt((value) => value + 1),
  };
}
