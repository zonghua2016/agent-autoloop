const running = item => item?.run?.state === 'claimed' && !item.run.stopping;

export function agentBrand(agent, id) {
  const use = agent?.use?.toLowerCase();
  if (use === 'codex') return 'codex';
  if (use === 'dsh' || use === 'deepseek') return 'deepseek';
  if (use === 'gemini') return 'gemini';
  if (use && use !== 'command') return 'robot';
  const configured = [agent?.id ?? id, agent?.name].filter(Boolean).join(' ');
  if (/\b(?:deepseek|dsh)\b/i.test(configured)) return 'deepseek';
  if (/\bgemini\b/i.test(configured)) return 'gemini';
  if (/\bcodex\b/i.test(configured)) return 'codex';
  return 'robot';
}

export function agentRole(item, entries, scheduled) {
  if (item?.run?.claimedAt) {
    return {brand:item.brand, name:item.agent, active:running(item), previous:false};
  }
  let latest = null;
  for (const candidate of entries) {
    if (candidate.station !== 'result' || (candidate.workStation??runStation(candidate.run,{use:candidate.brand},candidate.scheduled)) !== (scheduled?'patrol':'coder') || !candidate.run?.claimedAt) continue;
    if (!latest || Date.parse(candidate.run.claimedAt) > Date.parse(latest.run.claimedAt)) latest = candidate;
  }
  return latest
    ? {brand:latest.brand, name:latest.agent, active:false, previous:true}
    : {brand:null,name:null,active:false,previous:false};
}

export function feishuDelivery(hasFeishu, cards) {
  return hasFeishu && cards.some(card => card.kind === 'ask' && card.state === 'open');
}

export function runStation(run,agent,scheduled){
  const brand=agentBrand(agent,run.agent);
  if(['deepseek','gemini'].includes(brand)||/personal.*(?:plan|improve|chat|feedback)|个人.*(?:论证|复盘|聊天|反馈)/i.test(run.rule))return 'think';
  return scheduled?'patrol':'coder';
}

export function thinkRoles(entries,snapshot){
  const role={deepseek:false,gemini:false,dual:false};
  for(const item of entries)if(item.station==='think'&&running(item)){
    if(item.brand==='deepseek'||item.brand==='gemini')role[item.brand]=true;
    // A planner invokes both reviewers even when its outer adapter is command.
    if(/personal.*plan|个人.*论证/i.test(item.run.rule))role.deepseek=role.gemini=true;
  }
  role.dual=role.deepseek&&role.gemini;return role;
}
