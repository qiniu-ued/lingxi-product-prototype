import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  type PreviewAction,
  type PreviewBinding,
  type Project,
  previewActionSchema,
} from '@lingxi/protocol';
import { type BrowserWindow, session, WebContentsView } from 'electron';

const types: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};
const inside = (root: string, path: string) => {
  const r = relative(root, path);
  return !r.startsWith('..') && !isAbsolute(r);
};

// Capture only public frontend assets, never the project root, credentials or node_modules.
export async function freezePreview(project: Project, dataRoot: string) {
  const source = await realpath(join(project.path, 'preview'));
  if (!inside(await realpath(project.path), source)) throw new Error('preview_outside_project');
  const output = join(dataRoot, 'artifacts', project.id, randomUUID());
  const digest = createHash('sha256');
  let bytes = 0,
    count = 0;
  const visit = async (directory: string) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('symlink_in_preview');
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile() || !types[extname(entry.name).toLowerCase()]) continue;
      const actual = await realpath(path);
      if (!inside(source, actual)) throw new Error('asset_outside_preview');
      const info = await stat(actual);
      bytes += info.size;
      count++;
      if (bytes > 30_000_000 || count > 500) throw new Error('preview_too_large');
      const target = join(output, relative(source, path));
      digest.update(relative(source, path));
      digest.update(await readFile(actual));
      await mkdir(resolve(target, '..'), { recursive: true });
      await cp(actual, target, { dereference: false });
    }
  };
  await visit(source);
  await stat(join(output, 'index.html'));
  return { root: output, digest: digest.digest('hex') };
}

const targetScript = `(() => {
 const state = globalThis.__lingxiTargets ??= {next:1, ids:new WeakMap(), nodes:new Map()};
 const lines=[];
 for (const el of document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[contenteditable="true"]')) {
   if(lines.length>=250) break;
   const rect=el.getBoundingClientRect(); if(!rect.width || !rect.height) continue;
   let ref=state.ids.get(el); if(!ref){ref='r'+state.next++;state.ids.set(el,ref);state.nodes.set(ref,el);}
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
    if (this.binding?.projectId !== project.id) {
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
            url.protocol === 'data:'
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
      this.view.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame && this.binding) {
          this.binding = { ...this.binding, epoch: this.binding.epoch + 1 };
          this.requests.clear();
          this.changed();
        }
      });
    }
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
        code: `(() => {const el=document.elementFromPoint(innerWidth*${input.x},innerHeight*${input.y});if(!el)throw new Error('no_element');const state=globalThis.__lingxiTargets;let ref=state.ids.get(el);if(!ref){ref='r'+state.next++;state.ids.set(el,ref);state.nodes.set(ref,el);}return {ref,description:(el.getAttribute('aria-label')||el.innerText||el.tagName).slice(0,500)};})()`,
      },
    ]);
    return { binding: { ...this.binding }, ...selected };
  }
  private allowed(url: string) {
    try {
      const value = new URL(url);
      return value.protocol === 'lingxi-preview:' && value.hostname === this.binding?.projectId;
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
    // Reserve before dispatch: a transport retry must never apply a click twice, even if capture fails.
    this.requests.set(action.requestId, { input, result: null });
    if (this.requests.size > 100) this.requests.delete(this.requests.keys().next().value as string);
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
        contents.insertText(action.text);
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
    this.requests.clear();
  }
}
