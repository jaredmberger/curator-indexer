import base from './entry-v1.2.js';
import { BUILD_META } from '../generated/build-meta.js';
const SERVICE='Curator Indexer',REPOSITORY='jaredmberger/curator-indexer',HEARTBEAT_KEY='heartbeat:curator-indexer:scheduled-monitor';
export default{async fetch(request,env,ctx){const u=new URL(request.url);if(request.method==='GET'&&u.pathname==='/api/recovery-export'){const auth=requireRecoveryExportToken(request,env);if(auth)return auth;return recoveryExport(env)}if(request.method==='GET'&&u.pathname==='/api/runtime')return json(runtime(env));if(request.method==='GET'&&u.pathname==='/api/ops-health')return json(await health(env));return base.fetch(request,env,ctx)},async scheduled(c,e,x){return base.scheduled(c,e,x)}};
function runtime(env){const m=env.CF_VERSION_METADATA||{};return{ok:true,service:SERVICE,version:'1.3.0',repository:REPOSITORY,runtime:'cloudflare-workers',cloudflareVersion:{id:m.id||null,tag:m.tag||null,timestamp:m.timestamp||null},build:BUILD_META,observedAt:new Date().toISOString()}}
async function health(env){const h=env.CURATOR_ERROR_RECORDS?await env.CURATOR_ERROR_RECORDS.get(HEARTBEAT_KEY,'json'):null;return fresh(h)}
function fresh(h){const at=h?.at||null,maxAgeMinutes=Number(h?.maxAgeMinutes||180),ageMinutes=at?Math.floor((Date.now()-Date.parse(at))/60000):null,stale=ageMinutes==null?null:ageMinutes>maxAgeMinutes;return{ok:stale!==true,service:SERVICE,schedule:{cadence:'hourly',minute:7},lastSuccessAt:at,ageMinutes,maxAgeMinutes,stale,status:stale===true?'stale':at?'healthy':'unknown',heartbeat:h?{component:h.component||null,message:h.message||null}:null,checkedAt:new Date().toISOString()}}
function json(v,s=200){return new Response(JSON.stringify(v,null,2),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}})}

function requireRecoveryExportToken(request,env){
  if(!env.RECOVERY_EXPORT_TOKEN)return json({ok:false,error:'Recovery export is disabled because RECOVERY_EXPORT_TOKEN is not configured.'},503);
  const supplied=request.headers.get('x-curator-recovery-key');
  return supplied===env.RECOVERY_EXPORT_TOKEN?null:json({ok:false,error:'Unauthorized recovery export request.'},401);
}
async function recoveryExport(env){
  if(!env.CURATOR_INDEXER_RECORDS)return json({ok:false,error:'CURATOR_INDEXER_RECORDS is not configured.'},500);
  try{
    const entries=[];let cursor;
    do{
      const page=await env.CURATOR_INDEXER_RECORDS.list({limit:1000,...(cursor?{cursor}:{})});
      for(const item of page.keys){
        const raw=await env.CURATOR_INDEXER_RECORDS.get(item.name,'text');
        if(raw===null)throw new Error(`Listed KV key disappeared during export: ${item.name}`);
        entries.push({key:item.name,value:raw});
      }
      cursor=page.list_complete?undefined:page.cursor;
    }while(cursor);
    entries.sort((a,b)=>a.key.localeCompare(b.key));
    const data={entries};
    const exportedAt=new Date().toISOString();
    const dataSha256=await sha256(JSON.stringify(data));
    const payload={
      format:'curator-indexer-kv-recovery',
      schemaVersion:1,
      exportedAt,
      source:{service:SERVICE,binding:'CURATOR_INDEXER_RECORDS',namespaceId:'cdc9a84c8b364dcd9361d670c8db26b5'},
      integrity:{algorithm:'SHA-256',dataSha256},
      summary:{keyCount:entries.length},
      data
    };
    const stamp=exportedAt.replace(/[:.]/g,'-');
    return new Response(JSON.stringify(payload,null,2),{status:200,headers:{'content-type':'application/json; charset=utf-8','content-disposition':`attachment; filename="curator-indexer-recovery-${stamp}.json"`,'cache-control':'no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex, nofollow, noarchive'}});
  }catch(error){return json({ok:false,error:'Recovery export failed.',detail:error?.message||String(error)},500)}
}
async function sha256(value){
  const bytes=new TextEncoder().encode(value);
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
