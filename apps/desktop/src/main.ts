import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  desktopActionSchema,
  type Project,
  previewBindingSchema,
  projectSchema,
  voiceConfigSchema,
} from '@lingxi/protocol';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
} from 'electron';
import { z } from 'zod';
import { Preview } from './preview.js';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lingxi-preview',
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);
app.setName('Lingxi');
if (process.env.LINGXI_DESKTOP_DATA) app.setPath('userData', process.env.LINGXI_DESKTOP_DATA);
const dataRoot = app.getPath('userData');
let child: ChildProcess | undefined,
  operator: BrowserWindow | undefined,
  display: BrowserWindow | undefined,
  preview: Preview | undefined;
let address = '',
  quitting = false,
  stopped = false;
const official = new Set([
  'auth.openai.com',
  'chatgpt.com',
  'linx.qiniu.com',
  'xrobo.qiniu.com',
  'platform.openai.com',
  'developers.openai.com',
]);
const allowedExternal = (raw: string) => {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' && official.has(url.hostname) && !url.username && !url.password
    );
  } catch {
    return false;
  }
};
const external = (url: string) => {
  if (allowedExternal(url)) void shell.openExternal(url);
};
const trusted = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
  if (
    ![operator?.webContents, display?.webContents].includes(event.sender) ||
    event.senderFrame !== event.sender.mainFrame ||
    !event.senderFrame?.url.startsWith(`${address}/`)
  )
    throw new Error('untrusted_sender');
};
function windowOptions() {
  return {
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f3f0e9',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required' as const,
    },
  };
}
function protect(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${address}/`)) {
      event.preventDefault();
      external(url);
    }
  });
}
function openDisplay(activate = true) {
  let created = false;
  if (!display || display.isDestroyed()) {
    created = true;
    const target = screen
      .getAllDisplays()
      .find((value) => value.id !== screen.getPrimaryDisplay().id);
    display = new BrowserWindow({
      ...windowOptions(),
      show: false,
      ...(target ? { ...target.bounds, fullscreen: true } : { width: 1440, height: 900 }),
    });
    protect(display);
    preview = new Preview(display, dataRoot, () => {
      child?.send?.({ channel: 'desktop.preview', preview: preview?.binding ?? null });
    });
    preview.protectService(address);
    display.on('close', (event) => {
      if (!quitting) {
        event.preventDefault();
        display?.hide();
      }
    });
    void display.loadURL(`${address}/display`);
  }
  if (activate) display.show();
  else if (created) display.showInactive();
  return display;
}
async function api(operation: string, body: unknown) {
  const response = await fetch(`${address}/api/workbench/${operation}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: address },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('操作暂不可用，请先停止任务或检查预览入口。');
}
async function chooseProject(create: boolean): Promise<Project | null> {
  let path: string;
  if (create) {
    const result = await dialog.showSaveDialog(operator as BrowserWindow, {
      title: '创建共创项目文件夹',
      buttonLabel: '创建项目',
      defaultPath: join(app.getPath('documents'), 'Lingxi Project'),
    });
    if (result.canceled || !result.filePath) return null;
    path = result.filePath;
    await mkdir(path, { recursive: true });
  } else {
    const result = await dialog.showOpenDialog(operator as BrowserWindow, {
      title: '选择 Codex 可修改的项目文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    path = result.filePaths[0];
  }
  path = await realpath(path);
  let registry: Record<string, string> = {};
  const registryFile = join(dataRoot, 'projects.json');
  try {
    registry = z
      .record(z.string(), z.uuid())
      .parse(JSON.parse(await readFile(registryFile, 'utf8')));
  } catch {
    /* First launch. */
  }
  const id = registry[path] ?? randomUUID();
  registry[path] = id;
  await writeFile(registryFile, JSON.stringify(registry, null, 2), { mode: 0o600 });
  preview?.dispose();
  return { id, name: path.split(/[\\/]/).at(-1) ?? 'Project', path };
}
async function desktopCall(method: string, params: unknown) {
  if (method === 'microphone-status')
    return process.platform === 'darwin'
      ? systemPreferences.getMediaAccessStatus('microphone')
      : 'unknown';
  if (method === 'voice-identity') {
    const file = join(dataRoot, 'voice-device.json');
    try {
      return z
        .object({ deviceId: voiceConfigSchema.shape.deviceId, clientId: z.uuid() })
        .parse(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const mac = randomBytes(6);
    mac[0] = ((mac[0] ?? 0) | 2) & 254;
    const identity = {
      deviceId: [...mac].map((byte) => byte.toString(16).padStart(2, '0')).join(':'),
      clientId: randomUUID(),
    };
    await writeFile(file, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
    return identity;
  }
  if (method === 'voice-config-save') {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    )
      throw new Error('secure_storage_unavailable');
    const config = voiceConfigSchema.parse(params);
    const staging = join(dataRoot, `voice-config-${randomUUID()}.tmp`);
    await writeFile(staging, safeStorage.encryptString(JSON.stringify(config)), {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(staging, join(dataRoot, 'voice-config.enc'));
    return null;
  }
  if (method === 'voice-config-read') {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(join(dataRoot, 'voice-config.enc'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return voiceConfigSchema.parse(JSON.parse(safeStorage.decryptString(encrypted)));
  }
  if (method === 'voice-audio') {
    const value = z
      .object({
        reset: z.boolean().optional(),
        pcm: z.string().max(350000).optional(),
        sampleRate: z.literal(16000).optional(),
      })
      .parse(params);
    operator?.webContents.send('voice.audio', value);
    return null;
  }
  if (method === 'publish') {
    openDisplay(false);
    return preview?.publish(projectSchema.parse(params));
  }
  if (method === 'preview-connect') {
    const input = z
      .strictObject({ project: projectSchema, url: z.string().url().max(2000) })
      .parse(params);
    openDisplay(false);
    return preview?.connect(input.project, input.url);
  }
  if (method === 'preview') {
    if (!preview) throw new Error('preview_missing');
    return preview.perform(params);
  }
  if (method === 'action') {
    const input = desktopActionSchema.parse(params);
    if (input.action === 'new-project' || input.action === 'select-project')
      return chooseProject(input.action === 'new-project');
    if (input.action === 'open-display') {
      openDisplay();
      return null;
    }
    if (input.action === 'open-settings') {
      await operator?.loadURL(`${address}/setup`);
      operator?.show();
      return null;
    }
  }
  throw new Error('unsupported_desktop_operation');
}
async function startService() {
  const root = app.isPackaged
    ? join(process.resourcesPath, 'runtime')
    : resolve(__dirname, '../../..');
  const node = app.isPackaged ? join(root, 'bin', 'node') : process.env.LINGXI_NODE_BIN;
  if (!node) throw new Error('开发模式请使用 npm run desktop:dev 启动。');
  const token = randomBytes(32).toString('hex');
  const npmCli = app.isPackaged
    ? join(root, 'npm', 'bin', 'npm-cli.js')
    : process.env.LINGXI_NPM_CLI;
  child = spawn(node, [join(root, 'start-runtime.mjs')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      PORT: '0',
      LINGXI_DB_PATH: join(dataRoot, 'lingxi.db'),
      LINGXI_PREVIEW_MCP_TOKEN: token,
      ...(npmCli ? { LINGXI_NPM_CLI: npmCli } : {}),
      PATH: `${dirname(node)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    },
  });
  child.stdout?.resume();
  child.stderr?.resume();
  child.on('message', async (value) => {
    const parsed = z
      .object({
        channel: z.literal('desktop.request'),
        id: z.uuid(),
        method: z.string(),
        params: z.unknown(),
      })
      .safeParse(value);
    if (!parsed.success) return;
    try {
      const result = await desktopCall(parsed.data.method, parsed.data.params);
      if (child?.connected) child.send({ channel: 'desktop.reply', id: parsed.data.id, result });
    } catch {
      if (child?.connected)
        child.send({ channel: 'desktop.reply', id: parsed.data.id, error: 'operation_failed' });
    }
  });
  return new Promise<string>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('本机服务启动超时。')), 20000);
    child?.once('error', () => {
      clearTimeout(timer);
      reject(new Error('无法启动随应用提供的 Node 服务。'));
    });
    child?.on('message', (value) => {
      const parsed = z
        .object({ channel: z.literal('desktop.ready'), port: z.number().int().positive() })
        .safeParse(value);
      if (parsed.success) {
        clearTimeout(timer);
        accept(`http://127.0.0.1:${parsed.data.port}`);
      }
    });
    child?.once('exit', () => {
      clearTimeout(timer);
      if (!quitting) {
        reject(new Error('本机服务意外退出。'));
        dialog.showErrorBox('丽塔同学服务已停止', '请重新打开应用。已有文件和会话数据仍保留。');
        app.quit();
      }
    });
  });
}
async function shutdown() {
  preview?.dispose();
  const owned = child;
  if (!owned || owned.exitCode !== null || owned.signalCode !== null) return;
  await new Promise<void>((accept) => {
    const force = setTimeout(() => {
      owned.kill('SIGKILL');
    }, 6000);
    owned.once('exit', () => {
      clearTimeout(force);
      accept();
    });
    if (owned.connected) owned.send({ channel: 'desktop.shutdown' });
    else owned.kill('SIGTERM');
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    operator?.show();
    operator?.focus();
  });
  app.on('before-quit', (event) => {
    if (stopped) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void shutdown().finally(() => {
      stopped = true;
      app.quit();
    });
  });
  void app
    .whenReady()
    .then(async () => {
      await mkdir(dataRoot, { recursive: true });
      address = await startService();
      operator = new BrowserWindow(windowOptions());
      protect(operator);
      operator.on('closed', () => {
        operator = undefined;
        if (!quitting) app.quit();
      });
      ipcMain.handle('desktop.action', async (event, input) => {
        trusted(event);
        await api('action', desktopActionSchema.parse(input));
      });
      ipcMain.handle('desktop.snapshot', (event) => {
        trusted(event);
        return preview?.binding ? preview.snapshot() : null;
      });
      ipcMain.handle('desktop.pick', (event, input) => {
        trusted(event);
        if (event.sender !== operator?.webContents || !preview) throw new Error('preview_missing');
        return preview.pick(
          z
            .strictObject({
              binding: previewBindingSchema,
              x: z.number().min(0).max(1),
              y: z.number().min(0).max(1),
            })
            .parse(input),
        );
      });
      session.defaultSession.setPermissionRequestHandler(
        (contents, permission, callback, details) => {
          callback(
            contents === operator?.webContents &&
              contents.getURL().startsWith(`${address}/`) &&
              permission === 'media' &&
              'mediaTypes' in details &&
              details.mediaTypes.every((type) => type === 'audio'),
          );
        },
      );
      session.defaultSession.setPermissionCheckHandler(
        (contents, permission, requestingOrigin) =>
          contents === operator?.webContents &&
          permission === 'media' &&
          requestingOrigin === address,
      );
      ipcMain.handle('desktop.microphone', async (event) => {
        trusted(event);
        if (event.sender !== operator?.webContents) return false;
        return process.platform === 'darwin'
          ? systemPreferences.askForMediaAccess('microphone')
          : true;
      });
      ipcMain.handle('desktop.microphone-status', (event) => {
        trusted(event);
        return desktopCall('microphone-status', {});
      });
      ipcMain.handle('desktop.copy', (event, input) => {
        trusted(event);
        if (event.sender !== operator?.webContents) throw new Error('operator_required');
        clipboard.writeText(
          z
            .string()
            .max(1024 * 1024)
            .parse(input),
        );
      });
      ipcMain.on('voice.frame', (event, input) => {
        try {
          trusted(event);
        } catch {
          return;
        }
        if (
          event.sender !== operator?.webContents ||
          !(input instanceof ArrayBuffer) ||
          input.byteLength !== 640
        )
          return;
        child?.send?.({ channel: 'desktop.audio', pcm: Buffer.from(input).toString('base64') });
      });
      ipcMain.handle('desktop.info', (event) => {
        trusted(event);
        return {
          platform: process.platform,
          arch: process.arch,
          systemVersion: process.getSystemVersion(),
        };
      });
      ipcMain.on('desktop.bounds', (event, input) => {
        try {
          trusted(event);
        } catch {
          return;
        }
        if (event.sender !== display?.webContents) return;
        const bounds = z
          .object({
            x: z.number().int().nonnegative(),
            y: z.number().int().nonnegative(),
            width: z.number().int().min(1),
            height: z.number().int().min(1),
          })
          .safeParse(input);
        if (!bounds.success) return;
        const size = display.getContentBounds();
        if (
          bounds.data.x + bounds.data.width <= size.width + 1 &&
          bounds.data.y + bounds.data.height <= size.height + 1
        )
          preview?.view?.setBounds(bounds.data);
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: '丽塔同学',
            submenu: [
              { role: 'about' },
              {
                label: '连接向导',
                click: () => {
                  void operator?.loadURL(`${address}/setup`);
                },
              },
              { type: 'separator' },
              { role: 'quit', label: '退出丽塔同学（停止本机服务）' },
            ],
          },
          {
            label: '项目',
            submenu: [
              {
                label: '新建项目…',
                click: () => {
                  void api('action', { action: 'new-project' }).catch((error) =>
                    dialog.showErrorBox('无法创建项目', String(error)),
                  );
                },
              },
              {
                label: '打开项目…',
                click: () => {
                  void api('action', { action: 'select-project' }).catch((error) =>
                    dialog.showErrorBox('无法打开项目', String(error)),
                  );
                },
              },
              {
                label: '打开大屏',
                click: () => {
                  openDisplay();
                },
              },
            ],
          },
          { role: 'editMenu' },
          { role: 'viewMenu' },
        ]),
      );
      await operator.loadURL(address);
      openDisplay();
      operator.show();
      operator.focus();
      powerMonitor.on('suspend', () => child?.send?.({ channel: 'desktop.voice-stop' }));
      powerMonitor.on('resume', () => child?.send?.({ channel: 'desktop.voice-resume' }));
      const state = (await (await fetch(`${address}/api/workbench`)).json()) as {
        project: unknown;
      };
      if (state.project) {
        try {
          await desktopCall('publish', state.project);
        } catch {
          /* Existing project may have no preview yet. */
        }
      }
      app.on('activate', () => {
        operator?.show();
      });
    })
    .catch((error) => {
      dialog.showErrorBox('无法打开丽塔同学', String(error));
      app.quit();
    });
}
