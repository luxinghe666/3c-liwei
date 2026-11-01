import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installRoleAccess,effectiveCapabilities,permissionSettings,updateRolePermissions,requireCapability,hasCapability,configurableCapabilities} from './server/role-access.mjs';

function fixture(t,filename=':memory:') {
  const db=new DatabaseSync(filename);
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,active INTEGER);CREATE TABLE security_audit(id INTEGER PRIMARY KEY,user_id TEXT,event TEXT,detail TEXT,created_at TEXT);CREATE TABLE sessions(token TEXT,user_id TEXT);`);
  const actors={};
  for(const role of ['owner','finance','procurement_sales','warehouse']){
    actors[role]={id:role,role,active:1};
    db.prepare('INSERT INTO users VALUES(?,?,1)').run(role,role);
    db.prepare('INSERT INTO sessions VALUES(?,?)').run('session-'+role,role);
  }
  installRoleAccess(db);t.after(()=>db.close());
  return {db,...actors};
}
const status=n=>e=>e.status===n;

test('默认岗位保留业务能力和财务边界，安装不改变会话',t=>{
  const f=fixture(t),proc=effectiveCapabilities(f.procurement_sales,f.db),warehouse=effectiveCapabilities(f.warehouse,f.db);
  assert.deepEqual(proc,warehouse);
  for(const key of ['inventory.view','purchase.create','purchase.ship','stock.receive','stock.putaway','sale.create','stock.pick','stock.dispatch','sale.return','master.manage'])assert.ok(proc.includes(key),key);
  for(const key of ['financial.view','financial.payment','members.manage','period.close',...configurableCapabilities])assert.equal(proc.includes(key),false,key);
  const finance=effectiveCapabilities(f.finance,f.db);
  assert.ok(finance.includes('financial.view'));assert.ok(finance.includes('financial.payment'));assert.ok(!finance.includes('period.close'));assert.ok(!finance.includes('members.manage'));
  assert.ok(effectiveCapabilities(f.owner,f.db).includes('members.manage'));
  assert.equal(f.db.prepare('SELECT count(*) n FROM sessions').get().n,4);
  installRoleAccess(f.db);assert.equal(f.db.prepare('SELECT count(*) n FROM role_permissions').get().n,3);
});

test('老板额外授权、撤销、实时读取、CAS 冲突及审计',t=>{
  const f=fixture(t),initial=permissionSettings(f.db,f.owner);
  assert.equal(initial.roles.length,3);assert.deepEqual(initial.roles.find(r=>r.role==='warehouse').extraCapabilities,[]);
  const saved=updateRolePermissions(f.db,f.owner,{role:'warehouse',revision:0,capabilities:['stocktake.record','barcode.manage']});
  assert.equal(saved.revision,1);assert.equal(saved.changed,true);
  const worker={...f.warehouse,capabilities:effectiveCapabilities(f.warehouse,f.db)};
  requireCapability(worker,'barcode.manage');requireCapability(worker,'stocktake.record');
  assert.equal(hasCapability({...worker,capabilities:[...worker.capabilities,'financial.view','members.manage']},'financial.view'),false);
  assert.equal(hasCapability({...worker,capabilities:[...worker.capabilities,'members.manage']},'members.manage'),false);
  assert.throws(()=>updateRolePermissions(f.db,f.owner,{role:'warehouse',revision:0,capabilities:[]}),status(409));
  assert.equal(permissionSettings(f.db,f.owner).roles.find(r=>r.role==='warehouse').revision,1);
  const unchanged=updateRolePermissions(f.db,f.owner,{role:'warehouse',revision:1,capabilities:['barcode.manage','stocktake.record']});
  assert.equal(unchanged.changed,false);assert.equal(unchanged.revision,1);
  const removed=updateRolePermissions(f.db,f.owner,{role:'warehouse',revision:1,capabilities:[]});assert.equal(removed.revision,2);
  assert.throws(()=>requireCapability({...worker,capabilities:effectiveCapabilities(worker,f.db)},'barcode.manage'),status(403));
  assert.equal(f.db.prepare('SELECT count(*) n FROM security_audit').get().n,2);
  const audit=JSON.parse(f.db.prepare('SELECT detail FROM security_audit ORDER BY id DESC LIMIT 1').get().detail);
  assert.deepEqual(audit,{role:'warehouse',revision:2,before:['barcode.manage','stocktake.record'],after:[]});
  assert.equal(f.db.prepare('SELECT count(*) n FROM sessions').get().n,4,'no session is revoked, per-request permissions are authoritative');
});

test('权限管理拒绝非老板、伪造旧岗位、未知权限和恶意扩权',t=>{
  const f=fixture(t);
  for(const actor of [f.finance,f.procurement_sales,f.warehouse,{...f.warehouse,role:'owner'}]){
    assert.throws(()=>permissionSettings(f.db,actor),status(403));
    assert.throws(()=>updateRolePermissions(f.db,actor,{role:'warehouse',revision:0,capabilities:['barcode.manage']}),status(403));
  }
  for(const input of [
    {role:'owner',revision:0,capabilities:[]},
    {role:'admin',revision:0,capabilities:[]},
    {role:'warehouse',revision:0,capabilities:['financial.view']},
    {role:'warehouse',revision:0,capabilities:['financial.payment']},
    {role:'warehouse',revision:0,capabilities:['members.manage']},
    {role:'warehouse',revision:0,capabilities:['period.close']},
    {role:'warehouse',revision:0,capabilities:['unknown']},
    {role:'warehouse',revision:0,capabilities:['barcode.manage','barcode.manage']},
    {role:'warehouse',revision:-1,capabilities:[]},
    {role:'warehouse',revision:0,capabilities:[],extra:true},
  ])assert.throws(()=>updateRolePermissions(f.db,f.owner,input),status(400));
  assert.equal(f.db.prepare('SELECT count(*) n FROM security_audit').get().n,0);
  for(const row of permissionSettings(f.db,f.owner).roles){assert.equal(row.revision,0);assert.deepEqual(row.extraCapabilities,[]);}
  f.db.prepare('UPDATE users SET active=0 WHERE id=?').run(f.owner.id);
  assert.throws(()=>permissionSettings(f.db,f.owner),status(403));
  assert.throws(()=>updateRolePermissions(f.db,f.owner,{role:'warehouse',revision:0,capabilities:['barcode.manage']}),status(403));
});

test('每次计算权限重新读取账号岗位，不信任 actor 自带能力',t=>{
  const f=fixture(t);
  const worker={...f.warehouse,role:'owner',capabilities:['financial.view','stocktake.record']};
  const result=effectiveCapabilities(worker,f.db);assert.equal(result.includes('financial.view'),false);assert.equal(result.includes('stocktake.record'),false);
  f.db.prepare('UPDATE users SET role=? WHERE id=?').run('warehouse',f.finance.id);
  assert.equal(effectiveCapabilities(f.finance,f.db).includes('financial.view'),false);
  assert.throws(()=>requireCapability(f.warehouse,'__proto__'),status(403));
  assert.throws(()=>requireCapability({role:'owner',active:false},'inventory.view'),status(403));
});

test('两连接同版本竞争只更新一次，重开后权限保存且升级幂等',t=>{
  const dir=mkdtempSync(join(tmpdir(),'yuantuo-role-access-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filename=join(dir,'roles.sqlite'),f=fixture(t,filename),second=new DatabaseSync(filename);t.after(()=>second.close());
  installRoleAccess(second);
  updateRolePermissions(f.db,f.owner,{role:'procurement_sales',revision:0,capabilities:['integration.manage']});
  assert.throws(()=>updateRolePermissions(second,f.owner,{role:'procurement_sales',revision:0,capabilities:['stocktake.record']}),status(409));
  installRoleAccess(second);assert.ok(effectiveCapabilities(f.procurement_sales,second).includes('integration.manage'));
  assert.equal(permissionSettings(second,f.owner).roles.find(r=>r.role==='procurement_sales').revision,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM security_audit').get().n,1);
});

test('嵌入外层事务时权限与审计一起回滚，审计失败不得留下权限',t=>{
  const f=fixture(t);
  f.db.exec('BEGIN');
  updateRolePermissions(f.db,f.owner,{role:'warehouse',revision:0,capabilities:['stocktake.record']});
  f.db.exec('ROLLBACK');
  assert.equal(permissionSettings(f.db,f.owner).roles.find(r=>r.role==='warehouse').revision,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM security_audit').get().n,0);
  f.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON security_audit BEGIN SELECT RAISE(ABORT,'audit unavailable');END;");
  assert.throws(()=>updateRolePermissions(f.db,f.owner,{role:'warehouse',revision:0,capabilities:['stocktake.record']}),/audit unavailable/);
  assert.equal(permissionSettings(f.db,f.owner).roles.find(r=>r.role==='warehouse').revision,0);
  assert.equal(effectiveCapabilities(f.warehouse,f.db).includes('stocktake.record'),false);
});

test('权限 DTO 仅返回已定义字段，损坏授权无法扩为财务读取',t=>{
  const f=fixture(t),result=permissionSettings(f.db,f.owner);
  assert.deepEqual(Object.keys(result).sort(),['catalog','roles']);
  assert.ok(result.catalog.every(r=>Object.keys(r).sort().join(',')==='description,id,label'));
  assert.ok(result.roles.every(r=>Object.keys(r).sort().join(',')==='baseCapabilities,effectiveCapabilities,extraCapabilities,label,revision,role'));
  f.db.prepare('UPDATE role_permissions SET capabilities=? WHERE role=?').run('["financial.view"]','warehouse');
  assert.throws(()=>effectiveCapabilities(f.warehouse,f.db),status(500));
});
