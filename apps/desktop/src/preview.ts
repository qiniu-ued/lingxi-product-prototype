import { randomUUID } from 'node:crypto';
import { readFile, realpath, rm } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import {
  type PreviewAction,
  type PreviewBinding,
  type PreviewWheel,
  type Project,
  previewActionSchema,
} from '@lingxi/protocol';
import { type BrowserWindow, session, WebContentsView } from 'electron';
import { freezePreview, inside, types } from './assets.js';

const targetScript = `(() => {
 const state = globalThis.__lingxiTargets ??= {next:1, ids:new WeakMap(), nodes:new Map()};
 for (const [ref,node] of state.nodes) if(!node.isConnected) state.nodes.delete(ref);
 const lines=[];
 for (const el of document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[contenteditable="true"]')) {
   if(lines.length>=250) break;
   const rect=el.getBoundingClientRect(); if(!rect.width || !rect.height) continue;
   let ref=state.ids.get(el); if(!ref){ref='r'+state.next++;state.ids.set(el,ref);state.nodes.set(ref,el);}state.nodes.set(ref,el);
   const name=el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || el.tagName;
   lines.push(ref+' '+el.tagName.toLowerCase()+' '+name.slice(0,180));
 }
 return (document.body?.innerText?.slice(0,28000) ?? '')+'\\n\\nElements:\\n'+lines.join('\\n');
})()`;

