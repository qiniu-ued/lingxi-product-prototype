// Runs only in the canonical preview's isolated world. No preload or page handlers.
export function inspectElement(
  input: { target: 'point'; x: number; y: number } | { target: 'ref'; ref: string },
) {
  const state = Reflect.get(globalThis, '__lingxiTargets') ?? {
    next: 1,
    ids: new WeakMap(),
    nodes: new Map(),
  };
  Reflect.set(globalThis, '__lingxiTargets', state);
  const axisAligned = (frame: Element) => {
    for (let node: Element | null = frame; node; node = node.parentElement) {
      const transform = getComputedStyle(node).transform;
      if (transform !== 'none') {
        const matrix = new DOMMatrixReadOnly(transform);
        if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0)
          return false;
      }
    }
    return true;
  };
  let element: Element | null = null;
  if (input.target === 'ref') element = state.nodes.get(input.ref) ?? null;
  else {
    let doc = document,
      x = innerWidth * input.x,
      y = innerHeight * input.y;
    for (let depth = 0; depth < 8; depth++) {
      const candidate = doc.elementFromPoint(x, y);
      if (!candidate) break;
      element = candidate;
      if (candidate.tagName !== 'IFRAME') break;
      const frame = candidate as HTMLIFrameElement,
        rect = frame.getBoundingClientRect();
      try {
        if (
          !frame.contentDocument ||
          !frame.offsetWidth ||
          !frame.offsetHeight ||
          !axisAligned(frame)
        )
          break;
        x = (x - rect.x) / (rect.width / frame.offsetWidth) - frame.clientLeft;
        y = (y - rect.y) / (rect.height / frame.offsetHeight) - frame.clientTop;
        doc = frame.contentDocument;
      } catch {
        break;
      } // Cross-origin frames remain selectable as a whole.
    }
  }
  if (!element?.isConnected) return null;
  const original = element.getBoundingClientRect();
  let left = original.left,
    top = original.top,
    right = original.right,
    bottom = original.bottom;
  let win = element.ownerDocument.defaultView;
  for (let depth = 0; win && win !== window && depth < 8; depth++) {
    const frame = win.frameElement as HTMLIFrameElement | null;
    if (!frame || !axisAligned(frame)) return null;
    const rect = frame.getBoundingClientRect();
    const sx = rect.width / frame.offsetWidth,
      sy = rect.height / frame.offsetHeight;
    left = rect.left + (frame.clientLeft + Math.max(0, left)) * sx;
    right = rect.left + (frame.clientLeft + Math.min(frame.clientWidth, right)) * sx;
    top = rect.top + (frame.clientTop + Math.max(0, top)) * sy;
    bottom = rect.top + (frame.clientTop + Math.min(frame.clientHeight, bottom)) * sy;
    win = frame.ownerDocument.defaultView;
  }
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(innerWidth, right);
  bottom = Math.min(innerHeight, bottom);
  if (right <= left || bottom <= top) return null;
  for (const [ref, node] of state.nodes) if (!node.isConnected) state.nodes.delete(ref);
  let ref = state.ids.get(element);
  if (!ref) {
    ref = `r${state.next++}`;
    state.ids.set(element, ref);
  }
  if (state.nodes.size >= 1000 && !state.nodes.has(ref)) throw new Error('preview_target_limit');
  state.nodes.set(ref, element);
  const tag = element.tagName.toLowerCase() + (element.id ? `#${element.id.slice(0, 40)}` : '');
  return {
    ref,
    description: (
      element.getAttribute('aria-label') ||
      element.textContent ||
      element.tagName
    ).slice(0, 500),
    label: `${tag} · ${Math.round(original.width)} × ${Math.round(original.height)}`,
    bounds: {
      x: left / innerWidth,
      y: top / innerHeight,
      width: (right - left) / innerWidth,
      height: (bottom - top) / innerHeight,
    },
  };
}
