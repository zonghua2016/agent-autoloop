import {Vector3,MathUtils} from 'three';
import {createParcel} from './models.js';
import {live} from './live.js';
import {agentRole,feishuDelivery,thinkRoles} from './roles.js';
import {rememberLabelSizes} from './label-layout.js';
const at={intake:['intake',0],hub:['intake',1],coder:['coder',1],think:['think',1],patrol:['patrol',1],card:['card',1],result:['result',1]};
const tagName=item=>(item.type==='run'?'#'+item.id:item.type==='card'?'卡片 '+item.id:'事件 '+item.id)+' · '+item.label;
export function makeLiveScene(scene,belts){
  const boxTags=document.getElementById('live-packages'),boxes=new Map(),latest=new Map(),queues=new Map(),names=new Map(),active=new Set(),counts={};
  const sizes=new WeakMap(),observer=new ResizeObserver(entries=>rememberLabelSizes(entries,sizes));
  let selection=null,roles={},hasFeishu=false;
  function box(){
    const parcel=createParcel(scene,.78);parcel.group.visible=false;
    const tag=document.createElement('button');tag.type='button';tag.className='package-tag';tag.hidden=true;
    const value={parcel,tag,item:null,motion:null};tag.onclick=()=>{if(value.item)live.select(value.item.key,true);};boxTags.append(tag);observer.observe(tag);return value;
  }
  for(const station of Object.keys(at))boxes.set(station,Array.from({length:3},box));
  const travelers=Array.from({length:8},box);
  function enqueue(item,motion){if(!motion)return;let queue=queues.get(item.key);if(!queue){queue=[];queues.set(item.key,queue);}queue.push({item,...motion});}
  function transitions(items){
    for(const item of items){
      const old=latest.get(item.key);latest.set(item.key,item);
      if(old?.run.state===item.run.state&&old?.run.stopping===item.run.stopping)continue;
      if(item.run.state==='queued'){
        if(old&&['claimed','unknown'].includes(old.run.state))enqueue(item,{route:old.station,reverse:true});
        else if(!old)enqueue(item,{route:item.run.events.some(event=>event.type==='card.answered')?'answer':'intake'});
      }
      if(item.run.state==='claimed'&&old?.run.state==='queued')enqueue(item,{route:item.station});
      if(item.station==='result'&&['coder','think','patrol'].includes(old?.station))enqueue(item,{route:{coder:'result',think:'thinkResult',patrol:'patrolResult'}[old.station]});
    }
  }
  live.add(({first,entries,selected,snapshot,transitions:changes,cardChanges})=>{
    if(cardChanges){for(const card of cardChanges){const key='card:'+card.id;if(card.removed||card.kind!=='ask'||card.state!=='open'||latest.has(key))continue;const run=entries.find(entry=>entry.type==='run'&&entry.id===card.runId),item={key,id:card.id,type:'card',station:'card',label:'等你回答',card,title:card.title};enqueue(item,{route:run?.workStation==='think'?'thinkCard':'card'});latest.set(key,item);}return;}
    if(changes){transitions(changes);return;}
    selection=selected;hasFeishu=snapshot.channels.length>0;
    if(first){latest.clear();queues.clear();for(const traveler of travelers)traveler.motion=null;for(const item of entries)latest.set(item.key,item);}
    else for(const item of entries)if(item.type==='card'&&item.card.kind==='ask'&&!latest.has(item.key)){
      const run=entries.find(entry=>entry.type==='run'&&entry.id===item.card.runId);
      enqueue(item,{route:run?.workStation==='think'?'thinkCard':'card'});latest.set(item.key,item);
    }
    names.clear();active.clear();for(const key of boxes.keys())counts[key]=0;
    for(const item of entries){counts[item.station]=(counts[item.station]??0)+1;if(!names.has(item.station))names.set(item.station,[]);names.get(item.station).push(item);if(item.run?.state==='claimed'&&!item.run.stopping)active.add(item.station);}
    for(const items of names.values())items.sort((a,b)=>Number(b.key===selection)-Number(a.key===selection));
    const waiting=feishuDelivery(hasFeishu,snapshot.cards);if(waiting)active.add('card');
    roles={coder:agentRole(names.get('coder')?.[0],entries,false),patrol:agentRole(names.get('patrol')?.[0],entries,true),card:{brand:hasFeishu?'feishu':null,active:waiting},think:{deepseek:false,gemini:false}};
    roles.think=thinkRoles(entries,snapshot);
  });
  const projected=new Vector3(),routesActive=new Map();
  function display(box,item,route,u,context,index=0){
    const {parcel,tag}=box;box.item=item;parcel.group.visible=!!item;tag.hidden=!item;if(!item)return;
    parcel.group.userData.entry=item.key;
    const type=item.run?.stopping?'stopping':item.run?.state==='queued'&&item.run?.attempts?'retry':route==='answer'?'reply':item.station==='result'?'next':'task';
    parcel.position(belts.curves[route],u,type);parcel.group.position.x+=index*.48;parcel.group.position.z+=index*.31;
    parcel.halo.visible=item.run?.state==='claimed';parcel.halo.scale.setScalar(1+.08*Math.sin(context.stamp*.005));
    const text=tagName(item);if(tag.textContent!==text)tag.textContent=text;
    tag.dataset.stage=item.run?.state??item.type;tag.classList.toggle('selected',item.key===selection);
    projected.copy(parcel.group.position);projected.y+=.84;projected.project(context.camera);
    const x=(projected.x*.5+.5)*context.w,y=(.5-projected.y*.5)*context.h+(index+1)*27;
    tag.hidden=projected.z>1||x<0||x>context.w||y<4||y>context.h-48||!!context.viewer&&context.viewer.id!==item.station||context.tracking&&item.key!==selection;
    if(!tag.hidden){
      const [w,h]=sizes.get(tag)??[120,25],left=MathUtils.clamp(x-w/2,5,context.w-w-5);
      const top=[0,h+6,-h-6,2*(h+6),-2*(h+6)].map(offset=>y-h/2+offset).find(top=>
        top>4&&top+h<context.h-48&&!context.labels.some(([a,b,c,d])=>left<a+c+5&&left+w+5>a&&top<b+d+5&&top+h+5>b));
      tag.hidden=top===undefined;
      if(top!==undefined){context.labels.push([left,top,w,h]);tag.style.transform=`translate(${Math.round(left)}px,${Math.round(top)}px)`;}
    }
  }
  return {
    paint(stamp,camera,w,h,{tracking=false,viewer=null,reduced=false,labels=[]}={}){
      routesActive.clear();if(reduced){queues.clear();for(const traveler of travelers)traveler.motion=null;}
      const busy=new Set(travelers.filter(box=>box.motion).map(box=>box.motion.item.key));
      for(const traveler of travelers){
        if(traveler.motion&&stamp-traveler.start>=traveler.span){busy.delete(traveler.motion.item.key);traveler.motion=null;}
        if(!traveler.motion)for(const [key,queue] of queues){if(!busy.has(key)&&queue.length){traveler.motion=queue.shift();traveler.start=stamp;traveler.span=belts.curves[traveler.motion.route].getLength()/5*1000+180;busy.add(key);if(!queue.length)queues.delete(key);break;}}
      }
      const context={stamp,camera,w,h,tracking,viewer,labels};
      for(const [station,pool] of boxes){const items=(names.get(station)??[]).filter(item=>!busy.has(item.key));for(let i=0;i<pool.length;i++)display(pool[i],items[i],...at[station],context,i-1);}
      for(const traveler of travelers){const motion=traveler.motion;if(!motion){display(traveler,null,null,0,context);continue;}
        const t=MathUtils.clamp((stamp-traveler.start)/(traveler.span-180),0,1),u=t<.5?4*t*t*t:1-(-2*t+2)**3/2;
        const speed=(motion.reverse?-1:1)*5*(t<.5?12*t*t:12*(1-t)**2);
        if(Math.abs(speed)>Math.abs(routesActive.get(motion.route)??0))routesActive.set(motion.route,speed);
        display(traveler,motion.item,motion.route,motion.reverse?1-u:u,context);
        const elapsed=stamp-traveler.start,landing=Math.max(0,elapsed-(traveler.span-180));
        traveler.parcel.group.position.y+=elapsed<180?Math.sin(elapsed/180*Math.PI)*.08:landing>0?Math.sin(landing/180*Math.PI)*.08:0;
      }
      return new Set(active);
    },
    routes:()=>routesActive,
    moving:()=>queues.size>0||travelers.some(box=>box.motion),
    focused(){return [...travelers,...[...boxes.values()].flat()].find(box=>box.item?.key===selection&&box.parcel.group.visible)?.parcel.group;},
    talking:id=>active.has(id),roles:()=>roles,
    label(station){const count=counts[station.id]??0,role=roles[station.id];return station.name+(role?.name?' · '+role.name:'')+(count?' · '+count+(count>3?'（+'+(count-3)+'）':''):'');}
  };
}
