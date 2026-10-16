import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { newBook, executeAction, changedRecords } from './book.mjs';
import { digest, requireValue, publicUser } from './security.mjs';

export function openStore(filename) {
  mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) { db.close(); throw new Error('数据库版本较新，请升级程序后再打开'); }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','finance')), password TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS book(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS journal(id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL, request_hash TEXT NOT NULL, action TEXT NOT NULL, revision INTEGER NOT NULL UNIQUE, before_hash TEXT NOT NULL, after_hash TEXT NOT NULL, changes TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id,request_key));
    CREATE TABLE IF NOT EXISTS security_audit(id INTEGER PRIMARY KEY, user_id TEXT, event TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
    PRAGMA user_version=1;`);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const audit = (id, event, detail = '') => db.prepare('INSERT INTO security_audit(user_id,event,detail,created_at) VALUES(?,?,?,?)').run(id, event, detail, new Date().toISOString());
  const getBook = () => {
    const row = db.prepare('SELECT revision,state FROM book WHERE id=1').get();
    requireValue(row, '请先初始化账本', 409);
    return { revision: row.revision, state: JSON.parse(row.state) };
  };
  return {
    db, transaction, audit, getBook,
    initialized: () => Boolean(db.prepare('SELECT id FROM book WHERE id=1').get()),
    setup(input) { return transaction(() => {
      requireValue(!db.prepare('SELECT id FROM book WHERE id=1').get(), '账本已初始化，请登录', 409);
      const user = { id: randomUUID(), ...input, role: 'owner', active: 1 };
      db.prepare('INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)').run(user.id, user.username, user.name, user.role, user.password);
      db.prepare('INSERT INTO book VALUES(1,0,?)').run(JSON.stringify(newBook(input.mode)));
      audit(user.id, 'setup', input.mode);
      return publicUser(user);
    }); },
    command(actor, input) { return transaction(() => {
      requireValue(input && typeof input === 'object' && Object.keys(input).every(k => ['key','revision','action'].includes(k)), '请求格式无效');
      requireValue(typeof input.key === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(input.key), '缺少有效的防重复提交标识');
      requireValue(Number.isSafeInteger(input.revision) && input.revision >= 0, '缺少账本版本');
      requireValue(input.action && typeof input.action === 'object' && !Array.isArray(input.action), '缺少业务内容');
      const requestHash = digest(JSON.stringify(input.action));
      const existing = db.prepare('SELECT request_hash FROM journal WHERE user_id=? AND request_key=?').get(actor.id, input.key);
      if (existing) {
        requireValue(existing.request_hash === requestHash, '同一提交标识不能用于不同操作', 409);
        return { ...getBook(), replayed: true };
      }
      const before = getBook();
      requireValue(before.revision === input.revision, '账本已被其他操作更新，请刷新核对后重新保存', 409);
      const result = executeAction(before.state, input.action, actor);
      const revision = before.revision + 1;
      const serialized = JSON.stringify(result.state);
      db.prepare('UPDATE book SET revision=?,state=? WHERE id=1').run(revision, serialized);
      db.prepare('INSERT INTO journal(user_id,request_key,request_hash,action,revision,before_hash,after_hash,changes,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(actor.id, input.key, requestHash, JSON.stringify(result.action), revision, digest(JSON.stringify(before.state)), digest(serialized), JSON.stringify(changedRecords(before.state, result.state)), new Date().toISOString());
      return { revision, state: result.state, replayed: false };
    }); },
    close: () => db.close(),
  };
}

export async function backupDatabase(source, destination) {
  requireValue(!existsSync(destination), '备份文件已存在，请使用新文件名');
  mkdirSync(dirname(resolve(destination)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, destination); chmodSync(destination, 0o600); }
  finally { db.close(); }
}

export async function restoreDatabase(source, destination) {
  requireValue(!existsSync(destination), '恢复目标必须是新文件，不能覆盖正在使用的账本');
  const check = new DatabaseSync(source, { readOnly: true });
  try {
    requireValue(check.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', '备份完整性检查失败');
    requireValue(check.prepare('PRAGMA user_version').get().user_version === 1, '不支持该备份版本');
    requireValue(check.prepare('SELECT id FROM book WHERE id=1').get(), '备份尚未初始化');
    check.prepare('SELECT id FROM users LIMIT 1').get();
  } finally { check.close(); }
  await backupDatabase(source, destination);
  const db = new DatabaseSync(destination);
  try { db.exec('DELETE FROM sessions; DELETE FROM attempts;'); }
  finally { db.close(); }
}
