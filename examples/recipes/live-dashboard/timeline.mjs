const fields = (row, keys) => Object.fromEntries(keys.map(key => [key,row?.[key]??null]));
const cardFields = ['id','kind','state','title','text','options','answer','choice','result','rule','createdAt','decidedAt','closedAt','runId','lane','about'];
export const publicCard = card => fields(card,cardFields);

export function publicChange(seq,fact) {
  const decode=value=>{if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{return null;}};
  const runs=[],touched=new Set(),events=new Map(),links=new Map();
  for(const {table,row} of fact?.changes??[]) {
    if(!row)continue;
    if(table==='events')events.set(row.id,fields(row,['source','type','subject','summary']));
    if(table==='run_events'&&Number.isSafeInteger(row.run_id)){
      touched.add(row.run_id);
      if(!links.has(row.run_id))links.set(row.run_id,[]);
      links.get(row.run_id).push(row.event_id);
    }
    if(table==='cards'&&Number.isSafeInteger(row.run_id))touched.add(row.run_id);
  }
  for(const {table,row} of fact?.changes??[]) {
    if(table!=='runs'||!Number.isSafeInteger(row?.id))continue;
    touched.add(row.id);
    const related=(links.get(row.id)??[]).map(id=>events.get(id)).filter(Boolean);
    runs.push({
      ...fields(row,['id','rule','agent','state','attempts','summary','error','link','manual']),usage:decode(row.usage),
      createdAt:row.created_at,claimedAt:row.claimed_at,finishedAt:row.finished_at,notBefore:row.not_before,
      stopping:row.cancel_at!=null,...(related.length?{events:related}:{})
    });
  }
  const changes=(fact?.changes??[]);
  const cards=changes.filter(change=>change.table==='cards').map(({key,row})=>row?publicCard({...row,runId:row.run_id,createdAt:row.created_at,decidedAt:row.decided_at,closedAt:row.closed_at,options:decode(row.options)}):{id:key,removed:true});
  const timers=changes.filter(change=>change.table==='timers').map(({key,row})=>row?fields(row,['id','rule','lane','about','at']):{id:key,removed:true});
  const pauses=changes.filter(change=>change.table==='pauses').map(({key,row})=>row?fields(row,['name','by','reason','since','until']):{name:key,removed:true});
  const unrouted=changes.filter(change=>change.table==='events'&&(!change.row||decode(change.row.routed)?.length===0)).map(({key,row})=>row?fields(row,['id','source','type','subject','summary','received_at']):{id:key,removed:true});
  return {seq,runs,cards,timers,pauses,unrouted,touched:[...touched], changed:[...new Set((fact?.changes??[]).map(change=>change.table).filter(table=>['cards','timers','pauses','events'].includes(table)))]};
}

export function publicSnapshot(state) {
  const list = value => Array.isArray(value)?value:[];
  return {
    ...fields(state,['seq','now','timezone','totals','hasMore','nextBefore','spending','pauses','skipped','elsewhere']),
    runs:list(state.runs).map(run=>({
      ...fields(run,['id','rule','agent','state','attempts','createdAt','claimedAt','finishedAt','notBefore','summary','error','stopping','usage','link','manual']),
      events:list(run.events).map(event=>fields(event,['source','type','subject','summary']))
    })),
    cards:list(state.cards).map(publicCard),
    recentCards:list(state.recentCards).map(publicCard),
    agents:list(state.agents).map(agent=>fields(agent,['id','name','use','worker','online','seenAt','totals'])),
    channels:list(state.channels).map(channel=>fields(channel,['id','name','online','seenAt','lastFailure'])),
    sources:list(state.sources).map(source=>fields(source,['id','name','events'])),
    lines:list(state.lines).map(rule=>fields(rule,['id','name','agent','source','every','next','paused','totals','skippedAt'])),
    timers:list(state.timers).map(timer=>fields(timer,['rule','lane','about','at'])),
    unrouted:list(state.unrouted).map(event=>fields(event,['id','source','type','subject','summary','received_at','receivedAt']))
  };
}

