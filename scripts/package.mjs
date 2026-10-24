import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokeProduction } from './smoke.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)) {
  throw new Error('package.json must have a safe semantic version');
}
const name = `lingxi-workbench-${metadata.version}-${process.platform}-${process.arch}`;
const temporary = await mkdtemp(join(tmpdir(), 'lingxi-package-'));
const stage = join(temporary, name);
const output = join(root, 'artifacts');
const archive = join(output, `${name}.tar.gz`);
try {
  await mkdir(stage);
  for (const file of ['package.json', 'package-lock.json', 'start-runtime.mjs']) {
    await cp(join(root, file), join(stage, file));
  }
  for (const workspace of ['packages/protocol', 'apps/server', 'apps/web']) {
    await mkdir(join(stage, workspace), { recursive: true });
    await cp(join(root, workspace, 'package.json'), join(stage, workspace, 'package.json'));
    await cp(join(root, workspace, 'dist'), join(stage, workspace, 'dist'), { recursive: true });
  }
  await mkdir(join(stage, 'apps/desktop'), { recursive: true });
  await cp(join(root, 'apps/desktop/package.json'), join(stage, 'apps/desktop/package.json'));
  // Install on the target runner so SQLite's native binary matches the package architecture.
  const install = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: stage,
    stdio: 'inherit',
    env: process.env,
  });
  if (install.error) throw install.error;
  if (install.status !== 0) throw new Error(`Production install failed: ${install.status}`);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  await writeFile(
    join(stage, 'runtime-manifest.json'),
    `${JSON.stringify({ version: metadata.version, commit, platform: process.platform, arch: process.arch, nodeMajor: 24 }, null, 2)}\n`,
  );
  await cp(join(root, 'docs'), join(stage, 'docs'), { recursive: true });
  await writeFile(
    join(stage, 'README.md'),
    '# 丽塔同学工作台运行包\n\n需要 Node.js 24.x，在终端进入此目录执行 `./start.sh`。\n\n操作台：http://127.0.0.1:4310/ ，大屏：http://127.0.0.1:4310/display 。Ctrl+C 停止。\n\n连接向导：http://127.0.0.1:4310/setup 。先查看两项环境检查结果，再按需安装最新版 Codex CLI、登录或准备七牛语音账号与设备。安装按钮需要本机 npm 与网络；语音配置需在桌面应用中管理。\n\nMac 数据默认保存在 `~/Library/Application Support/Lingxi/lingxi.db`，可通过 `LINGXI_DB_PATH` 覆盖。\n\n此终端运行包提供建议保存与双端同步；真实 Codex 任务与共享作品控制请使用另附的桌面 ZIP。此独立浏览器入口不提供桌面语音能力。\n\n完整安装、配置、更新、备份与回退方法见 [部署文档](docs/deployment.md)，连接步骤见 [Mac 指南](docs/mac-setup.md)。构建来源见 `runtime-manifest.json`。\n',
  );
  await writeFile(
    join(stage, 'start.sh'),
    '#!/bin/sh\nset -eu\ncd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec node start-runtime.mjs\n',
  );
  await chmod(join(stage, 'start.sh'), 0o755);
  await mkdir(output, { recursive: true });
  execFileSync('tar', ['-czf', archive, '-C', temporary, name]);
  // Verify the actual archive, including workspace symlinks and native modules, after extraction.
  const extracted = join(temporary, 'extracted');
  await mkdir(extracted);
  execFileSync('tar', ['-xzf', archive, '-C', extracted]);
  await smokeProduction(join(extracted, name));
  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  ${name}.tar.gz\n`);
  console.log(`Verified runtime archive: ${archive}`);
} catch (error) {
  await rm(archive, { force: true });
  await rm(`${archive}.sha256`, { force: true });
  throw error;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
