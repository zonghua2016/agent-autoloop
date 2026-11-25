import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const standard = (color, extra={}) => new T.MeshStandardMaterial({color,roughness:.55,...extra});
const enamel = (color, extra={}) => new T.MeshPhysicalMaterial({color,roughness:.29,clearcoat:.38,clearcoatRoughness:.27,...extra});
const ivory=standard(0xf2e6cc);
const brass=standard(0xbe8d49,{metalness:.57,roughness:.34});
const bronze=standard(0x785836,{metalness:.35,roughness:.39});
const rubber=standard(0x253b35,{roughness:.89});
const ink=enamel(0x1d333a,{emissive:0x163343,emissiveIntensity:.22});
const glint=standard(0xfff5e1,{emissive:0xffecd2,emissiveIntensity:.27});
const sphere=new T.SphereGeometry(1,20,12);
const box=new T.BoxGeometry();

function put(parent,geometry,material,x=0,y=0,z=0) {
  const mesh=new T.Mesh(geometry,material);
  mesh.position.set(x,y,z);
  mesh.castShadow=true;
  mesh.receiveShadow=true;
  parent.add(mesh);
  return mesh;
}
function group(parent,x=0,y=0,z=0) {
  const out=new T.Group();
  out.position.set(x,y,z);
  parent.add(out);
  return out;
}
function casePiece(p,m,x,y,z,w,h,d,round=.065) {
  if(round) return put(p,new RoundedBoxGeometry(w,h,d,3,round),m,x,y,z);
  const mesh=put(p,box,m,x,y,z);
  mesh.scale.set(w,h,d);
  return mesh;
}
function oval(p,m,x,y,z,w,h,d) {
  const mesh=put(p,sphere,m,x,y,z);
  mesh.scale.set(w,h,d);
  return mesh;
}
function tube(p,m,points,r=.018) {
  const path=new T.CatmullRomCurve3(points.map(v=>new T.Vector3(...v)));
  return put(p,new T.TubeGeometry(path,Math.max(10,points.length*4),r,8),m);
}
function cylinder(p,m,x,y,z,r,h,axis='y') {
  const mesh=put(p,new T.CylinderGeometry(r,r,h,28),m,x,y,z);
  if(axis==='x') mesh.rotation.z=Math.PI/2;
  if(axis==='z') mesh.rotation.x=Math.PI/2;
  return mesh;
}
function torus(p,m,x,y,z,r,edge) {
  return put(p,new T.TorusGeometry(r,edge,10,36),m,x,y,z);
}
function blink(t,pace,phase) {
  const elapsed=((t+phase)%pace+pace)%pace;
  return 1-.91*Math.max(0,1-Math.abs(elapsed-.105)/.105);
}
function activityEnvelope() {
  let value=0,last=NaN;
  return (time,active,reduced)=>{
    const target=active&&!reduced?1:0;
    if(!Number.isFinite(last)||time<last||reduced) value=target;
    else value+=(target-value)*(1-Math.exp(-Math.min(.22,time-last)*3.8));
    last=time;
    return value;
  };
}