function optionOf(card) {
  if(card.answer!=null)return card.answer;
  try{return JSON.parse(card.options??'[]')[card.choice]??'';}catch{return '';}
}
const changed = (row,before,field) => row[field]!=null&&row[field]!==before?.[field];
const labels = {done:'本轮完成',nothing:'检查结束，无须处理',cancelled:'本轮停止'};
export function projectTimeline(id,facts) {
  const events=new Set(), emitted=new Set(), rows=[], ownCards=new Map(), previous=new Map(), agents=new Map(), started=new Set();
  for(const fact of facts) {
    for(const {table,row} of fact.changes??[]) {
      if(table==='run_events'&&row?.run_id===id)events.add(row.event_id);
      if(table==='runs'&&row?.id===id){try{for(const event of typeof row.emitted==='string'?JSON.parse(row.emitted):row.emitted??[])emitted.add(event);}catch{}}
      if(fact.type==='rules'&&table==='config'&&row?.value?.agents)agents.set(fact.seq,row.value.agents);
    }
  }
  const add=(at,title,detail='',extra={})=>{if(at!=null)rows.push({at,title,detail,...extra});};
  for(const fact of facts) {
    const changes=fact.changes??[];
    const runChanged=changes.some(change=>change.table==='runs'&&change.row?.id===id);
    for(const {table,key,row} of changes) {
      if(!row)continue;
      const index=table+':'+key;
      const before=previous.get(index);
      if(table==='events'&&emitted.has(row.id)&&!before)add(row.received_at??fact.at,'回执发出后续事件',[row.type,row.subject,row.summary].filter(Boolean).join(' · '));
      if(table==='events'&&events.has(row.id)&&!before) {
        add(row.received_at??fact.at,'收到事件',[row.source,row.type,row.subject,row.summary].filter(Boolean).join(' · '));
      }
      if(table==='runs'&&row.id===id) {
        const agent=agents.get(row.rules_version)?.[row.agent];
        if(!before)add(row.created_at??fact.at,'进入队列',[row.rule,row.rules_version?'规则版本 #'+row.rules_version:''].filter(Boolean).join(' · '));
        if(changed(row,before,'claimed_at'))add(row.claimed_at,'接单程序领取',[agent?.name??row.agent,agent?.worker].filter(Boolean).join(' · '));
        if(fact.type==='started'&&!started.has(row.issued)) {
          started.add(row.issued);add(fact.at,'Agent 开始处理');
        }
        if(row.state==='unknown'&&before?.state!=='unknown')add(fact.at,'执行状态待确认','中台未收到近期心跳，仍可能在执行。');
        if(row.cancel_at!=null&&row.cancel_at!==before?.cancel_at)add(fact.at,'收到停止请求');
        if(row.state==='queued'&&row.attempts>0&&row.attempts!==before?.attempts) {
          add(fact.at,'本次未完成，等待重试',row.error??'',{retryAt:row.not_before});
        }
        if(changed(row,before,'link'))add(fact.at,'会话链接',row.link);
        if(changed(row,before,'usage'))add(fact.at,'本轮用量',typeof row.usage==='string'?row.usage:JSON.stringify(row.usage));
        if(changed(row,before,'finished_at'))add(row.finished_at,labels[row.state]??'收到回执',row.summary||row.error||'');
      }
      if(table==='cards'&&(row.run_id===id||events.has(row.answer_event))) {
        if(row.run_id===id)ownCards.set(row.id,row.state);
        if(!before&&row.run_id===id)add(row.created_at??fact.at,row.kind==='ask'?'提交提问卡片':'提交通知卡片',row.title??'',{cardId:row.id});
        if(changed(row,before,'decided_at'))add(row.decided_at,'收到回答',[row.title,optionOf(row)].filter(Boolean).join(' · '),{cardId:row.id});
        if(changed(row,before,'closed_at'))add(row.closed_at,'卡片结案',[row.title,row.result].filter(Boolean).join(' · '),{cardId:row.id});
      }
      if(table==='timers'&&runChanged&&fact.type==='finish'&&!before)add(fact.at,'安排复查',row.about??'',{retryAt:row.at});
      previous.set(index,row);
    }
  }
  const when = value => typeof value==='number'?value:Date.parse(value);
  rows.sort((a,b)=>when(a.at)-when(b.at));
  return {rows,cards:[...ownCards.keys()]};
}
