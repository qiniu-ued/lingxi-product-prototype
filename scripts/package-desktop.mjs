import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const scratch = await mkdtemp(join(tmpdir(), 'lingxi-desktop-'));
try {
  execFileSync(process.execPath, [join(root, 'scripts/package.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  const runtime = join(scratch, 'runtime');
  await mkdir(runtime);
  const name = `lingxi-workbench-${metadata.version}-${process.platform}-${process.arch}`;
  execFileSync('tar', [
    '-xzf',
    join(root, 'artifacts', `${name}.tar.gz`),
    '-C',
    runtime,
    '--strip-components=1',
  ]);
  await mkdir(join(runtime, 'bin'));
  await cp(process.execPath, join(runtime, 'bin', 'node'));
  await chmod(join(runtime, 'bin', 'node'), 0o755);
  // npm is used only by the explicit managed Codex install action, never as a shell bridge.
  if (!process.env.npm_execpath) throw new Error('Run packaging through npm run desktop:pack');
  await cp(dirname(dirname(process.env.npm_execpath)), join(runtime, 'npm'), { recursive: true });
  const bundledNode = join(runtime, 'bin', 'node');
  const npmVersion = execFileSync(
    bundledNode,
    [join(runtime, 'npm', 'bin', 'npm-cli.js'), '--version'],
    { encoding: 'utf8' },
  ).trim();
  if (!npmVersion.startsWith('11.')) throw new Error('Desktop bundle requires npm 11');
  const input = join(scratch, 'app');
  await mkdir(input);
  await cp(join(root, 'apps/desktop/dist'), input, { recursive: true });
  await writeFile(
    join(input, 'package.json'),
    JSON.stringify({ name: 'lingxi', version: metadata.version, main: 'main.cjs' }),
  );
  const packages = await packager({
    dir: input,
    out: join(scratch, 'output'),
    name: 'Lingxi',
    executableName: 'Lingxi',
    appBundleId: 'com.qiniu.lingxi.workbench',
    appCategoryType: 'public.app-category.developer-tools',
    platform: process.platform,
    arch: process.arch,
    electronVersion: require('electron/package.json').version,
    extraResource: [runtime],
    overwrite: true,
    extendInfo: {
      NSMicrophoneUsageDescription: '主动收音时将语音发送给七牛灵矽，用于转写和语音控制 Codex。',
    },
    asar: false,
    ...(process.env.electron_config_cache
      ? { download: { cacheRoot: process.env.electron_config_cache } }
      : {}),
  });
  const output = join(
    root,
    'artifacts',
    `Lingxi-${metadata.version}-${process.platform}-${process.arch}.zip`,
  );
  if (process.platform !== 'darwin')
    throw new Error(
      'Desktop distribution currently targets macOS; use desktop:dev for Linux development.',
    );
  execFileSync('ditto', [
    '-c',
    '-k',
    '--sequesterRsrc',
    '--keepParent',
    join(packages[0], 'Lingxi.app'),
    output,
  ]);
  const extracted = join(scratch, 'extracted');
  await mkdir(extracted);
  execFileSync('ditto', ['-x', '-k', output, extracted]);
  try {
    execFileSync(process.execPath, [join(root, 'scripts/test-desktop.mjs')], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, LINGXI_DESKTOP_BUNDLE: join(extracted, 'Lingxi.app') },
    });
  } catch (error) {
    await rm(output, { force: true });
    await rm(`${output}.sha256`, { force: true });
    throw error;
  }
  const digest = createHash('sha256')
    .update(await readFile(output))
    .digest('hex');
  await writeFile(`${output}.sha256`, `${digest}  ${output.split('/').at(-1)}\n`);
  console.log(`Unsigned desktop app: ${output}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
