import {executeAction,validateAction} from './book.mjs';
import {requireValue,text,HttpError} from './security.mjs';
export const correctableTypes=new Set(['receipt','transfer','boss_in','boss_pay','boss_repay','expense','supplier_pay','supplier_settle','supplier_offset']);
const originalEvent=row=>row.changes.find(c=>c.collection==='lastAction')?.after;
// A deliberate test-data reset is a new baseline, not a business action to replay.
const activeHistory=rows=>rows.slice(rows.findLastIndex(r=>r.action.type==='test_cleanup')+1);
export function correctionHistory(rows){
  rows=activeHistory(rows);
  const changes=new Map(rows.filter(r=>r.action.type==='action_correct').map(r=>[r.action.targetActionId,r.action]));
  return rows.filter(r=>correctableTypes.has(r.action.type)).map(r=>{const event=originalEvent(r),change=changes.get(event?.id);return {id:event?.id,action:change?.replacement||r.action,original:r.action,voided:change?.mode==='void',actor:r.actor,corrected:Boolean(change)};}).filter(r=>r.id);
}
function rewind(current,rows){
  const s=structuredClone(current);
  for(const r of [...rows].reverse())for(const c of [...r.changes].reverse()){
    if(c.id){const list=s[c.collection]||[],index=list.findIndex(x=>x.id===c.id);if(c.before===null){if(index>=0)list.splice(index,1);}else if(index>=0)list[index]=structuredClone(c.before);else list.push(structuredClone(c.before));s[c.collection]=list;}
    else if(c.before===null)delete s[c.collection];else s[c.collection]=structuredClone(c.before);
  }
  return s;
}
// Preserve IDs referenced by downstream documents even if receipt allocation counts change.
function preserveIds(before,next,record){
  const map=new Map();
  for(const key of ['accounts','customers','suppliers','products','inventory','purchases','sales','payables','ledger','expenses','adjustments','audit','reconciliations','stocktakes']){
    const known=new Set((before[key]||[]).map(x=>x.id));
    const added=(next[key]||[]).filter(x=>!known.has(x.id));
    const original=record.changes.filter(c=>c.collection===key&&c.id&&c.before===null).map(c=>c.id);
    if(added.length===original.length)added.forEach((row,i)=>map.set(row.id,original[i]));
  }
  const replace=v=>{
    if(Array.isArray(v))return v.map(replace);
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,(k==='id'||k.endsWith('Id')||k==='resultId')&&typeof x==='string'?(map.get(x)||x):replace(x)]));
    return v;
  };
  return replace(next);
}
function closedValues(s,month){
  const normalize=r=>Object.fromEntries(Object.entries(r).filter(([k])=>!['id','actionId'].includes(k)).sort(([a],[b])=>a.localeCompare(b)));
  const value={tax:s.taxes[month]??null};
  for(const key of ['ledger','recognitions','expenses','adjustments'])value[key]=(s[key]||[]).filter(r=>r.date.startsWith(month)).map(normalize).map(JSON.stringify).sort();
  return JSON.stringify(value);
}
export function correctBook(before,raw,actor,rows){
  requireValue(raw&&typeof raw==='object'&&!Array.isArray(raw),'更正格式无效');
  rows=activeHistory(rows);
  requireValue(typeof raw.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(raw.date)&&!Number.isNaN(Date.parse(raw.date))&&new Date(raw.date+'T00:00:00Z').toISOString().slice(0,10)===raw.date,'更正日期无效');
  requireValue(Object.keys(raw).every(k=>['type','targetActionId','mode','replacement','note','date'].includes(k)),'更正包含未知字段');
  requireValue(!before.closedMonths.includes(raw.date.slice(0,7)),'更正日期所在月份已关账',409);
  requireValue(!before.opening||raw.date>=before.opening.date,'更正日期不能早于期初启用日');
  const reason=text(raw.note,'更正／撤销原因',500),target=text(raw.targetActionId,'原流水',100);
  requireValue(['edit','void'].includes(raw.mode),'请选择更正或撤销');
  const record=rows.find(r=>originalEvent(r)?.id===target&&correctableTypes.has(r.action.type));requireValue(record,'该记录不支持流水更正');
  const latest=correctionHistory(rows).find(r=>r.id===target);requireValue(!latest.voided,'该流水已撤销');
  requireValue(!before.closedMonths.includes(latest.action.date.slice(0,7)),'原流水月份已关账，请由老板先反关账',409);
  const replacement=raw.mode==='edit'?validateAction(raw.replacement):null;
  if(replacement){requireValue(replacement.type===record.action.type,'更正不能改变业务类型');requireValue(!before.closedMonths.includes(replacement.date.slice(0,7)),'目标月份已关账',409);}
  const action={type:'action_correct',targetActionId:target,mode:raw.mode,note:reason,date:raw.date,...(replacement?{replacement}: {})};
  const overrides=new Map(rows.filter(r=>r.action.type==='action_correct').map(r=>[r.action.targetActionId,r.action]));overrides.set(target,action);
  let state=rewind(before,rows);state.sequence=Math.max(before.sequence,state.sequence);
  for(const row of rows){
    if(row.action.type==='action_correct')continue;
    const change=overrides.get(originalEvent(row)?.id);if(change?.mode==='void')continue;
    try{
      const result=executeAction(state,change?.replacement||row.action,{id:row.user_id,name:row.actor,role:'owner'},{replay:true});
      state=preserveIds(state,result.state,row);
    }catch(e){throw new HttpError(400,`后续业务 ${originalEvent(row)?.id||row.revision} 无法成立：${e.message}。请先核对相关业务，本次未修改。`);}
  }
  for(const month of before.closedMonths)requireValue(closedValues(before,month)===closedValues(state,month),`更正会影响已关账的 ${month}，请先由老板反关账`,409);
  // Physical inventory counts are observations, never recomputed as a side effect of financial correction.
  state.stocktakes=structuredClone(before.stocktakes||[]);
  state.reconciliations=structuredClone(before.reconciliations||[]);
  state.corrections=[...(before.corrections||[]),{id:`correction-${++state.sequence}`,targetActionId:target,mode:raw.mode,note:reason,date:raw.date,actorName:actor.name,before:latest.action,after:replacement}];
  const event={id:`action-${++state.sequence}`,type:'action_correct',date:raw.date,note:reason,payload:action,actorId:actor.id,actorName:actor.name};
  const retained=new Set(state.audit.map(r=>r.id));
  state.audit.push(...before.audit.filter(r=>r.type==='action_correct'&&!retained.has(r.id)),event);state.lastAction=event;
  return {state,action};
}
