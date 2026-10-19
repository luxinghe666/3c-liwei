import test from 'node:test';
import assert from 'node:assert/strict';
import {dailySummary,summary} from './dist/model.js';
import {newBook} from './server/book.mjs';
const totalTax=(s,month,days,asOf='2026-10-17')=>Array.from({length:days},(_,i)=>dailySummary(s,`${month}-${String(i+1).padStart(2,'0')}`,asOf).tax).reduce((a,b)=>a+b,0);
test('日利润只取当天回款、退货、费用与调整；实际日税之和与整月一致',()=>{
 const s=newBook('empty');s.recognitions=[{date:'2026-09-30',profit:9999},{date:'2026-10-01',profit:5000},{date:'2026-10-02',profit:2000}];s.expenses=[{date:'2026-10-01',amount:100},{date:'2026-10-02',amount:200}];s.adjustments=[{date:'2026-10-02',kind:'return_reversal',amount:500},{date:'2026-10-01',kind:'freight',amount:200}];s.taxes['2026-10']=3100;
 const before=structuredClone(s),a=dailySummary(s,'2026-10-01','2026-10-17'),b=dailySummary(s,'2026-10-02','2026-10-17');
 assert.equal(a.profit,4600);assert.equal(b.profit,1200);assert.equal(a.tax,100);assert.equal(a.taxEstimated,false);assert.equal(a.taxSourceMonth,'2026-10');
 const days=Array.from({length:31},(_,i)=>dailySummary(s,`2026-10-${String(i+1).padStart(2,'0')}`,'2026-10-17'));
 assert.equal(days.reduce((n,r)=>n+r.profit,0),summary(s,'2026-10').profit);assert.deepEqual(s,before);
});
test('日均税费按实际天数，含闰月；尾差守恒且最多差一分',()=>{
 for(const [month,days] of [['2026-02',28],['2028-02',29],['2026-04',30],['2026-10',31]]){
  const s=newBook('empty');s.taxes[month]=10001;
  assert.equal(totalTax(s,month,days),10001);
  const first=dailySummary(s,month+'-01'),last=dailySummary(s,`${month}-${days}`);
  assert.equal(first.daysInMonth,days);assert.ok(first.tax-last.tax<=1);
 }
});
test('仅本月未填时引用上月，使用本月天数；手填零元会停止暂估',()=>{
 const s=newBook('empty');s.taxes['2026-09']=30000;
 const r=dailySummary(s,'2026-10-17','2026-10-17');assert.equal(r.taxEstimated,true);assert.equal(r.taxSourceMonth,'2026-09');assert.equal(r.daysInMonth,31);assert.equal(totalTax(s,'2026-10',31),30000);assert.equal(summary(s,'2026-10').tax,0);
 s.taxes['2026-10']=62000;assert.equal(dailySummary(s,'2026-10-17','2026-10-17').tax,2000);assert.equal(dailySummary(s,'2026-10-17','2026-10-17').taxEstimated,false);
 s.taxes['2026-10']=0;assert.equal(dailySummary(s,'2026-10-17','2026-10-17').tax,0);assert.equal(dailySummary(s,'2026-10-17','2026-10-17').taxMissing,false);
});
test('跨年取上月；历史未填、未来未填和上月也未填均标待补，不伪造税费',()=>{
 const s=newBook('empty');s.taxes['2025-12']=31000;
 assert.equal(dailySummary(s,'2026-01-01','2026-01-20').taxSourceMonth,'2025-12');
 for(const [day,asOf] of [['2026-01-01','2026-02-01'],['2026-01-01','2025-12-20'],['2026-10-01','2026-10-17']]){const r=dailySummary(s,day,asOf);assert.equal(r.taxMissing,true);assert.equal(r.taxEstimated,false);assert.equal(r.tax,0);}
 for(const value of ['2026-02-30','2026-13-01','2026-1-01','bad'])assert.throws(()=>dailySummary(s,value));
});
