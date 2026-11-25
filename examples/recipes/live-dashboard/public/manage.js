let session;
export const ready=fetch('/api/session',{credentials:'same-origin'}).then(response=>{if(!response.ok)throw Error('无法读取管理权限');return response.json();}).then(value=>{
  if(!value.authenticated){location.replace('/');throw Error('请重新登录');}
  session=value;document.querySelector('.demo').textContent=value.writable?'本机管理 · 可写':'本机只读';return value;
}).catch(()=>{document.querySelector('.demo').textContent='管理连接不可用';return {writable:false,error:true};});
const el=(tag,text)=>{const node=document.createElement(tag);if(text)node.textContent=text;return node;};
export function links(text){
  const fragment=document.createDocumentFragment();let position=0;
  for(const match of String(text).matchAll(/https:\/\/[^\s<>"'））]+/g)){
    fragment.append(document.createTextNode(text.slice(position,match.index)));
    const a=el('a',match[0]);a.href=match[0];a.target='_blank';a.rel='noopener noreferrer';fragment.append(a);position=match.index+match[0].length;
  }
  fragment.append(document.createTextNode(String(text).slice(position)));return fragment;
}
export async function controls(parent,actions,refresh){
  const area=el('section');area.className='management';parent.append(area);
  const access=await ready;if(!area.isConnected)return;if(!access.writable){area.append(el('p',access.error?'管理连接不可用，请刷新页面重试':'当前为只读模式'));return;}
  for(const action of actions){
    const form=el('form'),title=el('strong',action.title),submit=el('button',action.title),result=el('p');submit.type='submit';result.role='status';
    form.append(title);form.addEventListener('input',()=>form.dataset.dirty='true');
    const inputs=[];
    for(const field of action.fields??[]){
      const label=el('label',field.label),input=el(field.options?'select':field.multiline?'textarea':'input');
      input.name=field.name;input.required=field.required??false;
      if(field.options)field.options.forEach((value,index)=>{const option=el('option',value);option.value=index;input.append(option);});
      else {if(input.tagName==='INPUT')input.type=field.type??'text';input.maxLength=field.maxLength??1000;input.placeholder=field.placeholder??'';if(field.pattern)input.pattern=field.pattern;if(field.hint)input.title=field.hint;}
      label.append(input);form.append(label);inputs.push([field,input]);
    }
    form.append(submit,result);area.append(form);
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(submit.disabled)return;
      const body={...action.body};
      for(const [field,input] of inputs){if(input.value.trim())body[field.name]=field.options?Number(input.value):field.type==='datetime-local'?new Date(input.value).toISOString():input.value.trim();}
      form.dataset.submitting='true';submit.disabled=true;result.textContent='正在提交…';
      try{
        const response=await fetch(action.path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Origin:location.origin,'X-Autoloop-CSRF':session.csrf},body:JSON.stringify(body),signal:AbortSignal.timeout(11000)});
        let data;try{data=await response.json();}catch{throw Error('服务返回异常，提交结果未知，请刷新核对');}
        if(!response.ok){const error=Error(data.error??'提交失败');error.retryable=response.status>=400&&response.status<500;throw error;}
        result.textContent=data.cardSync?'任务已取消，原卡片等待通道同步':data.changed===false?'状态未改变，请查看最新记录':'请求已受理，正在刷新状态';
        for(const current of area.querySelectorAll('form')){current.dataset.dirty='';current.dataset.submitted='true';}if(area.contains(document.activeElement))document.activeElement.blur();for(const button of area.querySelectorAll('button'))button.disabled=true;
        delete form.dataset.submitting;showResult(result.textContent);await refresh();
      }catch(error){result.textContent=error.name==='TimeoutError'||error instanceof TypeError?'提交结果未知，请刷新状态核对，勿重复提交':error.message;if(error.retryable)submit.disabled=false;showResult(result.textContent);}
      finally{delete form.dataset.submitting;}
      // A submitted form is intentionally not rearmed after an uncertain network result.
    });
  }
}
export function runActions(id){return [{title:'停止本轮',path:`/api/runs/${id}/cancel`}];}
export function cardActions(card){
  const actions=[];
  if(card.kind==='ask'){
    if(card.options?.length)actions.push({title:'提交选项回答',path:`/api/cards/${card.id}/answer`,fields:[{name:'choice',label:'回答',options:card.options}]});
    actions.push({title:'提交文字回答',path:`/api/cards/${card.id}/answer`,fields:[{name:'text',label:'回答内容',multiline:true,required:true,maxLength:3500}]});
  }
  actions.push({title:'结案',path:`/api/cards/${card.id}/resolve`,fields:[{name:'reason',label:'处理结果',required:true}]});return actions;
}
export function ruleActions(rule){
  const path=`/api/rules/${encodeURIComponent(rule.id)}/`;
  return [rule.paused?{title:'恢复规则',path:path+'resume'}:{title:'暂停规则',path:path+'pause',fields:[{name:'reason',label:'暂停原因',required:true},{name:'until',label:'自动恢复时间（可不填）',type:'datetime-local'}]},
    {title:'立即运行',path:path+'run',fields:[{name:'subject',label:'事项标识（可不填）',pattern:'[A-Za-z0-9#._:\\/@\\-]*',placeholder:'例如 task-123',hint:'只用英文字母、数字和 # . _ : / @ -'},{name:'reason',label:'运行原因（可不填）'}]},
    ...(rule.every||rule.source==='schedule'?[]:[{title:'补跑暂停期间事件',path:path+'replay',fields:[{name:'since',label:'从何时开始',type:'datetime-local',required:true}]}])];
}

function showResult(text){let banner=document.getElementById('management-result');if(!banner){banner=el('p');banner.id='management-result';banner.role='status';document.querySelector('.panel-head').after(banner);}banner.textContent=text;}

const logout=document.getElementById('logout');
logout?.addEventListener('click',async()=>{
  logout.disabled=true;
  try {
    const access=await fetch('/api/session',{credentials:'same-origin',signal:AbortSignal.timeout(11000)}).then(response=>{if(!response.ok)throw Error();return response.json();});
    if(!access.authenticated){location.replace('/');return;}
    const response=await fetch('/api/logout',{method:'POST',headers:{'X-Autoloop-CSRF':access.csrf},signal:AbortSignal.timeout(11000)});
    if(!response.ok&&response.status!==401)throw Error();
    location.replace('/');
  }catch{logout.disabled=false;logout.textContent='退出失败，重试';}
});
