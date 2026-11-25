import {agentBrand,runStation} from './roles.js';
import {controls,runActions,cardActions,ruleActions,links} from './manage.js';

const q=id=>document.getElementById(id);
const activeStates=new Set(['queued','claimed','unknown']);
const editing=container=>!!container.querySelector('form[data-dirty=true],form[data-submitting=true]')||!!(container.contains(document.activeElement)&&document.activeElement.matches('input,textarea,select')&&!document.activeElement.closest('form[data-submitted=true]'));
const clearResult=()=>q('management-result')?.remove();
const filters={active:'进行中',asks:'待处理卡片',finished:'最近结束',unrouted:'未分派',feishu:'飞书事项',health:'规则与健康'};
const stateLabels={done:'完成',nothing:'检查结束',cancelled:'已结束',claimed:'执行中',unknown:'状态待确认',queued:'等待接单'};
let snapshot=null, entries=[], selected=null, pinnedSelection=false, filter='active', stationFilter=null, stream=null, updating=false, pending=false, dirty=0;
let loadingTimer, detailTimer, lastUpdate='正在连接中台', detailRequest=0, panelView='list', olderBefore=null, olderRuns=[];
let workView=null,workError='',workRequest=false,workPending=false,selectedWork=null,workRendered=null,workListRendered=null;
let detailRendered=null,detailPending=false,detailKey=null;
const listeners=new Set(), overlays=new Map(),workTimelines=new Map();
const panel=q('live-panel');
const rows=q('live-list');
const body=q('live-detail');
const stations={intake:'事件入口',hub:'调度中台',think:'智囊池',coder:'接单站',patrol:'巡检站',card:'卡片站',result:'结果归档'};
function time(value,precise=false) {
  if(value==null)return '—';
  const date=new Date(value);
  if(!Number.isFinite(+date))return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN',{timeZone:snapshot?.timezone??undefined,month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',...(precise&&{fractionalSecondDigits:3})}).format(date);
  }catch{return date.toLocaleString('zh-CN');}
}
const node=(tag,value,className)=>{
  const element=document.createElement(tag);
  if(value!=null)element.textContent=value;
  if(className)element.className=className;
  return element;
};
const askCards=()=>snapshot?.cards.filter(card=>card.kind==='ask'&&card.state==='open')??[];
const readableError=err=>['AbortError','TimeoutError'].includes(err?.name)?'查询超时':err?.message||'暂时无法读取';
async function json(path) {
  const response=await fetch(path,{credentials:'same-origin',signal:AbortSignal.timeout(11000)});
  if(response.status===401){location.replace('/');throw Error('请重新登录');}
  let data;try{data=await response.json();}catch{throw Error('服务暂时无法返回有效记录');}
  if(!response.ok)throw Error(data.error??'读取失败');
  return data;
}
function runEntry(run) {
  const rule=snapshot.lines.find(x=>x.id===run.rule);
  const agent=snapshot.agents.find(x=>x.id===run.agent);
  const scheduled=rule?.source==='schedule'||run.events.some(event=>event.type==='schedule.tick');
  const future=run.notBefore&&Date.parse(run.notBefore)>Date.parse(snapshot.now);
  const retry=run.state==='queued'&&run.attempts>0;
  const subject=run.events.find(event=>event.subject)?.subject;
  let label=stateLabels[run.state]??run.state, reason=[run.summary,run.error].filter(Boolean).join(' · ')||'中台未记录更多结论。';
  if(run.state==='queued') {
    if(rule?.paused){label='规则暂停';reason=rule.paused.reason||'这条规则暂停中，恢复后才会领取。';}
    else if(retry){label=future?'等重试':'可重新领取';reason=[run.error,future?'下次可领取 '+time(run.notBefore):'已经到了重试时间，等待接单。'].filter(Boolean).join(' · ');}
    else if(agent?.online===false){label='接单设备未在线';reason=[agent.worker,'尚未上线或中台没有近期心跳。'].filter(Boolean).join(' · ');}
    else reason='已进入队列，等待接单。中台状态没有给出更具体的排队原因。';
  }
  if(run.state==='claimed')reason=[agent?.name??run.agent,agent?.worker,run.claimedAt?'领取于 '+time(run.claimedAt):null].filter(Boolean).join(' · ');
  if(run.state==='unknown')reason='中台没有收到这一轮的近期心跳，仍可能在执行。';
  if(run.stopping){label='正在停止';reason='已请求停止，等待接单程序确认。';}
  const workStation=runStation(run,agent,scheduled);
  const station=!activeStates.has(run.state)?'result':run.state==='queued'?'hub':workStation;
  return {key:'run:'+run.id,id:run.id,type:'run',title:run.rule+(subject?' · '+subject:''),label,reason,station,
    scheduled,workStation,agent:agent?.name??run.agent,brand:agentBrand(agent,run.agent),at:run.finishedAt??run.claimedAt??run.createdAt,run};
}
function cardEntry(card) {
  const failures=snapshot.channels.filter(channel=>channel.lastFailure?.card===card.id);
  const issue=failures.map(channel=>channel.name+'：'+(channel.lastFailure.givenUp?'已停止重试 · ':'投递失败 · ')+channel.lastFailure.error);
  return {key:'card:'+card.id,id:card.id,type:'card',title:card.title,label:['done','answered'].includes(card.state)?'已回答':card.state==='closed'?'已结案':card.kind==='ask'?'等你回答':'待处理通知',station:'card',at:card.createdAt,card,
    reason:issue.length?issue.join('；'):card.text||'这张提问卡片仍未回答。'};
}
function eventEntry(event) {
  return {key:'event:'+event.id,id:event.id,type:'event',title:[event.type,event.subject].filter(Boolean).join(' · '),
    label:'未分派',reason:event.summary||'中台收到事件，但未分派到轮次。',station:'intake',at:event.receivedAt??event.received_at,event};
}
const entryFor=key=>entries.find(item=>item.key===key)??(snapshot?.recentCards??[]).filter(card=>'card:'+card.id===key).map(cardEntry)[0];
const getSelected=()=>entryFor(selected);
const labelFor=item=>(item.type==='run'?'第 '+item.id+' 轮':item.type==='card'?'卡片 #'+item.id:'事件 #'+item.id);

