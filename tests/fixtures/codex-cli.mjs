// A protocol peer for diagnostics tests; it never contacts a provider or edits a project.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [mode, record, action] = process.argv.slice(2);
if (action === '--version') {
  if (mode === 'version-hang') setInterval(() => {}, 1000);
  else if (mode === 'version-error') process.exit(1);
  else console.log(mode === 'invalid-version' ? 'some other program' : 'codex-cli 0.164.0');
} else if (action === 'app-server') {
  appendFileSync(record, `${JSON.stringify({ pid: process.pid })}\n`);
  if (mode === 'force-kill') process.on('SIGTERM', () => {});
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    appendFileSync(record, `${line}\n`);
    if (message.method === 'initialize') {
      if (mode === 'hang' || mode === 'force-kill') return;
      if (mode === 'exit') process.exit(1);
      if (mode === 'bad-json') {
        console.log('not JSON');
        return;
      }
      if (mode === 'oversized') {
        console.log('x'.repeat(70 * 1024));
        return;
      }
      if (mode === 'rpc-error') {
        console.log(JSON.stringify({ id: 0, error: { message: 'private provider error' } }));
        return;
      }
      // Fragmented responses and interleaved notifications must not change request ordering.
      process.stdout.write('{"method":"account/updated","params":{}}\n{"id":0,');
      setTimeout(() => process.stdout.write('"result":{}}\n'), 5);
    } else if (message.method === 'account/read') {
      const account =
        mode === 'signed-out' || mode === 'provider'
          ? null
          : {
              type: mode === 'api-key' ? 'apiKey' : 'chatgpt',
              email: 'private@example.com',
              token: 'never-return-this',
            };
      console.log(
        JSON.stringify({
          id: 1,
          result:
            mode === 'broken-account'
              ? {}
              : {
                  account,
                  requiresOpenaiAuth: mode !== 'provider',
                },
        }),
      );
    }
  });
}
