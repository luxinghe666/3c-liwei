import { resolve } from 'node:path';
import { createApplication } from './app.mjs';
const port = Number(process.env.PORT || 4318);
const host = process.env.HOST || '127.0.0.1';
const origin = process.env.APP_ORIGIN || `http://127.0.0.1:${port}`;
const app = await createApplication({ database: resolve(process.env.DB_PATH || 'data/finance.sqlite'), origin, allowSetup: ['127.0.0.1','::1','localhost'].includes(host) && ['127.0.0.1','[::1]','localhost'].includes(new URL(origin).hostname) });
app.server.listen(port,host,()=>console.log(`财务工作台测试版：${origin}\n账本：${resolve(process.env.DB_PATH || 'data/finance.sqlite')}\n首次打开请设置老板账号。此版本仍处于功能验证阶段。`));
let closing=false;
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{if(closing)return;closing=true;await app.close();process.exit(0);});
