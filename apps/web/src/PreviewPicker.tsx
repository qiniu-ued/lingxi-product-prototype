import {
  type PreviewHighlight,
  type PreviewSelection,
  type PreviewSnapshot,
  previewHighlightSchema,
} from '@lingxi/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

export function PreviewPicker({
  shot,
  active,
  selection,
  onPick,
  onCancel,
  onError,
}: {
  shot: PreviewSnapshot;
  active: boolean;
  selection: PreviewSelection | null;
  onPick: (value: PreviewSelection) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLButtonElement>(null),
    image = useRef<HTMLImageElement>(null);
  const [highlight, setHighlight] = useState<PreviewHighlight | null>(null);
  const [surface, setSurface] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const point = useRef<{ x: number; y: number } | null>(null),
    generation = useRef(0),
    inspecting = useRef(false),
    locking = useRef(false);
  const wheel = useRef(0),
    scrolling = useRef(false);
  const callbacks = useRef({ onPick, onCancel, onError });
  callbacks.current = { onPick, onCancel, onError };
  const binding = useRef(shot.binding).current;
  const key = JSON.stringify(binding);
  const measure = useCallback(() => {
    const img = image.current,
      button = host.current;
    if (!img || !button || !img.naturalWidth) return null;
    const box = img.getBoundingClientRect(),
      parent = button.getBoundingClientRect();
    const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
    const width = img.naturalWidth * scale,
      height = img.naturalHeight * scale;
    const value = {
      x: box.x - parent.x + (box.width - width) / 2,
      y: box.y - parent.y + (box.height - height) / 2,
      width,
      height,
    };
    setSurface((previous) =>
      JSON.stringify(previous) === JSON.stringify(value) ? previous : value,
    );
    return { left: parent.x + value.x, top: parent.y + value.y, width, height };
  }, []);
  const at = (x: number, y: number) => {
    const rect = measure();
    if (!rect?.width || !rect.height) return null;
    const value = { x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height };
    return value.x >= 0 && value.y >= 0 && value.x <= 1 && value.y <= 1 ? value : null;
  };
  useEffect(() => {
    const observer = new ResizeObserver(() => measure());
    if (host.current) observer.observe(host.current);
    measure();
    return () => observer.disconnect();
  }, [measure]);
  useEffect(() => {
    const epoch = ++generation.current;
    point.current = null;
    wheel.current = 0;
    if (!active && (!selection || JSON.stringify(selection.binding) !== key)) {
      setHighlight(null);
      return;
    }
    let live = true;
    const refresh = async () => {
      if (inspecting.current || locking.current || !live) return;
      const position = point.current;
      if (active && !position) return;
      const api = window.lingxiDesktop;
      if (!api?.inspect) {
        callbacks.current.onError('请更新桌面应用以使用悬浮批注。');
        return;
      }
      inspecting.current = true;
      try {
        const result = await api.inspect(
          active && position
            ? { binding, target: 'point', ...position }
            : { binding, target: 'ref', ref: selection?.ref ?? '' },
        );
        if (live && epoch === generation.current && (!active || position === point.current))
          setHighlight(result ? previewHighlightSchema.parse(result) : null);
      } catch {
        if (live && epoch === generation.current) {
          setHighlight(null);
          callbacks.current.onError('预览已变化，请重新选择批注目标。');
        }
      } finally {
        inspecting.current = false;
      }
    };
    const tick = () => {
      if (active && wheel.current && !scrolling.current) {
        const deltaY = Math.max(-800, Math.min(800, wheel.current));
        wheel.current -= deltaY;
        scrolling.current = true;
        void window.lingxiDesktop
          ?.scrollPreview({ binding, deltaY })
          .catch(() => {
            if (live) callbacks.current.onError('预览滚动失败，请检查页面后重试。');
          })
          .finally(() => {
            scrolling.current = false;
          });
      }
      void refresh();
    };
    void refresh();
    const timer = setInterval(tick, 80);
    const cancelKey = (event: KeyboardEvent) => {
      if (active && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        generation.current++;
        setHighlight(null);
        callbacks.current.onCancel();
      }
    };
    const scroll = (event: WheelEvent) => {
      if (!active) return;
      event.preventDefault();
      event.stopPropagation();
      wheel.current = Math.max(-1600, Math.min(1600, wheel.current + event.deltaY));
    };
    document.addEventListener('keydown', cancelKey, true);
    const element = host.current;
    element?.addEventListener('wheel', scroll, { passive: false });
    return () => {
      live = false;
      generation.current++;
      clearInterval(timer);
      document.removeEventListener('keydown', cancelKey, true);
      element?.removeEventListener('wheel', scroll);
    };
  }, [active, key, selection, binding]);
  return (
    <button
      ref={host}
      type="button"
      className={`preview-pick ${active ? 'picking' : ''}`}
      aria-label="选择预览元素"
      disabled={!active}
      onPointerMove={(event) => {
        if (!active) return;
        point.current = at(event.clientX, event.clientY);
        if (!point.current) setHighlight(null);
      }}
      onPointerLeave={() => {
        point.current = null;
        if (active) setHighlight(null);
      }}
      onPointerDown={(event) => {
        if (active) event.preventDefault();
      }}
      onClick={async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const position = at(event.clientX, event.clientY);
        if (!active || !position || locking.current) return;
        const epoch = ++generation.current;
        locking.current = true;
        try {
          const result = await window.lingxiDesktop?.inspect({
            binding,
            target: 'point',
            ...position,
          });
          if (epoch !== generation.current) return;
          if (!result) throw new Error('no_element');
          const value = previewHighlightSchema.parse(result);
          setHighlight(value);
          callbacks.current.onPick({
            binding: value.binding,
            ref: value.ref,
            description: value.description,
          });
        } catch {
          if (epoch === generation.current) {
            callbacks.current.onError('预览已变化，请重新选择批注目标。');
            callbacks.current.onCancel();
          }
        } finally {
          locking.current = false;
        }
      }}
    >
      <img
        ref={image}
        onLoad={measure}
        alt="大屏中同一个作品页面的实时画面"
        src={`data:image/png;base64,${shot.image}`}
        draggable={false}
      />
      {highlight && (
        <span
          className={`preview-element-outline ${active ? '' : 'locked'}`}
          data-testid="preview-element-outline"
          aria-hidden="true"
          style={{
            left: surface.x + highlight.bounds.x * surface.width,
            top: surface.y + highlight.bounds.y * surface.height,
            width: highlight.bounds.width * surface.width,
            height: highlight.bounds.height * surface.height,
          }}
        >
          <span className="preview-element-label">{highlight.label}</span>
        </span>
      )}
    </button>
  );
}
