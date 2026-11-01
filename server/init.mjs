// One-time initialization via an interactive server console; no passwords in argv or environment.
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { resolve } from 'node:path';
import { openStore } from './store.mjs';
import { username, text, hashPassword } from './security.mjs';
if (!process.stdin.isTTY) throw new Error('请在交互式终端运行初始化，不能通过公开网页创建第一个账号');
const store=openStore(resolve(process.argv[2] || 'data/finance.sqlite'));
let muted=false;
const output=new Writable({write(chunk,encoding,done){if(!muted)process.stdout.write(chunk,encoding);done();}});
const rl=createInterface({input:process.stdin,output,terminal:true});
async function hidden(prompt){process.stdout.write(prompt);muted=true;try{return await rl.question('');}finally{muted=false;process.stdout.write('\n');}}
try{
  if(store.initialized())throw new Error('账本已初始化，未作任何修改');
  const login=username(await rl.question('老板登录账号（英文数字）：'));
  const name=text(await rl.question('显示姓名：'),'姓名',40);
  const password=await hidden('密码（至少 12 位，不显示输入）：');
  if(password!==await hidden('再次输入密码：'))throw new Error('两次密码不一致');
  const hash=await hashPassword(password);
  store.setup({username:login,name,password:hash,mode:'empty'});
  console.log('空白账本与老板账号已创建。请登录后开通财务账号。');
}finally{rl.close();store.close();}