function useSnapshot(data) {
  if(!Number.isSafeInteger(data.seq))throw Error('中台状态没有日志序号');
  const previous=snapshot?entries:[];
  const first=!snapshot||data.seq<snapshot.seq;
  if(first){olderRuns=[];olderBefore=data.nextBefore;overlays.clear();}
  snapshot=data;
  for(const [id,patch] of overlays)if(patch.seq<=data.seq)overlays.delete(id);
  const runs=new Map(data.runs.map(run=>[run.id,run]));
  for(const [id,patch] of overlays)runs.set(id,patch.run);
  entries=[
    ...[...runs.values()].sort((a,b)=>b.id-a.id).map(runEntry),
    ...olderRuns.filter(run=>!runs.has(run.id)).map(runEntry),
    ...(data.cards??[]).map(cardEntry),...data.unrouted.map(eventEntry)
  ];
  if(!pinnedSelection||(!entryFor(selected)&&panelView!=='detail')){
    pinnedSelection=false;
    selected=(entries.find(item=>item.type==='card')
      ??entries.find(item=>item.type==='run'&&activeStates.has(item.run.state))
      ??entries.find(item=>item.type==='run')
      ??entries[0])?.key??null;
  }
  renderSummary();
  if(!panel.hidden&&panelView==='list'&&!editing(rows))renderList();
  if(!panel.hidden&&panelView==='detail') {
    const now=getSelected();
    if(detailKey===selected&&!editing(body)&&now&&(detailPending||detailRendered!==JSON.stringify(now)))refreshDetailSoon();
  }
  for(const listener of listeners)listener({first,entries,previous,selected,snapshot});
}
function renderSummary() {
  const item=getSelected(), data=snapshot;
  q('connection').textContent=lastUpdate;
  if(data) {
    const counts=data.totals??{};
    q('scene-state').textContent=[
      (counts.running??0)+' 执行中',(counts.queued??0)+' 排队',askCards().length+' 待回答',
      counts.retrying?counts.retrying+' 等重试':'',counts.unknown?counts.unknown+' 待确认':''
    ].filter(Boolean).join(' · ');
    q('snapshot-time').textContent='快照 '+time(data.now);
    const usage=data.spending?.today;q('health-summary').textContent=`${data.agents.filter(agent=>agent.online).length}/${data.agents.length} 接单在线${usage?' · 今日 '+usage.tokens+' tokens':''}`;
  }
  q('object').textContent=item?labelFor(item):'当前中台';
  q('status').textContent=item?.label??(data?'暂无轮次':'正在连接');
  q('detail').textContent=item?[item.title,item.reason].filter(Boolean).join(' · '):lastUpdate;
  q('history').disabled=!item;
  q('follow').disabled=!item;
}
function status(text) {lastUpdate=text;renderSummary();}
function refreshDetailSoon() {
  if(detailKey!==selected)return;
  detailPending=true;
  if(detailTimer)return;
  const key=selected;
  detailTimer=setTimeout(()=>{
    detailTimer=null;
    if(!panel.hidden&&panelView==='detail'&&detailKey===selected&&selected===key&&getSelected()&&!editing(body))renderDetail(getSelected());
  },100);
}
function acceptChange(change) {
  if(!snapshot||!Number.isSafeInteger(change.seq)||change.seq<=dirty)return;
  dirty=change.seq;
  const transitions=[];
  if(change.cards?.length){for(const listener of listeners)listener({cardChanges:change.cards,entries});}
  for(const patch of change.runs??[]) {
    const old=overlays.get(patch.id)?.run??entryFor('run:'+patch.id)?.run;
    const run={...old,...patch,events:patch.events??old?.events??[]};
    transitions.push(runEntry(run));
    if(change.seq>snapshot.seq)overlays.set(run.id,{seq:change.seq,run});
  }
  if(transitions.length) {
    for(const listener of listeners)listener({transitions});
    if(change.seq>snapshot.seq)useSnapshot(snapshot);
  }
  const item=getSelected();
  if(!panel.hidden&&panelView==='detail'&&item?.type==='run'&&change.touched?.includes(item.id))refreshDetailSoon();
  if(dirty>snapshot.seq&&!loadingTimer)loadingTimer=setTimeout(()=>{loadingTimer=null;refresh();},480);
}
function subscribe(seq) {
  stream?.close();
  dirty=Math.max(dirty,seq);
  stream=new EventSource('/api/changes?after='+seq);
  stream.onopen=()=>status('实时连接');
  stream.onerror=()=>status('事件流重连中');
  stream.addEventListener('reset',()=>refresh());
  stream.addEventListener('offline',()=>status('中台事件流重连中'));
  stream.addEventListener('change',event=>{
    try{acceptChange(JSON.parse(event.data));}catch {}
  });
}
async function refresh() {
  if(updating){pending=true;return updating;}
  updating=(async()=>{try{do{pending=false;try {
    const data=await json('/api/state');
    const reset=snapshot&&data.seq<snapshot.seq;
    if(reset)dirty=data.seq;
    useSnapshot(data);
    if(!stream||reset)subscribe(data.seq);
    else if(stream.readyState===EventSource.CLOSED)subscribe(dirty);
    else if(stream.readyState===EventSource.OPEN)status('实时连接');
    if(!snapshot?.hasMore&&olderRuns.length===0)olderBefore=null;
  } catch(error) {
    status(readableError(error)+(snapshot?' · 显示上次快照':''));
  }}while(pending);}finally{updating=false;}})();
  return updating;
}
function relevant(item) {
  if(['coder','patrol','think'].includes(stationFilter))return item.type==='run'&&item.station!=='hub'&&item.workStation===stationFilter;
  return !stationFilter||item.station===stationFilter;
}
function matching(item) {
  if(!relevant(item)||!searchMatch(item))return false;
  if(filter==='active')return item.type==='run'&&activeStates.has(item.run.state);
  if(filter==='finished')return item.type==='run'&&!activeStates.has(item.run.state);
  return item.type===(filter==='asks'?'card':'event');
}
function renderList() {
  detailRequest++;
  panelView='list';q('detail-shell').hidden=true;rows.hidden=false;q('list-controls').hidden=false;
  q('panel-title').textContent=stationFilter?stations[stationFilter]:'轮次与待办';
  q('clear-station').hidden=!stationFilter;
  for(const tab of panel.querySelectorAll('[data-filter]')){tab.setAttribute('aria-pressed',String(tab.dataset.filter===filter));const kind=tab.dataset.filter;tab.textContent=filters[kind]+' '+(kind==='health'?(snapshot?.lines.length??0):kind==='feishu'?(workView?.items.length??0):entries.filter(item=>kind==='active'?item.type==='run'&&activeStates.has(item.run.state):kind==='finished'?item.type==='run'&&!activeStates.has(item.run.state):item.type===(kind==='asks'?'card':'event')).length);}
  if(filter==='health'){renderHealth();return;}
  if(filter==='feishu'){
    renderWorkList();
    return;
  }
  const shown=entries.filter(matching);
  const summary=[];
  if(stationFilter==='patrol') {
    const scheduled=snapshot?.lines.filter(rule=>rule.source==='schedule')??[];
    const next=scheduled.filter(rule=>!rule.paused&&rule.next).sort((a,b)=>Date.parse(a.next)-Date.parse(b.next))[0];
    if(next)summary.push('下次定时：'+next.name+' · '+time(next.next));
  }
  if(stationFilter==='card'){
    for(const channel of snapshot?.channels??[])summary.push(channel.name+(channel.online?'在线':'未报到')+' · 在线状态不代表卡片已经送达');
  }
  if(stationFilter==='intake')summary.push((snapshot?.sources.length??0)+' 个来源 · 未分派列表为中台最近记录');
  if(stationFilter==='coder')summary.push('接单程序和 Agent 名称来自真实轮次');
  const output=summary.map(line=>node('p',line,'panel-note'));
  if(!shown.length)output.push(node('p',snapshot?'暂无'+filters[filter]+'记录':lastUpdate,'panel-note'));
  for(const item of shown) {
    const button=node('button',null,'live-row');button.type='button';
    button.append(node('small',labelFor(item)+' · '+item.label),node('strong',item.title),node('span',time(item.at)+' · '+item.reason));
    button.addEventListener('click',()=>select(item.key,true));
    output.push(button);
  }
  if(filter==='finished'&&olderBefore!=null) {
    const more=node('button','查看更多历史轮次');more.type='button';more.addEventListener('click',async()=>{
      more.disabled=true;
      try {
        const older=await json('/api/state?before='+olderBefore);
        olderRuns.push(...older.runs);olderBefore=older.nextBefore;
        if(snapshot){const current=snapshot;useSnapshot(current);}
      }catch(error){more.textContent='加载失败，点此重试';more.disabled=false;}
    });output.push(more);
  }
  rows.replaceChildren(...output);
}
function section(title,text,where) {
  const block=node('section',null,'detail-section');const paragraph=node('p');paragraph.append(links(text??''));block.append(node('h3',title),paragraph);where.append(block);
}
function renderWorkList() {
  panel.querySelector('[data-filter=feishu]').textContent=filters.feishu+' '+(workView?.items.length??0);
  const output=[];
  if(workError)output.push(node('p',workError,'panel-note'));
  if(workView?.available===false)output.push(node('p','当前本机配置没有可读取的个人事项。','panel-note'));
  if(!workView&&!workError)output.push(node('p','正在读取飞书事项…','panel-note'));
  if(workView?.available&&workView.hubReachable===false)output.push(node('p','中台暂时不可达，显示已保存的状态。','panel-note'));
  if(workView?.intake){
    const info=workView.intake;
    output.push(node('p',info.state==='unavailable'?'最近一条消息：模型处理暂不可用 · '+time(info.at):
      '最近一条消息：已理解'+(info.model?' · '+({dsh:'DeepSeek',codex:'Codex'}[info.model]??info.model):'')+' · '+time(info.at),'panel-note'));
  }
  if(workView?.available&&!workView.items.length)output.push(node('p','暂无提醒或项目任务。','panel-note'));
  for(const item of (workView?.items??[]).filter(searchMatch)){
    const button=node('button',null,'live-row');button.type='button';
    const label=item.kind==='reminder'?'提醒':'项目任务';
    button.append(node('small',label+' · '+item.state),node('strong',item.title),
      node('span',item.scheduledAt?time(item.scheduledAt):item.reason??item.id));
    button.addEventListener('click',()=>{selectedWork=item.id;renderWorkDetail();});
    output.push(button);
  }
  rows.replaceChildren(...output);workListRendered=JSON.stringify([workView,workError]);
}
function renderWorkDetail() {
  const item=workView?.items.find(value=>value.id===selectedWork);
  if(!item)return renderList();
  detailRequest++;panelView='work-item';rows.hidden=true;q('detail-shell').hidden=false;q('list-controls').hidden=true;
  q('panel-title').textContent=item.title;
  const output=document.createDocumentFragment();
  section(item.state,[item.project,item.id,item.reason].filter(Boolean).join(' · '),output);
  if(item.scheduledAt)section('提醒时间',time(item.scheduledAt),output);
  for(const step of item.activity??[])section(step.label,time(step.at),output);
  if(item.run){
    const cached=workTimelines.has(item.run);
    const link=node('button',(cached?'已读取中台轮次 #':'查看中台轮次 #')+item.run);link.type='button';link.disabled=cached;
    link.addEventListener('click',async()=>{
      const known=entries.find(entry=>entry.type==='run'&&entry.run.id===item.run);
      if(known){select(known.key,true);return;}
      link.disabled=true;
      try{
        const result=await json('/api/runs/'+item.run);workTimelines.set(item.run,result.rows??[]);
        if(panelView!=='work-item'||selectedWork!==item.id||!link.isConnected)return;
        const steps=document.createDocumentFragment();
        for(const step of result.rows??[])section(step.title,[time(step.at),step.detail].filter(Boolean).join(' · '),steps);
        if(!steps.childNodes.length)steps.append(node('p','这轮暂无事实记录。','panel-note'));
        link.after(steps);
        link.textContent='已读取中台轮次 #'+item.run;
      }catch{link.textContent='加载失败，点此重试';link.disabled=false;}
    });
    output.append(link);
  }
  body.replaceChildren(output);workRendered=JSON.stringify(item);
  if(item.cancellable)controls(body,[{title:'取消待确认事项',path:'/api/work-items/'+item.id+'/cancel',body:{channel:item.channel}}],refreshWorkItems);
  const cached=workTimelines.get(item.run);
  if(cached)for(const step of cached) section(step.title,[time(step.at),step.detail].filter(Boolean).join(' · '),body);
}
async function refreshWorkItems() {
  if(panel.hidden||filter!=='feishu'||panelView==='detail')return;
  if(workRequest){workPending=true;return workRequest;}
  workRequest=(async()=>{try{do{workPending=false;try{
    const next=await json('/api/work-items');
    workView=next;workError='';
    const project=q('project-filter'),value=project.value;project.replaceChildren(new Option('全部项目',''),...[...new Set(next.items.map(item=>item.project).filter(Boolean))].map(name=>new Option(name,name)));project.value=value;
    if(!workPending&&!panel.hidden&&filter==='feishu'){
      const item=next.items.find(value=>value.id===selectedWork);
      if(panelView==='work-item'&&!editing(body)&&workRendered!==JSON.stringify(item))renderWorkDetail();
      if(panelView==='list'&&workListRendered!==JSON.stringify([workView,workError]))renderWorkList();
    }
  }catch(error){
    workError=readableError(error);
    if(!panel.hidden&&filter==='feishu'&&panelView==='list')renderWorkList();
  }}while(workPending);}finally{workRequest=false;}})();
  return workRequest;
}
async function renderDetail(item) {
  const request=++detailRequest;
  panelView='detail';rows.hidden=true;q('detail-shell').hidden=false;q('list-controls').hidden=true;
  q('panel-title').textContent=labelFor(item);
  const header=node('div',null,'detail-heading');
  header.append(node('span',item.label,'live-badge'),node('h3',item.title),node('p',item.reason));
  body.replaceChildren(header);detailKey=item.key??item.type+':'+item.id;detailRendered=JSON.stringify(item);detailPending=false;
  if(item.type==='run'&&['queued','claimed'].includes(item.run?.state)&&!item.run.stopping)controls(body,runActions(item.id),refresh);
  if(item.type==='run'){const copy=node('button','复制轮次查询命令');copy.type='button';copy.onclick=async()=>{try{await navigator.clipboard.writeText('agent-autoloop why '+item.id);copy.textContent='查询命令已复制';}catch{copy.textContent='复制失败，请使用本页时间线';}};body.append(copy);}
  if(item.run?.usage)section('本轮用量',JSON.stringify(item.run.usage),body);
  if(item.run?.link)section('会话链接',item.run.link,body);
  if(item.type==='run'&&item.agent)section('接单 Agent',item.agent,body);
  if(item.type==='event') {
    section('收到时间',time(item.at),body);
    section('事件来源',item.event.source??'—',body);return;
  }
  const loading=node('p','正在读取时间线…','panel-note');body.append(loading);
  try {
    const data=await json('/api/'+(item.type==='run'?'runs':'cards')+'/'+item.id);
    if(request!==detailRequest)return;
    loading.remove();
    if(item.type==='card') {
      if(data.card?.state==='open')controls(body,cardActions(data.card),refresh);
      section('卡片创建',time(item.at),body);
      if(data.card?.options?.length)section('可选项',data.card.options.join(' / '),body);
      if(data.runId) {
        const go=node('button','查看第 '+data.runId+' 轮');go.type='button';
        go.addEventListener('click',()=>{
          const run=entryFor('run:'+data.runId);
          if(run)select(run.key,true);
          else renderDetail({id:data.runId,type:'run',title:item.title,label:'历史轮次',reason:'与这张卡片关联的实际轮次。'});
        });body.append(go);
      } else {
        body.append(node('p','当前公开记录没有可核实的来源轮次。','panel-note'));
      }
    }
    const stepList=node('ol',null,'run-timeline');
    for(const step of data.rows??[]) {
      const row=node('li');const head=node('div');const stamp=node('time',time(step.at,true));
      const date=new Date(step.at);if(Number.isFinite(+date))stamp.dateTime=date.toISOString();
      head.append(stamp,node('strong',step.title));row.append(head);
      if(step.detail){const detail=node('p');detail.append(links(step.detail));row.append(detail);}
      if(step.retryAt)row.append(node('p','计划时间 '+time(step.retryAt)));
      if(step.cardId&&entryFor('card:'+step.cardId)) {
        const card=node('button','查看卡片 #'+step.cardId);card.type='button';card.addEventListener('click',()=>select('card:'+step.cardId,true));row.append(card);
      }
      stepList.append(row);
    }
    if(stepList.childElementCount)body.append(node('h3','时间线'),stepList);
    else if(item.type==='run')body.append(node('p','这轮暂无可展示的事实记录。','panel-note'));
  }catch(error){if(request===detailRequest)loading.textContent=readableError(error);}
}
function showPanel() {panel.hidden=false;q('browse').setAttribute('aria-expanded','true');}
function openList(next=null) {
  clearResult();stationFilter=next;detailRequest++;
  filter=next==='card'?'asks':next==='intake'?'unrouted':next==='result'?'finished':'active';
  showPanel();renderList();
}
function select(key,open=false) {
  const item=entryFor(key);
  if(!item)return;
  if(open&&panel.hidden) {
    stationFilter=null;
    filter=item.type==='card'?'asks':item.type==='event'?'unrouted':activeStates.has(item.run.state)?'active':'finished';
  }
  clearResult();selected=key;pinnedSelection=true;renderSummary();
  if(open){showPanel();renderDetail(getSelected());}
  for(const listener of listeners)listener({selection:true,selected,snapshot,entries});
}
panel.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{
  clearResult();filter=button.dataset.filter;
  if(filter==='feishu')stationFilter=null;
  renderList();
  if(filter==='feishu')refreshWorkItems();
}));
body.addEventListener('focusout',()=>setTimeout(()=>{
  const item=getSelected();
  if(!panel.hidden&&panelView==='detail'&&detailKey===selected&&item&&!editing(body)&&(detailPending||detailRendered!==JSON.stringify(item)))refreshDetailSoon();
},0));
q('task-search').addEventListener('input',renderList);q('project-filter').addEventListener('change',renderList);
q('clear-station').addEventListener('click',()=>openList());
q('browse').addEventListener('click',()=>openList());
q('live-close').addEventListener('click',()=>{
  clearResult();panel.hidden=true;detailRequest++;q('browse').setAttribute('aria-expanded','false');q('browse').focus();
});
q('live-back').addEventListener('click',()=>{clearResult();detailRequest++;renderList();});
q('history').addEventListener('click',()=>{if(selected)select(selected,true);});
setInterval(()=>{if(!document.hidden)refresh();},30000);
setInterval(()=>{if(!document.hidden)refreshWorkItems();},5000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
refresh();

export const live={
  add(listener) {
    listeners.add(listener);
    if(snapshot)listener({first:true,entries,selected,snapshot,previous:[]});
  },
  openList,select,getSelected
};

function searchMatch(item){
  const query=q('task-search').value.trim().toLowerCase(),project=q('project-filter').value;
  return (!query||JSON.stringify([item.title,item.reason,item.id,item.project,item.run?.rule]).toLowerCase().includes(query))&&(!project||item.project===project||item.run?.rule?.includes(project));
}
function renderHealth(){
  const opened=new Set([...rows.querySelectorAll('details[open]')].map(detail=>detail.dataset.rule));
  rows.replaceChildren();
  for(const [period,label] of [['today','今日'],['week','近七天']]){const usage=snapshot?.spending?.[period];if(usage)section(label+'用量',`${usage.rounds} 轮 · ${usage.tokens} tokens · $${Number(usage.cost).toFixed(4)} · ${usage.missingCost} 轮缺少费用记录`,rows);}
  for(const agent of snapshot?.agents??[])section(agent.name,`${agent.use} · ${agent.worker} · ${agent.online?'在线':'未报到'}`,rows);
  for(const channel of snapshot?.channels??[])section(channel.name,`${channel.online?'在线':'未报到'}${channel.lastFailure?' · '+channel.lastFailure.error:''}`,rows);
  for(const timer of snapshot?.timers??[])section('待复查 · '+timer.rule,[timer.about,time(timer.at)].filter(Boolean).join(' · '),rows);
  for(const external of snapshot?.elsewhere??[])section('外部定时 · '+external.name,[external.every,time(external.next)].join(' · '),rows);
  for(const pause of snapshot?.pauses??[])section('已暂停 · '+pause.name,[pause.reason,pause.until&&time(pause.until),pause.skipped&&'待补跑 '+pause.skipped.count+' 条'].filter(Boolean).join(' · '),rows);
  for(const rule of snapshot?.lines??[]){if(!searchMatch({title:rule.name,run:{rule:rule.id+' '+rule.name}}))continue;const detail=node('details');detail.dataset.rule=rule.id;detail.open=opened.has(rule.id);detail.append(node('summary',rule.name+' · '+(rule.paused?'暂停':'启用')));section('执行规则',[rule.agent,rule.every,rule.next&&time(rule.next),rule.paused?.reason].filter(Boolean).join(' · '),detail);rows.append(detail);controls(detail,ruleActions(rule),refresh);}
}
