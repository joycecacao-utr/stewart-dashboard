#!/usr/bin/env node
// persona-window-diag.js — TEMPORARY. Rolling 30d vs prior-30d engaged-transcript
// counts per persona (matches buildPersonaWindow in fetch-css-data.js). Writes nothing.
const VF_KEY=process.env.VOICEFLOW_KEY,VF_PROJECT='69ebd4159a532921bd258f8d',VF_ANALYTICS='https://analytics-api.voiceflow.com';
const LOOKBACK_DAYS=parseInt(process.env.VF_LOOKBACK_DAYS||'65',10);
const headers={authorization:VF_KEY,'content-type':'application/json',accept:'application/json'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const PERSONAS=[
  {name:'Club customers',kw:['club','academy','facility','program','director','venue','organization']},
  {name:'Power subscribers',kw:['power','subscription','premium','pro plan','membership','subscribe','plan']},
  {name:'College',kw:['college','university','ncaa','collegiate','recruit','division','varsity']},
  {name:'High school',kw:['high school','hs ','junior tennis','jtr','prep school','grade','school team']},
  {name:'Parents',kw:['my son','my daughter','my child','my kid','as a parent','my player','our son','our daughter']},
];
function slateText(sl){const o=[];for(const n of(sl?.content??[]))for(const c of(n.children??[]))if(typeof c.text==='string')o.push(c.text);return o.join(' ');}
function convText(s){const p=[];for(const l of(s.logs??[])){if(l.type==='action'&&l.data?.type==='text'&&typeof l.data.payload==='string')p.push(l.data.payload);else if(l.type==='trace'&&l.data?.type==='text'&&l.data?.payload?.ai){const t=slateText(l.data.payload.slate);if(t)p.push(t);}}return p.join(' ');}
const isBounce=s=>!(s.logs??[]).some(l=>l.type==='action'&&l.data?.type==='text');
function getPersona(text=''){const t=text.toLowerCase();for(const p of PERSONAS)if(p.kw.some(kw=>t.includes(kw)))return p.name;return null;}
async function vfGetAll(days){const now=Date.now(),nw=Math.ceil(days/7),byId=new Map();
  for(let b=0;b<nw;b+=8){const batch=[];for(let w=b;w<Math.min(b+8,nw);w++){const we=new Date(now-w*7*86400000),ws=new Date(Math.max(now-(w+1)*7*86400000+1,now-days*86400000));batch.push(fetch(`${VF_ANALYTICS}/v1/transcript/project/${VF_PROJECT}`,{method:'POST',headers,body:JSON.stringify({startDate:ws.toISOString(),endDate:we.toISOString()})}).then(r=>r.ok?r.json():null).then(b=>b?.transcripts??[]));}(await Promise.all(batch)).forEach(list=>list.forEach(t=>{if(t?.id)byId.set(t.id,t);}));await sleep(80);}
  const all=[...byId.values()];for(let i=0;i<all.length;i+=10){await Promise.all(all.slice(i,i+10).map(async t=>{try{const r=await fetch(`${VF_ANALYTICS}/v1/transcript/${t.id}`,{headers});if(r.ok){const b=await r.json();t.logs=b.logs??b.transcript?.logs??[];}else t.logs=[];}catch{t.logs=[];}}));await sleep(80);}return all;}
async function main(){
  if(!VF_KEY){console.error('VOICEFLOW_KEY not set');process.exit(1);}
  const sessions=await vfGetAll(LOOKBACK_DAYS),now=Date.now(),DAY=86400000;
  const blank=()=>{const o={_total:0,_classified:0};for(const p of PERSONAS)o[p.name]=0;return o;};
  const cur=blank(),prev=blank();
  for(const s of sessions){if(isBounce(s))continue;const t=new Date(s.createdAt??s.updatedAt).getTime();if(isNaN(t))continue;const age=now-t;const b=(age>=0&&age<30*DAY)?cur:(age>=30*DAY&&age<60*DAY)?prev:null;if(!b)continue;b._total++;const p=getPersona(convText(s));if(p){b[p]++;b._classified++;}}
  console.log('PERSONA WINDOW (rolling 30d vs prior 30d):');
  console.log(JSON.stringify({cur,prev,windowDays:30},null,2));
}
main().catch(e=>{console.error(e);process.exit(1);});
