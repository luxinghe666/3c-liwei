import {chmodSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

export function migrateUserRoles(db,filename) {
  const schema=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get().sql;
  if(schema.includes("'procurement_sales'")&&schema.includes("'warehouse'")){
    db.exec('PRAGMA user_version=2;');return;
  }
  // Snapshot the complete old database before changing its role constraint.
  const backup=filename+'.before-roles-v2-'+randomUUID()+'.sqlite';
  db.prepare('VACUUM INTO ?').run(backup);chmodSync(backup,0o600);
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
  try {
    db.exec(`CREATE TABLE users_roles_v2(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','finance','procurement_sales','warehouse')),password TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
      INSERT INTO users_roles_v2 SELECT id,username,name,role,password,active FROM users;
      DROP TABLE users;
      ALTER TABLE users_roles_v2 RENAME TO users;`);
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('账号升级校验失败，原数据已保留');
    db.exec('PRAGMA user_version=2; COMMIT;');
  } catch(error) {db.exec('ROLLBACK;');throw error;}
  finally {db.exec('PRAGMA foreign_keys=ON;');}
}
