// Subprocess installer/OAuth peers for tests. No downloads or real account authorization.
import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [kind, mode, record, ...args] = process.argv.slice(2);
const log = (value) => appendFileSync(record, `${JSON.stringify(value)}\n`);
log({ kind, args, pid: process.pid });
if (kind === 'npm') {
  if (mode === 'fail') {
    console.error('private installer data');
    process.exit(1);
  }
  if (mode === 'hang') setInterval(() => {}, 1000);
  else {
    const stage = args[args.indexOf('--prefix') + 1];
    const bin = join(stage, 'node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    const executable = join(bin, 'codex');
    writeFileSync(
      executable,
      `#!${process.execPath}\nprocess.argv = [process.execPath, ${JSON.stringify(import.meta.filename)}, 'cli', ${JSON.stringify(mode)}, ${JSON.stringify(record)}, ...process.argv.slice(2)];\nawait import(${JSON.stringify(import.meta.url)});\n`,
    );
    chmodSync(executable, 0o755);
  }
} else if (args[0] === '--version') console.log('codex-cli 0.999.0');
else if (args[0] === 'app-server') {
  if (mode === 'bad-protocol') console.log('broken protocol');
  const input = createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const message = JSON.parse(line);
    log(message);
    if (message.method === 'initialize') console.log(JSON.stringify({ id: 0, result: {} }));
    if (message.method === 'account/read')
      console.log(
        JSON.stringify({
          id: message.id,
          result: {
            account: existsSync(`${record}.authorized`)
              ? { type: 'chatgpt', email: 'private@account' }
              : null,
            requiresOpenaiAuth: true,
          },
        }),
      );
    if (message.method === 'account/login/start') {
      console.log(
        JSON.stringify({
          id: 1,
          result: {
            type: 'chatgpt',
            loginId: 'fixture-id',
            authUrl:
              mode === 'unsafe-url'
                ? 'https://attacker.example/login'
                : 'https://auth.openai.com/authorize?fixture=1',
          },
        }),
      );
      if (!['hang', 'unsafe-url'].includes(mode))
        setTimeout(() => {
          if (mode !== 'login-fail' && mode !== 'unverified')
            writeFileSync(`${record}.authorized`, 'fixture only');
          console.log(
            JSON.stringify({
              method: 'account/login/completed',
              params: { loginId: 'other-id', success: false },
            }),
          );
          console.log(
            JSON.stringify({
              method: 'account/login/completed',
              params: { loginId: 'fixture-id', success: mode !== 'login-fail' },
            }),
          );
        }, 100);
    }
  });
}