export function makeIntakeMascot(parent) {
  const sculpture=group(parent);
  sculpture.scale.y=1.19;
  const apricot=enamel(0xee9b59);
  const orange=enamel(0xcc623c);
  const biscuit=standard(0xf4c587,{roughness:.63});
  const card=standard(0xffecbf,{roughness:.70});
  const wax=enamel(0xb95744,{roughness:.42});
  const indicator=enamel(0xf7c586,{emissive:0xf6973f,emissiveIntensity:.36});
  const base=group(sculpture);
  for(const sign of [-1,1]) {
    casePiece(base,bronze,sign*.35,.076,.074,.318,.150,.564,.066);
    casePiece(base,orange,sign*.35,.187,.036,.284,.126,.450,.044);
    casePiece(base,biscuit,sign*.35,.119,.334,.224,.044,.066,.015);
    cylinder(base,brass,sign*.35,.245,.018,.090,.104);
  }
  const body=group(sculpture,0,.715,0);
  casePiece(body,orange,0,-.40,0,1.19,.170,.879,.071);
  casePiece(body,apricot,0,.05,0,1.234,.930,.897,.229);
  casePiece(body,biscuit,0,.45,0,1.215,.221,.922,.108);
  casePiece(body,ivory,0,.38,.366,1.02,.067,.243,.033);
  casePiece(body,bronze,0,-.196,.449,.660,.181,.066,.056);
  casePiece(body,ink,0,-.194,.487,.552,.107,.025,.035);
  casePiece(body,biscuit,0,-.309,.486,.708,.045,.130,.022);

  const eyes=[];
  for(const sign of [-1,1]) {
    const eye=group(body,sign*.183,.113,.445);
    oval(eye,ivory,0,0,0,.102,.118,.039);
    oval(eye,ink,sign*.010,.002,.030,.067,.092,.035);
    oval(eye,glint,-.021,.035,.062,.020,.024,.008);
    oval(eye,glint,.020,-.024,.063,.012,.013,.005);
    eyes.push(eye);
    oval(body,wax,sign*.347,-.009,.44,.072,.032,.012);
    oval(body,brass,sign*.500,-.341,.445,.024,.024,.012);
  }
  tube(body,ink,[[-.060,.016,.452],[-.027,-.000,.458],[0,-.006,.460],[.027,0,.458],[.060,.016,.452]],.010);

  const envelope=group(body,0,-.245,.494);
  envelope.rotation.x=-.20;
  casePiece(envelope,card,0,-.023,0,.438,.206,.043,.034);
  tube(envelope,bronze,[[-.172,.049,.026],[0,-.037,.028],[.172,.049,.026]],.009);
  oval(envelope,wax,0,-.035,.038,.039,.039,.015);

  cylinder(body,bronze,.627,.108,.08,.093,.065,'x');
  cylinder(body,brass,.663,.108,.08,.064,.043,'x');
  const flag=group(body,.686,.108,.08);
  casePiece(flag,brass,0,.237,0,.064,.526,.068,.026);
  casePiece(flag,orange,.126,.446,0,.303,.181,.090,.039);
  oval(flag,indicator,.214,.448,.048,.032,.032,.012);
  cylinder(body,brass,-.627,.057,.06,.076,.057,'x');
  const beam=group(body,-.32,.546,-.012);
  cylinder(beam,bronze,0,.018,0,.117,.032);
  oval(beam,indicator,0,.086,0,.067,.080,.067);

  const envelopeGain=activityEnvelope();
  return (seconds,active,reducedMotion)=>{
    const t=reducedMotion?0:seconds;
    const gain=envelopeGain(seconds,active,reducedMotion);
    body.position.y=.715+Math.sin(t*3.15)*.029*gain;
    body.rotation.z=Math.sin(t*2.9)*.021*gain;
    flag.rotation.z=-.31+gain*(.32+.21*Math.sin(t*5.45));
    envelope.rotation.x=-.20+gain*.16*Math.sin(t*3.55+.20);
    envelope.position.z=.494+gain*.026*(1+Math.sin(t*4.10));
    indicator.emissiveIntensity=.30+gain*(.30+.16*Math.sin(t*5.45));
    for(const eye of eyes) eye.scale.y=reducedMotion?1:blink(t,5.95,1.26);
  };
}

