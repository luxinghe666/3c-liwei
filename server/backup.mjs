import { resolve } from 'node:path';
import { backupDatabase, restoreDatabase } from './store.mjs';
const [command, source, destination] = process.argv.slice(2);
if (!['backup','restore'].includes(command) || !source || !destination) {
  console.error('用法：node server/backup.mjs backup|restore 源数据库 新目标文件');process.exitCode=1;
} else {
  await (command==='backup'?backupDatabase:restoreDatabase)(resolve(source),resolve(destination));
  console.log(`${command==='backup'?'备份':'恢复'}完成：${resolve(destination)}`);
}
