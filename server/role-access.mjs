import {requireValue} from './security.mjs';
import {roleNames} from '../dist/roles.js';

// Role configuration grants only the explicitly listed extra business abilities.
// Financial state, profit, members and accounting periods remain fixed role boundaries.
export const capabilityCatalog = Object.freeze([
  {id:'inventory.view',label:'查看库存',description:'查看型号、串号和可用数量'},
  {id:'purchase.create',label:'采购建单',description:'录入采购订单及本笔采购价格'},
  {id:'purchase.ship',label:'供应商发货登记',description:'登记供应商发货批次和物流'},
  {id:'stock.receive',label:'验收收货',description:'按串号核验实际收到的货物'},
  {id:'stock.putaway',label:'确认入库',description:'将已验收货物入库'},
  {id:'sale.create',label:'销售建单',description:'录入销售订单及本笔销售价格'},
  {id:'stock.pick',label:'确认出库',description:'核验出库串号并确认出库'},
  {id:'stock.dispatch',label:'登记发货',description:'登记承运商、运单和实际发货批次'},
  {id:'sale.return',label:'客户退货',description:'关联原销售登记并验收退货'},
  {id:'master.manage',label:'新增基础资料',description:'新增商品型号、供应商及客户'},
  {id:'barcode.manage',label:'维护 B 标型号对应',description:'维护 69 码与商品型号的唯一对应'},
  {id:'stocktake.record',label:'登记库存盘点',description:'记录实盘结果；不会自动调整库存、成本或财务'},
  {id:'integration.manage',label:'管理供应商同步',description:'核对小程序供应商和商品映射及同步异常'},
  {id:'financial.view',label:'查看财务数据',description:'老板与财务的固定权限，不能授予库存岗位'},
  {id:'financial.payment',label:'处理资金往来',description:'老板与财务的固定权限，不能授予库存岗位'},
  {id:'members.manage',label:'管理成员与权限',description:'仅老板可操作'},
  {id:'period.close',label:'关账及反关账',description:'仅老板可操作'},
].map(Object.freeze));

const known = new Set(capabilityCatalog.map(row=>row.id));
const business = Object.freeze(['inventory.view','purchase.create','purchase.ship','stock.receive','stock.putaway','sale.create','stock.pick','stock.dispatch','sale.return','master.manage']);
export const configurableCapabilities = Object.freeze(['barcode.manage','stocktake.record','integration.manage']);
const configurable = new Set(configurableCapabilities);
const roles = Object.freeze(['finance','procurement_sales','warehouse']);
const financial = new Set(['financial.view','financial.payment']);
const ownerOnly = new Set(['members.manage','period.close']);
const ordered = values => capabilityCatalog.map(row=>row.id).filter(id=>values.includes(id));

function validActor(actor) {
  requireValue(actor && Object.hasOwn(roleNames,actor.role) && actor.active!==false && actor.active!==0,'账号或岗位无效',403);
  return actor;
}
function currentActor(db,actor) {
  validActor(actor);
  const current=db.prepare('SELECT id,role,active FROM users WHERE id=?').get(actor.id);
  requireValue(current && current.active===1,'账号已停用或不存在',403);
  return validActor(current);
}
export function defaultCapabilitiesForRole(role) {
  requireValue(Object.hasOwn(roleNames,role),'岗位无效',403);
  if(role==='owner')return capabilityCatalog.map(row=>row.id);
  return [...business,...(role==='finance'?['financial.view','financial.payment']:[])];
}
function savedRole(db,role) {
  const row=db.prepare('SELECT revision,capabilities FROM role_permissions WHERE role=?').get(role);
  if(!row)return {revision:0,capabilities:[]};
  let capabilities;
  try { capabilities=JSON.parse(row.capabilities); } catch { requireValue(false,'岗位权限记录损坏，请联系老板核对',500); }
  requireValue(Array.isArray(capabilities) && capabilities.every(key=>configurable.has(key)) && new Set(capabilities).size===capabilities.length,'岗位权限记录无效，请联系老板核对',500);
  return {revision:row.revision,capabilities:ordered(capabilities)};
}