export function makePatrolMascot(parent) {
  const fern=enamel(0x74b9a5);
  const celadon=enamel(0xf2f5ee,{roughness:.52});
  const cypress=standard(0x3d7263,{metalness:.17,roughness:.43});
  const teal=standard(0x286371,{metalness:.45,roughness:.38});
  const bezel=standard(0x777b58,{metalness:.46,roughness:.39});
  const glass=enamel(0x5db1ad,{metalness:.21,roughness:.17,clearcoat:.78,emissive:0x165965,emissiveIntensity:.36});
  const diode=enamel(0xf0c16e,{emissive:0xf0a640,emissiveIntensity:.28});
  const frame=group(parent);
  frame.name="patrol-rover";
  frame.scale.y=1.08;

  const wheels=[];
  for(const sign of [-1,1])for(const z of [-.33,.33]) {
    const wheel=group(frame,sign*.55,.205,z);
    const tire=torus(wheel,rubber,0,0,0,.142,.060);tire.rotation.y=Math.PI/2;
    cylinder(wheel,cypress,sign*.018,0,0,.142,.095,'x');
    cylinder(wheel,celadon,sign*.068,0,0,.103,.025,'x');
    cylinder(wheel,brass,sign*.085,0,0,.038,.030,'x');
    for(let i=0;i<5;i++){
      const angle=i*Math.PI*2/5;
      const spoke=casePiece(wheel,teal,sign*.086,Math.cos(angle)*.063,Math.sin(angle)*.063,.012,.054,.021,.005);
      spoke.rotation.x=angle;
    }
    wheels.push(wheel);
    casePiece(frame,fern,sign*.55,.424,z,.28,.085,.39,.04);
  }
  casePiece(frame,cypress,0,.351,0,.978,.259,.833,.112);
  casePiece(frame,celadon,0,.526,0,1.118,.308,.896,.143);
  casePiece(frame,fern,0,.673,-.035,.846,.105,.726,.049);
  for(const x of [-.20,-.10,0,.10,.20])casePiece(frame,teal,x,.52,.487,.045,.055,.015,.008);
  casePiece(frame,bronze,0,.373,.432,.774,.064,.090,.030);
  casePiece(frame,ivory,0,.527,.446,.582,.127,.068,.033);
  for(const x of [-.212,0,.212]) oval(frame,diode,x,.527,.483,.023,.023,.012);
  for(const sign of [-1,1]) {
    const x=sign*.419;
    oval(frame,bronze,x,.577,.417,.079,.069,.055);
    oval(frame,diode,x,.577,.460,.049,.050,.027);
  }

  cylinder(frame,bronze,0,.735,-.044,.284,.054);
  cylinder(frame,brass,0,.788,-.044,.211,.058);
  cylinder(frame,cypress,0,.847,-.044,.109,.122);
  const swivel=group(frame,0,.890,-.044);
  casePiece(swivel,celadon,0,.236,0,.982,.473,.507,.154);
  casePiece(swivel,fern,0,.418,-.045,.825,.144,.399,.068);
  casePiece(swivel,teal,0,.202,.225,.847,.361,.111,.063);
  const optics=[];
  for(const sign of [-1,1]) {
    const x=sign*.233;
    cylinder(swivel,ivory,x,.222,.294,.184,.106,'z');
    torus(swivel,bronze,x,.222,.355,.149,.028);
    cylinder(swivel,ink,x,.222,.353,.131,.042,'z');
    oval(swivel,glass,x,.222,.382,.114,.112,.047);
    const eye=group(swivel,x,.223,.414);
    oval(eye,ink,0,0,0,.063,.073,.021);
    oval(eye,glint,-.018,.024,.018,.020,.021,.007);
    oval(eye,glint,.023,-.023,.019,.009,.009,.005);
    optics.push(eye);
  }
  tube(swivel,ivory,[[-.054,.070,.283],[-.026,.052,.290],[0,.048,.291],[.026,.052,.290],[.054,.070,.283]],.010);
  const antenna=group(swivel,.196,.459,-.106);
  cylinder(antenna,bronze,0,.122,0,.021,.247);
  oval(antenna,diode,0,.276,0,.059,.058,.059);
  const scanner=group(swivel,-.246,.487,-.138);
  cylinder(scanner,brass,0,.042,0,.122,.081);
  const dish=torus(scanner,ivory,0,.111,0,.115,.020);
  dish.rotation.x=-.96;
  casePiece(scanner,teal,0,.145,-.008,.146,.067,.087,.019);

  const envelopeGain=activityEnvelope();
  return (seconds,active,reducedMotion)=>{
    const t=reducedMotion?0:seconds;
    const gain=envelopeGain(seconds,active,reducedMotion);
    swivel.rotation.y=reducedMotion?0:Math.sin(t*1.83)*(.072+.33*gain);
    swivel.rotation.z=Math.sin(t*3.2)*.039*gain;
    scanner.rotation.y=reducedMotion?0:t*(.80+gain*.30);
    for(const wheel of wheels)wheel.rotation.x=reducedMotion?0:Math.sin(t*1.8)*.10*gain;
    antenna.rotation.z=Math.sin(t*3.05+.3)*.124*gain;
    diode.emissiveIntensity=.25+gain*(.57+.15*Math.sin(t*4.6));
    for(const eye of optics) eye.scale.y=reducedMotion?1:blink(t,6.72,2.17);
  };
}
