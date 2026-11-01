// Source-preview entry point only. Do not load .env, real credentials or ledgers.
import { mkdirSync, mkdtempSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createApplication } from '../server/app.mjs';

const port = Number(process.env.CLOUD_UI_PORT || 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('CLOUD_UI_PORT must be 1024–65535');
const root = fileURLToPath(new URL('../', import.meta.url));
const local = join(root, '.local');
mkdirSync(local, { recursive: true, mode: 0o700 });
if (lstatSync(local).isSymbolicLink()) throw new Error('The preview directory must not be a symlink');
const directory = mkdtempSync(join(local, 'ui-preview-'));
const origin = `http://127.0.0.1:${port}`;
const noExternalRequests = async () => { throw new Error('External integration requests are disabled in the source preview'); };
const app = await createApplication({
  database: join(directory, 'preview.sqlite'), origin, allowSetup: true,
  integrationSecret: '', wecomConfig: { enabled: false, reason: '源码预览使用独立模拟账本' },
  wecomFetch: noExternalRequests, asignFetch: noExternalRequests,
  pushConfigured: false,
});
app.server.once('error', async error => {
  console.error(`Preview could not start: ${error.code || error.name}`);
  await app.close(); process.exitCode = 1;
});
app.server.listen(port, '127.0.0.1', () => {
  console.log(`源码本地预览（仅模拟数据）：${origin}/login.html`);
  console.log('每次启动创建新的隔离账本；首次打开自行设置测试账号。企业微信、爱签、APNs 和跨系统同步均未启用。');
});
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  if (closing) return; closing = true; await app.close(); process.exit(0);
});