export class Preview {
  view: WebContentsView | undefined;
  binding: PreviewBinding | null = null;
  private root = '';
  private partition = '';
  private sequence = 0;
  private digest = '';
  private runtimeOrigin = '';
  private serviceOrigin = '';
  protectService(origin: string) {
    this.serviceOrigin = origin;
  }
  private queue: Promise<unknown> = Promise.resolve();
  private requests = new Map<string, { input: string; result: unknown }>();
  constructor(
    private window: BrowserWindow,
    private dataRoot: string,
    private changed: () => void,
  ) {}
  async publish(project: Project) {
    const next = this.queue.then(() => this.publishNow(project));
    this.queue = next.catch(() => {});
    return next;
  }
  private async publishNow(project: Project) {
    const frozen = await freezePreview(project, this.dataRoot);
    if (this.binding?.projectId === project.id && this.digest === frozen.digest) {
      await rm(frozen.root, { recursive: true, force: true });
      return this.binding;
    }
    const root = frozen.root;
    await this.ensureView(project);
    this.runtimeOrigin = '';
    this.root = root;
    this.digest = frozen.digest;
    this.binding = {
      id: this.binding?.id ?? randomUUID(),
      projectId: project.id,
      revision: ++this.sequence,
      epoch: (this.binding?.epoch ?? 0) + 1,
      url: `lingxi-preview://${project.id}/index.html`,
      title: project.name,
    };
    await this.view?.webContents.loadURL(this.binding.url);
    this.changed();
    return this.binding;
  }
  private async ensureView(project: Project) {
    if (this.binding?.projectId === project.id && this.view) return;
    this.dispose();
    this.partition = `persist:lingxi-preview-${project.id}`;
    const isolated = session.fromPartition(this.partition);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({
        cancel: !(
          (url.protocol === 'lingxi-preview:' && url.hostname === project.id) ||
          url.protocol === 'data:' ||
          this.runtimeAllowed(url)
        ),
      });
    });
    if (await isolated.protocol.isProtocolHandled('lingxi-preview'))
      isolated.protocol.unhandle('lingxi-preview');
    isolated.protocol.handle('lingxi-preview', async (request) => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== this.binding?.projectId || !this.root)
          return new Response('Unavailable', { status: 404 });
        const file = resolve(this.root, `.${decodeURIComponent(url.pathname)}`);
        if (
          !inside(this.root, file) ||
          url.pathname.split('/').some((p) => p.startsWith('.')) ||
          !types[extname(file)]
        )
          return new Response('Forbidden', { status: 403 });
        const actual = await realpath(file);
        if (!inside(this.root, actual)) return new Response('Forbidden', { status: 403 });
        return new Response(await readFile(actual), {
          headers: {
            'Content-Type': types[extname(file)] ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
            'Content-Security-Policy':
              "default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'",
          },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
    this.view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.window.contentView.addChildView(this.view);
    this.view.setBounds({ x: 24, y: 110, width: 800, height: 600 });
    this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.view.webContents.on('will-navigate', (event, url) => {
      if (!this.allowed(url)) event.preventDefault();
    });
    this.view.webContents.on('will-redirect', (event, url) => {
      if (!this.allowed(url)) event.preventDefault();
    });
    this.view.webContents.on('did-navigate', (_event, url) => {
      if (this.binding) {
        this.binding = { ...this.binding, url };
        this.changed();
      }
    });
    this.view.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame && this.binding) {
        this.binding = { ...this.binding, epoch: this.binding.epoch + 1 };
        this.requests.clear();
        this.changed();
      }
    });
  }
  connect(project: Project, raw: string) {
    const next = this.queue.then(async () => {
      const url = new URL(raw);
      if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !url.port ||
        url.username ||
        url.password ||
        url.origin === this.serviceOrigin ||
        url.port === new URL(this.serviceOrigin).port
      )
        throw new Error('invalid_project_url');
      await this.ensureView(project);
      this.runtimeOrigin = url.origin;
      this.digest = '';
      this.binding = {
        id: this.binding?.id ?? randomUUID(),
        projectId: project.id,
        revision: ++this.sequence,
        epoch: (this.binding?.epoch ?? 0) + 1,
        url: url.href,
        title: project.name,
      };
      await this.view?.webContents.loadURL(url.href);
      this.changed();
      return this.binding;
    });
    this.queue = next.catch(() => {});
    return next;
  }
  async pick(input: { binding: PreviewBinding; x: number; y: number }) {
    if (
      !this.view ||
      !this.binding ||
      JSON.stringify(input.binding) !== JSON.stringify(this.binding)
    )
      throw new Error('stale_preview');
    await this.snapshot();
    const selected = await this.view.webContents.executeJavaScriptInIsolatedWorld(1001, [
      {
        code: `(() => {const el=document.elementFromPoint(innerWidth*${input.x},innerHeight*${input.y});if(!el)throw new Error('no_element');const state=globalThis.__lingxiTargets;let ref=state.ids.get(el);if(!ref){ref='r'+state.next++;state.ids.set(el,ref);state.nodes.set(ref,el);}const box=el.getBoundingClientRect();state.highlight?.remove();const mark=document.createElement('div');mark.setAttribute('aria-hidden','true');Object.assign(mark.style,{position:'fixed',left:box.x+'px',top:box.y+'px',width:box.width+'px',height:box.height+'px',border:'3px solid #efb095',borderRadius:'4px',boxSizing:'border-box',pointerEvents:'none',zIndex:'2147483647'});document.documentElement.appendChild(mark);state.highlight=mark;setTimeout(()=>mark.remove(),3000);return {ref,description:(el.getAttribute('aria-label')||el.innerText||el.tagName).slice(0,500)};})()`,
      },
    ]);
    return { binding: { ...this.binding }, ...selected };
  }
  scroll(input: PreviewWheel) {
    const next = this.queue.then(() => {
      if (
        !this.view ||
        !this.binding ||
        JSON.stringify(input.binding) !== JSON.stringify(this.binding)
      )
        throw new Error('stale_preview');
      const { width, height } = this.view.getBounds();
      const point = {
        x: Math.min(width - 1, Math.floor(input.x * width)),
        y: Math.min(height - 1, Math.floor(input.y * height)),
      };
      // Native wheel input preserves nested overflow areas and browser scroll chaining.
      this.view.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      this.view.webContents.sendInputEvent({
        type: 'mouseWheel',
        ...point,
        deltaX: -input.deltaX,
        deltaY: -input.deltaY,
      });
    });
    this.queue = next.catch(() => {});
    return next;
  }
  private runtimeAllowed(url: URL) {
    if (!this.runtimeOrigin) return false;
    return (
      url.origin === this.runtimeOrigin ||
      (url.protocol === 'ws:' && `http://${url.host}` === this.runtimeOrigin)
    );
  }
  private allowed(url: string) {
    try {
      const value = new URL(url);
      return (
        (value.protocol === 'lingxi-preview:' &&
          value.hostname === this.binding?.projectId &&
          !this.runtimeOrigin) ||
        this.runtimeAllowed(value)
      );
    } catch {
      return false;
    }
  }
  async snapshot() {
    if (!this.view || !this.binding || this.view.webContents.isDestroyed())
      throw new Error('preview_missing');
    const binding = { ...this.binding };
    const text = await this.view.webContents.executeJavaScriptInIsolatedWorld(1001, [
      { code: targetScript },
    ]);
    const captured = await this.view.webContents.capturePage();
    const size = captured.getSize();
    const screenshot = size.width > 1280 ? captured.resize({ width: 1280 }) : captured;
    if (this.binding.epoch !== binding.epoch || this.binding.revision !== binding.revision)
      throw new Error('preview_changed');
    return {
      binding,
      text: String(text).slice(0, 40000),
      image: screenshot.toPNG().toString('base64'),
      width: size.width,
      height: size.height,
    };
  }
  perform(value: unknown) {
    const action = previewActionSchema.parse(value);
    const next = this.queue.then(() => this.execute(action));
    this.queue = next.catch(() => {});
    return next;
  }
  private async execute(action: PreviewAction) {
    if (action.action === 'snapshot') return this.snapshot();
    if (
      !this.binding ||
      !this.view ||
      JSON.stringify(this.binding) !== JSON.stringify(action.binding)
    )
      throw new Error('stale_preview');
    const input = JSON.stringify(action),
      prior = this.requests.get(action.requestId);
    if (prior) {
      if (prior.input !== input) throw new Error('request_conflict');
      return prior.result;
    }
    if (this.requests.size >= 1000) throw new Error('preview_action_limit');
    // Reserve before dispatch: a transport retry must never apply a click twice, even if capture fails.
    this.requests.set(action.requestId, { input, result: null });
    // Keep IDs until navigation/publish, even after evicting heavy screenshots.
    if (this.requests.size > 10) {
      const oldest = [...this.requests.values()].find((entry) => entry.result !== null);
      if (oldest) oldest.result = null;
    }
    const contents = this.view.webContents;
    if (action.action === 'scroll') {
      await contents.executeJavaScriptInIsolatedWorld(1001, [
        { code: `window.scrollBy(0,${action.deltaY})` },
      ]);
    } else {
      const code = `(() => {const el=globalThis.__lingxiTargets?.nodes.get(${JSON.stringify(action.ref)});if(!el?.isConnected)throw new Error('stale_ref');el.scrollIntoView({block:'center'});${action.action === 'click' ? 'el.click();' : "if(!el.matches('input,textarea,[contenteditable=\"true\"]'))throw new Error('not_editable');el.focus();"}return true;})()`;
      await contents.executeJavaScriptInIsolatedWorld(1001, [{ code }]);
      if (action.action === 'type') {
        contents.sendInputEvent({
          type: 'keyDown',
          keyCode: 'A',
          modifiers: [process.platform === 'darwin' ? 'meta' : 'control'],
        });
        contents.sendInputEvent({
          type: 'keyUp',
          keyCode: 'A',
          modifiers: [process.platform === 'darwin' ? 'meta' : 'control'],
        });
        await contents.insertText(action.text);
      }
    }
    const result = await this.snapshot();
    this.requests.set(action.requestId, { input, result });
    return result;
  }
  dispose() {
    if (this.view) {
      this.window.contentView.removeChildView(this.view);
      if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    }
    this.view = undefined;
    this.binding = null;
    this.root = '';
    this.runtimeOrigin = '';
    this.requests.clear();
  }
}
