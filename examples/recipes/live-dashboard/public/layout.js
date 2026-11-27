export const stations = [
  { id:'intake', name:'事件入口', at:[-9,2.87,3], dock:[-6.9,2.12], radius:1.58, height:2.62, description:'邮筒收到事件时会举旗，交给中台按规则分派。' },
  { id:'hub', name:'调度中台', at:[-1,3.35,-2], dock:[-1,.98], radius:2.17, height:2.84, description:'圆顶大厅匹配规则、记录事实和排队。包裹在大厅外的转台交接。' },
  { id:'think', name:'智囊池', at:[-6.65,2.55,-4.95], dock:[-6.15,-2.85], radius:1.58, height:2.62, description:'DeepSeek 与 Gemini 独立思考，按实际轮次分别显示工作状态。' },
  { id:'coder', name:'接单站', at:[7,2.87,-4.5], dock:[6.4,-2.20], radius:1.58, height:2.62, description:'这里查看开发任务。站牌显示当前接单程序，空闲时保留最近的接单记录。' },
  { id:'patrol', name:'巡检接单站', at:[7,2.87,4.2], dock:[6.35,6.55], radius:1.58, height:2.62, description:'巡检小车沿高架支线接单，转动探头扫视园区。' },
  { id:'card', name:'飞书卡片站', at:[0,2.87,6.8], dock:[0,4.46], radius:1.58, height:2.62, description:'有待答卡片时，信使会举起信封。人的回答会以新事件沿青色路线返回。' },
  { id:'result', name:'结果归档', at:[-1,2.0,-7.4], dock:[-.65,-5.10], radius:1.58, height:1.75, description:'接续轮次交回结果，记录事项结果。' }
];

const docks = Object.fromEntries(stations.map(station=>[station.id,station.dock]));
export const routes = {
  intake: [docks.intake,[-5.38,2.04],[-3.95,1.20],[-2.45,.94],docks.hub],
  coder: [docks.hub,[.70,.45],[2.11,-1.04],[3.96,-1.23],[5.17,-1.46],docks.coder],
  patrol: [docks.hub,[.42,1.96,.14],[2.42,2.11,.50],[4.11,3.36,1.22],[5.24,5.62,1.05],docks.patrol],
  card: [docks.coder,[8.09,-2.30],[9.39,-1.40],[9.33,.27],[8.40,1.42],[6.40,1.62],[5.03,2.66],[3.90,4.08],[2.76,4.49],docks.card],
  answer: [docks.card,[-1.79,4.62],[-3.14,4.20],[-3.13,3.04],[-2.06,2.31],docks.hub],
  think: [docks.hub,[-3,.2],[-4.9,-1.3],docks.think],
  thinkCard: [docks.think,[-9,-1.6],[-12,0],[-12,4.8],[-9,6.4],[-4.5,6.1],docks.card],
  thinkResult: [docks.think,[-5.5,-4.1],[-3.6,-5.25],docks.result],
  patrolResult: [docks.patrol,[10,6.2],[11,-3,1.25],[4,-7.8,1.25],docks.result],
  result: [docks.coder,[5.38,-2.92],[4.25,-3.96],[3.12,-5.02],[1.95,-5.72],[.33,-5.56],docks.result]
};
