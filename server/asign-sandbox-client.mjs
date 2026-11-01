import {createHash,createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';

// Verified against Asign's Python SDK, downloaded from its authenticated TEST
// console on 2026-10-29. Never accepts a caller-supplied provider origin.
export const ASIGN_SANDBOX='https://prev.asign.cn';
const paths=new Set(['/template/list','/template/getTemplateData','/template/upload','/template/sync','/template/open','/user/userList','/auth/person/identifyUrl','/auth/getAuthRecordInfo','/v2/user/addPersonalUser','/contract/createContract','/contract/addSigner','/contract/getContract','/contract/status','/contract/downloadContract']);
export class AsignError extends Error {
  constructor(code,providerCode=null,retryable=false){super(code);Object.assign(this,{code,providerCode,retryable});}
}
export function sortedJSON(value){
  const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
  return JSON.stringify(sort(value));
}
export function createAsignSandboxClient({appId,privateKey,platformPublicKey,environment,fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=20000}){
  if(environment!=='sandbox'||!/^\d{5,20}$/.test(String(appId)))throw new AsignError('ASIGN_SANDBOX_CONFIG_REQUIRED');
  const key=createPrivateKey(privateKey),platform=createPublicKey(platformPublicKey);
  if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<2048||platform.asymmetricKeyType!=='rsa')throw new AsignError('ASIGN_INVALID_KEY');
  async function request(path,body,{file}={}){
    if(!paths.has(path))throw new AsignError('ASIGN_PATH_NOT_ALLOWED');
    const bizData=sortedJSON(body),timestamp=String(now()+60_000),md5=createHash('md5').update(bizData).digest('hex');
    const signature=sign('RSA-SHA1',Buffer.from(bizData+md5+String(appId)+timestamp),key).toString('base64');
    const form=new FormData();form.set('appId',String(appId));form.set('timestamp',timestamp);form.set('bizData',bizData);form.set('Content-Type','application/octet-stream');form.set('type','application/octet-stream');
    if(file){if(!['file','templateFile'].includes(file.field)||file.bytes.length>10*1024*1024)throw new AsignError('ASIGN_INVALID_FILE');form.set(file.field,new Blob([file.bytes],{type:'application/octet-stream'}),file.name);}
    try{
      const response=await fetchImpl(ASIGN_SANDBOX+path,{method:'POST',headers:{accept:'application/json',sign:signature},body:form,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
      if(!response.ok)throw new AsignError('ASIGN_HTTP_FAILED',response.status,response.status>=500||response.status===429);
      const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>20*1024*1024)throw new AsignError('ASIGN_RESPONSE_TOO_LARGE');chunks.push(chunk);}
      let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AsignError('ASIGN_INVALID_RESPONSE');}
      if(value.code!==100000)throw new AsignError('ASIGN_PROVIDER_REJECTED',Number.isInteger(value.code)?value.code:null,[0,100002].includes(value.code));
      return value.data;
    }catch(error){if(error instanceof AsignError)throw error;throw new AsignError('ASIGN_TRANSPORT_UNKNOWN',null,true);}
  }
  function verifyCallback(body){
    if(!body||Array.isArray(body)||typeof body.sign!=='string'||body.sign.length>2048||typeof body.contractNo!=='string')return false;
    // These unsigned fields are explicitly excluded by Asign. They are never
    // trusted for status/identity; a verified callback only schedules a re-query.
    const payload=Object.fromEntries(Object.entries(body).filter(([key])=>!['sign','account','remark'].includes(key)));
    if(Object.values(payload).some(v=>typeof v!=='string'&&typeof v!=='number'))return false;
    try{return verify('RSA-SHA1',Buffer.from(sortedJSON(Object.fromEntries(Object.entries(payload).map(([k,v])=>[k,String(v)])))),platform,Buffer.from(body.sign,'base64'));}catch{return false;}
  }
  return {request,verifyCallback,origin:ASIGN_SANDBOX,appId:String(appId)};
}