export function installRoleAccess(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS role_permissions(
    role TEXT PRIMARY KEY CHECK(role IN ('finance','procurement_sales','warehouse')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
    capabilities TEXT NOT NULL DEFAULT '[]'
  );`);
  const insert=db.prepare('INSERT INTO role_permissions(role) VALUES(?) ON CONFLICT(role) DO NOTHING');
  for(const role of roles)insert.run(role);
}

// Always call with db at the request/command boundary; never trust client-supplied
// capability arrays. This rechecks the current user role and current role grants.
export function effectiveCapabilities(actor,db) {
  const current=db?currentActor(db,actor):validActor(actor);
  const base=defaultCapabilitiesForRole(current.role);
  if(current.role==='owner')return base;
  const extra=db?savedRole(db,current.role).capabilities:[];
  return ordered([...base,...extra]);
}

export function hasCapability(actor,key) {
  if(!actor || !Object.hasOwn(roleNames,actor.role) || actor.active===false || actor.active===0 || !known.has(key))return false;
  if(ownerOnly.has(key))return actor.role==='owner';
  if(financial.has(key))return ['owner','finance'].includes(actor.role);
  if(actor.role==='owner')return true;
  // Fixed default business abilities cannot be removed by role extras. An array
  // here must come from effectiveCapabilities(actor,db) in the server session.
  return defaultCapabilitiesForRole(actor.role).includes(key) || (configurable.has(key) && Array.isArray(actor.capabilities) && actor.capabilities.includes(key));
}
export function requireCapability(actor,key) {
  requireValue(hasCapability(actor,key),'当前岗位没有此操作权限，请联系老板授权',403);
}
function owner(db,actor) {
  const current=currentActor(db,actor);
  requireValue(current.role==='owner','只有老板可以管理岗位权限',403);
  return current;
}
function roleDTO(db,role) {
  const saved=savedRole(db,role),baseCapabilities=defaultCapabilitiesForRole(role);
  return {role,label:roleNames[role],revision:saved.revision,baseCapabilities,extraCapabilities:saved.capabilities,effectiveCapabilities:ordered([...baseCapabilities,...saved.capabilities])};
}
export function permissionSettings(db,actor) {
  owner(db,actor);
  return {
    catalog:capabilityCatalog.filter(row=>configurable.has(row.id)).map(({id,label,description})=>({id,label,description})),
    roles:roles.map(role=>roleDTO(db,role)),
  };
}

// input.capabilities is the complete EXTRA grant set, not effective permissions.
// Uses a savepoint so the caller can wrap it in its own transaction safely.
// Existing sessions remain valid: computing permissions on each request makes
// additions/removals immediate without logging the owner or staff out.
export function updateRolePermissions(db,actor,input) {
  requireValue(input && typeof input==='object' && !Array.isArray(input) && Object.keys(input).every(key=>['role','capabilities','revision'].includes(key)),'岗位权限请求格式无效');
  requireValue(roles.includes(input.role),'只能设置财务、采销或出库入库岗位，老板权限不可修改');
  requireValue(Number.isSafeInteger(input.revision) && input.revision>=0,'缺少有效的岗位权限版本');
  requireValue(Array.isArray(input.capabilities) && input.capabilities.length<=configurableCapabilities.length && input.capabilities.every(key=>configurable.has(key)) && new Set(input.capabilities).size===input.capabilities.length,'只能选择允许额外授权的业务权限，不能开放历史成本或利润');
  const capabilities=ordered(input.capabilities);
  db.exec('SAVEPOINT role_access_update');
  try {
    const current=owner(db,actor),before=savedRole(db,input.role);
    requireValue(before.revision===input.revision,'岗位权限已被更新，请刷新后再保存',409);
    if(JSON.stringify(before.capabilities)===JSON.stringify(capabilities)){
      const result={...roleDTO(db,input.role),changed:false};
      db.exec('RELEASE SAVEPOINT role_access_update');return result;
    }
    const result=db.prepare('UPDATE role_permissions SET capabilities=?,revision=revision+1 WHERE role=? AND revision=?').run(JSON.stringify(capabilities),input.role,input.revision);
    requireValue(result.changes===1,'岗位权限已被更新，请刷新后再保存',409);
    db.prepare('INSERT INTO security_audit(user_id,event,detail,created_at) VALUES(?,?,?,?)').run(current.id,'role_permissions_updated',JSON.stringify({role:input.role,revision:input.revision+1,before:before.capabilities,after:capabilities}),new Date().toISOString());
    const response={...roleDTO(db,input.role),changed:true};
    db.exec('RELEASE SAVEPOINT role_access_update');return response;
  } catch(error) {
    db.exec('ROLLBACK TO SAVEPOINT role_access_update; RELEASE SAVEPOINT role_access_update');throw error;
  }
}
