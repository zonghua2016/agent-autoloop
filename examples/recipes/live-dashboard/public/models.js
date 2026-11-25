import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { routes, stations } from './layout.js';
import { makeCodexMascot, makeFeishuMascot, makeThinkMascots } from './brand-models.js';
import { makeIntakeMascot, makePatrolMascot } from './mascots-field.js';

const rand = (() => { let seed=624102; return () => ((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296); })();
const finish = (color, extra={}) => new T.MeshStandardMaterial({ color, roughness:.76, ...extra });
const boxGeo = new T.BoxGeometry();
const curvePoint = ([x,z,y=0]) => new T.Vector3(x,y,z);
const curve = points => new T.CatmullRomCurve3(points.map(curvePoint),false,'centripetal',.4);
function mesh(parent,geo,mat,x=0,y=0,z=0,shadow=true) {
  const m=new T.Mesh(geo,mat);
  m.position.set(x,y,z); m.castShadow=shadow;m.receiveShadow=true;parent.add(m);return m;
}
function box(p,mat,x,y,z,w,h,d,bevel=0) {
  if(bevel) return mesh(p,new RoundedBoxGeometry(w,h,d,2,bevel),mat,x,y,z);
  const m=mesh(p,boxGeo,mat,x,y,z);
  m.scale.set(w,h,d);return m;
}
function disc(p,mat,x,y,z,rt,rb,h,n=40) {return mesh(p,new T.CylinderGeometry(rt,rb,h,n),mat,x,y,z);}
function ring(p,mat,x,y,z,r,t) {
  const m=mesh(p,new T.TorusGeometry(r,t,8,64),mat,x,y,z);
  m.rotation.x=Math.PI/2;return m;
}
function tex(draw, size=128) {
  const c=document.createElement('canvas');c.width=c.height=size;
  const ctx=c.getContext('2d');draw(ctx,size);
  const t=new T.CanvasTexture(c);t.colorSpace=T.SRGBColorSpace;t.wrapS=t.wrapT=T.RepeatWrapping;t.anisotropy=4;return t;
}
function dust(ctx,size,samples,alpha) {
  for(let i=0;i<samples;i++) {
    ctx.fillStyle=rand()<.5?'rgba(35,45,24,'+alpha+')':'rgba(255,251,219,'+alpha+')';
    ctx.fillRect(rand()*size,rand()*size,.6+rand()*2.2,.6+rand()*1.4);
  }
}
const stoneMap=tex((c,n)=>{c.fillStyle='#e8e3d2';c.fillRect(0,0,n,n);dust(c,n,650,.12);});
const glowMap=tex((c,n)=>{
  const g=c.createRadialGradient(n/2,n/2,0,n/2,n/2,n/2);
  g.addColorStop(0,'rgba(255,220,145,.56)');g.addColorStop(.45,'rgba(255,209,126,.20)');g.addColorStop(1,'rgba(255,207,129,0)');
  c.fillStyle=g;c.fillRect(0,0,n,n);
});
const stone=finish(0xffffff,{map:stoneMap});
const grout=finish(0xaca391);
const cream=finish(0xe8e1ce);
const dark=finish(0x334b4a);
const steel=finish(0x8b9890,{metalness:.50,roughness:.43});
const bronze=finish(0xa48051,{metalness:.38,roughness:.42});
const mint=finish(0x507e73);
const glazing=finish(0x78a8ae,{roughness:.22,metalness:.18,emissive:0xf8d19a,emissiveIntensity:0});
const luminous=finish(0xffe0a4,{roughness:.24,emissive:0xffbe65,emissiveIntensity:.04});
const paleGlass=new T.MeshPhysicalMaterial({color:0xa6d2cd,transparent:true,opacity:.35,roughness:.13,metalness:.09,depthWrite:false,side:T.DoubleSide});
const globes=[];
const lightPools=[];

function plinth(p,w,d) {
  box(p,grout,0,.09,0,w,.18,d,.055);
  box(p,stone,0,.20,0,w-.06,.09,d-.06,.04);
  const cols=Math.round(w/.47),rows=Math.round(d/.46), cellW=(w-.13)/cols,cellD=(d-.13)/rows;
  const tiles=new T.InstancedMesh(boxGeo,stone,cols*rows);
  const matrix=new T.Matrix4();
  for(let i=0;i<cols;i++) for(let j=0;j<rows;j++) {
    matrix.makeScale(cellW-.023,.028,cellD-.023);
    matrix.setPosition((i-(cols-1)/2)*cellW,.256,(j-(rows-1)/2)*cellD);
    const k=i*rows+j;
    tiles.setMatrixAt(k,matrix);
    tiles.setColorAt(k,new T.Color().setScalar(.82+rand()*.15));
  }
  tiles.receiveShadow=true;p.add(tiles);
}
function door(p,x,z,y=.26) {
  box(p,dark,x,y+.52,z,.77,1.05,.082,.035);
  box(p,glazing,x,y+.70,z+.049,.55,.45,.016,.018);
  box(p,bronze,x+.21,y+.42,z+.059,.14,.026,.025,.006);
  box(p,stone,x,y+.036,z+.16,.92,.075,.40,.024);
}
function windowAt(p,x,y,z,w=.62,h=.55) {
  box(p,cream,x,y,z,w+.11,h+.12,.075,.026);
  box(p,glazing,x,y,z+.052,w,h,.028,.018);
  box(p,cream,x,y,z+.074,.029,h,.023);
  box(p,cream,x,y,z+.076,w,.025,.024);
  box(p,stone,x,y-h/2-.067,z+.055,w+.17,.057,.16,.018);
}
function lamps(parent,positions) {
  for(const [mat,y,w,h,d] of [[steel,.10,.21,.11,.21],[dark,.435,.05,.67,.05],[bronze,.765,.165,.08,.165],[luminous,.845,.139,.105,.139],[dark,.92,.19,.06,.19]])
    batchBoxes(parent,positions.map(([x,z])=>[x,y,z,w,h,d]),mat);
  const glow=new T.InstancedMesh(new T.PlaneGeometry(2.9,2.9),new T.MeshBasicMaterial({map:glowMap,transparent:true,depthWrite:false,opacity:0,polygonOffset:true,polygonOffsetFactor:-2}),positions.length);
  const object=new T.Object3D();object.rotation.x=-Math.PI/2;
  positions.forEach(([x,z],i)=>{object.position.set(x,.065,z);object.updateMatrix();glow.setMatrixAt(i,object.matrix);});
  parent.add(glow);globes.push(glow);
}
function machineRoom(p,w,d,h,roof) {
  box(p,cream,0,.26+h/2,0,w,h,d,.08);
  box(p,cream,0,.28+h,0,w+.20,.13,d+.20,.07);
  box(p,roof,0,.40+h,0,w+.30,.19,d+.31,.085);
}
function objectGroup(scene,x,z) {
  const g=new T.Group();g.position.set(x,0,z);scene.add(g);return g;
}
function gazebo(scene) {
  const g=objectGroup(scene,-1,-2);
  const radius=1.65;
  disc(g,grout,0,.07,0,2.05,2.17,.14,56);
  disc(g,stone,0,.205,0,1.99,2.04,.15,56);
  disc(g,mint,0,.42,0,1.58,1.66,.31,48);
  disc(g,cream,0,.685,0,radius,radius,.23,56);
  ring(g,bronze,0,.793,0,1.67,.042);
  ring(g,cream,0,.22,0,1.93,.055);
  disc(g,stone,0,.81,0,radius-.06,radius-.06,.12,48);
  const shell=mesh(g,new T.SphereGeometry(radius,56,24,0,Math.PI*2,0,Math.PI/2),paleGlass,0,.86,0,false);
  shell.scale.y=1.06;
  for(let i=0;i<12;i++) {
    const a=i*Math.PI/6;
    const rib=[];
    for(let j=0;j<=18;j++){
      const theta=j*Math.PI/36;
      rib.push(new T.Vector3(Math.cos(theta)*radius*Math.cos(a),.86+Math.sin(theta)*radius*1.06,Math.cos(theta)*radius*Math.sin(a)));
    }
    mesh(g,new T.TubeGeometry(new T.CatmullRomCurve3(rib),22,.027,7),cream);
    const sx=Math.cos(a)*radius,sz=Math.sin(a)*radius;
    disc(g,cream,sx,.50,sz,.045,.065,.55,10);
    box(g,glazing,sx,.47,sz,.24,.30,.14,.02).rotation.y=-a;
  }
  for(const p of [.36,.66,1]){
    ring(g,steel,0,.86+Math.sin(p)*radius*1.06,0,Math.cos(p)*radius,.024);
  }
  disc(g,bronze,0,2.615,0,.13,.21,.105,20);
  mesh(g,new T.SphereGeometry(.084,16,12),luminous,0,2.74,0);
  disc(g,mint,0,1.14,0,.28,.42,.60,24);
  ring(g,bronze,0,1.53,0,.48,.038);
  for(let i=0;i<4;i++) {
    const a=i*Math.PI/2;
    box(g,dark,.71*Math.cos(a),1.07,.71*Math.sin(a),.29,.33,.29,.04);
  }
  return g;
}

function mascotStage(scene,station,accent,build) {
  const [x,,z]=station.at;
  const stage=objectGroup(scene,x,z);
  if(station.id==='think') {
    disc(stage,stone,.80,.22,.68,.52,.57,.11,32);
    return build(stage);
  }
  const enamel=finish(accent,{roughness:.35,metalness:.10});
  disc(stage,grout,0,.070,0,1.51,1.58,.14,64);
  disc(stage,stone,0,.17,0,1.49,1.52,.08,64);
  disc(stage,enamel,0,.246,0,1.40,1.45,.08,64);
  ring(stage,bronze,0,.286,0,1.405,.021);
  disc(stage,cream,0,.32,0,1.32,1.34,.10,64);
  ring(stage,stone,0,.376,0,1.19,.013);
  for(const [mat,selected] of [[bronze,true],[cream,false]]) {
    const tiles=[];
    for(let i=0;i<24;i++){if((i%6===0)!==selected)continue;const a=i*Math.PI/12;tiles.push([1.464*Math.cos(a),.221,1.464*Math.sin(a),.10,.024,.033,-a]);}
    batchBoxes(stage,tiles,mat);
  }
  const pedestal=new T.Group();pedestal.position.y=.375;stage.add(pedestal);
  return build(pedestal);
}

function modelSwitcher(builders, fallback=null) {
  return parent=>{
    const loaded=new Map();
    let showing=null;
    return (seconds,active,reduced,role)=>{
      const id=Object.hasOwn(builders,role?.brand)?role.brand:fallback;
      if(id!==showing){
        if(showing)loaded.get(showing).group.visible=false;
        if(id&&!loaded.has(id)){
          const group=new T.Group();
          group.name=id;
          parent.add(group);
          loaded.set(id,{group,animate:builders[id](group)});
        }
        if(id)loaded.get(id).group.visible=true;
        showing=id;
      }
      if(id)loaded.get(id).animate(seconds,role?.active??active,reduced);
    };
  };
}

export function createArchitecture(scene) {
  gazebo(scene);
  const builders={
    intake:[0xbe8b55,makeIntakeMascot],card:[0x27ab9d,modelSwitcher({feishu:makeFeishuMascot})],
    coder:[0x537d91,modelSwitcher({codex:makeCodexMascot},'codex')],
    think:[0x8294cd,makeThinkMascots],
    patrol:[0x69976f,makePatrolMascot]
  };
  const mascots=stations.filter(station=>builders[station.id]).map(station=>{
    const [accent,build]=builders[station.id];
    return [station.id,mascotStage(scene,station,accent,build)];
  });
  const archive=objectGroup(scene,-1,-7.4);
  plinth(archive,2.75,2.25);
  machineRoom(archive,1.88,1.44,1.02,finish(0x729782));
  door(archive,0,.73);
  for(const x of [-.63,.63]) windowAt(archive,x,.94,.73,.28,.41);
  for(const x of [-.55,0,.55]) box(archive,bronze,x,1.58,-.20,.37,.058,.57,.023);
  lamps(scene,[[-10.62,3.81],[-7.50,4.26],[-5.61,2.93],[-4,-.36],[-2.69,-.32],[.86,-2.94],
    [8.7,-5.15],[10.56,-1.74],[9.67,2.70],[7.94,5.97],[3.57,6.39],[1.57,7.94],[-1.51,7.95],[-3.79,5.6],
    [-4.05,3.75],[-.08,2.88],[-2.55,-7.33],[.52,-8.10],[3.95,-7.29]]);
  for(const [x,y,z] of [[-8.38,1.3,3.8],[-.95,2.1,-1.48],[7.10,1.41,-3.3],[7.1,1.05,4.72],
    [.68,1.16,7.67],[-4.9,.86,4.55],[-.93,1.24,-6.67]]) {
    const light=new T.PointLight(0xffcb79,0,4.1,1.9);
    light.position.set(x,y,z);light.visible=false;scene.add(light);lightPools.push(light);
  }
  return { update(night,seconds,active,roles,reducedMotion) {
    for(const [id,animate] of mascots)animate(seconds,active.has(id),reducedMotion,roles[id]);
    glazing.emissiveIntensity=night*.50;luminous.emissiveIntensity=.04+night*1.64;
    for(const glow of globes)glow.material.opacity=night*.87;
    for(const light of lightPools) {light.visible=night>.01;light.intensity=night*7.25;}
  } };
}

const DOCK_RADIUS = .72;
const BELT_HEIGHT = .495;
function strip(parent,path,width,height,mat,segments,start,end,groundLevel=false) {
  const positions=[],normals=[],uv=[],index=[];
  for(let i=0;i<=segments;i++) {
    const u=T.MathUtils.lerp(start,end,i/segments),p=path.getPointAt(u),d=path.getTangentAt(u);
    const h=height+(groundLevel?0:p.y), horizontal=Math.hypot(d.x,d.z), nx=d.z/horizontal,nz=-d.x/horizontal;
    for (const sign of [-1,1]) {
      positions.push(p.x+nx*sign*width*.5,h,p.z+nz*sign*width*.5);
      normals.push(0,1,0);uv.push((sign+1)*.5,u*path.getLength());
    }
    if(i>0){const a=(i-1)*2;index.push(a,a+1,a+2,a+1,a+3,a+2);}
  }
  const g=new T.BufferGeometry();
  g.setAttribute('position',new T.Float32BufferAttribute(positions,3));g.setAttribute('normal',new T.Float32BufferAttribute(normals,3));
  g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));g.setIndex(index);
  return mesh(parent,g,mat,0,0,0,false);
}
function batchBoxes(parent,props,mat,shadow=true) {
  const bunch=new T.InstancedMesh(boxGeo,mat,props.length),object=new T.Object3D();
  props.forEach(([x,y,z,w,h,d,yaw=0],i)=>{
    object.position.set(x,y,z);object.scale.set(w,h,d);object.rotation.y=yaw;object.updateMatrix();bunch.setMatrixAt(i,object.matrix);
  });
  bunch.receiveShadow=true;bunch.castShadow=shadow;parent.add(bunch);return bunch;
}
export function createBelts(scene) {
  const curves=Object.fromEntries(Object.entries(routes).map(([name,points])=>[name,curve(points)]));
  const footprints=Object.entries(curves).map(([name,path])=>[name,path.getSpacedPoints(Math.ceil(path.getLength()/.10))]);
  const ground=finish(0xe1daca,{map:stoneMap,side:T.DoubleSide});
  const black=finish(0x485459,{side:T.DoubleSide,roughness:.89});
  const blue=finish(0x376b66,{side:T.DoubleSide,roughness:.78});
  const railGold=finish(0xb69460,{roughness:.44,metalness:.40,side:T.DoubleSide});
  const railTeal=finish(0x77b2a4,{roughness:.42,metalness:.29,side:T.DoubleSide});
  const baffles=finish(0x667372);
  const returnTread=finish(0x6e9f91);
  const pillars=[];
  const moving=[];
  for(const {dock:[x,z],id} of stations) {
    disc(scene,steel,x,.185,z,.27,.32,.34,20);
    disc(scene,cream,x,.046,z,.43,.48,.092,24);
    // Lift the turntable above the belt ends to avoid coplanar surfaces.
    disc(scene,id==='card'?blue:black,x,BELT_HEIGHT-.012,z,DOCK_RADIUS,DOCK_RADIUS,.064,36);
    ring(scene,id==='card'?railTeal:railGold,x,BELT_HEIGHT+.004,z,DOCK_RADIUS-.024,.022);
    ring(scene,steel,x,BELT_HEIGHT+.022,z,.35,.006);
  }
  for(const [name,path] of Object.entries(curves)) {
    const back=name==='answer',length=path.getLength();
    const start=.54/length,end=1-start;
    const railStart=.79/length,railEnd=1-railStart;
    if(!back)strip(scene,path,1.6,name==='patrol'?.033:.031,ground,100,start,end,true);
    strip(scene,path,.97,BELT_HEIGHT,back?blue:black,112,start,end);
    for(const side of [-1,1]) {
      const pts=[];
      for(let i=0;i<=64;i++) {
        const u=T.MathUtils.lerp(railStart,railEnd,i/64);
        const p=path.getPointAt(u),d=path.getTangentAt(u);
        const horizontal=Math.hypot(d.x,d.z);
        pts.push(new T.Vector3(p.x+side*.51*d.z/horizontal,.558+p.y,p.z-side*.51*d.x/horizontal));
      }
      mesh(scene,new T.TubeGeometry(new T.CatmullRomCurve3(pts),100,.039,7),back?railTeal:railGold);
    }
    for(let d=1.06;d<length-1.0;d+=.9) {
      const p=path.getPointAt(d/length),t=path.getTangentAt(d/length);
      const feet=[-1,1].map(side=>[p.x+side*.43*t.z,p.z-side*.43*t.x]);
      // An overpass spans the lower belt instead of putting supports through it.
      if(p.y>.24&&feet.some(([x,z])=>footprints.some(([other,points])=>other!==name&&points
        .some(q=>q.y<p.y-.22&&Math.hypot(x-q.x,z-q.z)<.68))))continue;
      for(const [x,z] of feet) {
        pillars.push([x,(.50+p.y)/2,z,.072,.50+p.y,.072],[x,.056,z,.17,.088,.18]);
      }
    }
    const spacing=.155,count=Math.max(1,Math.floor((length-1.70)/spacing));
    const ribs=new T.InstancedMesh(boxGeo,back?returnTread:baffles,count);
    ribs.receiveShadow=true;scene.add(ribs);
    moving.push({name,path,ribs,length,spacing,points:path.getSpacedPoints(512),tangents:Array.from({length:513},(_,i)=>path.getTangentAt(i/512))});
  }
  batchBoxes(scene,pillars,steel);
  const markerMat=finish(0xc2f0cc,{emissive:0x63bda5,emissiveIntensity:.24});
  const answer=curves.answer;
  for(let u=.12;u<.92;u+=.15) {
    const p=answer.getPointAt(u),v=answer.getTangentAt(u),yaw=Math.atan2(v.x,v.z);
    for(const sign of [-1,1]) {
      const signal=box(scene,markerMat,p.x+.115*sign*v.z,.527,p.z-.115*sign*v.x,.27,.015,.035);
      signal.rotation.y=yaw+sign*.67;
    }
  }
  let last=-1;
  const offsets=new Map();
  const object=new T.Object3D();
  object.scale.set(.84,.015,.065);
  function update(time,activeRoutes) {
    if(time===last)return;
    const dt=last<0?0:Math.min(.15,time-last);last=time;
    for(const {name,ribs,length,spacing,points,tangents} of moving) {
      if(activeRoutes&&!activeRoutes.has(name))continue;
      const speed=activeRoutes instanceof Map?(activeRoutes.get(name)??0):0;
      const offset=((offsets.get(name)??0)+speed*dt)%spacing;offsets.set(name,offset);
      for(let i=0;i<ribs.count;i++) {
        const u=(.88+i*spacing+offset)/length;
        const sample=Math.min(512,Math.floor(u*512)),p=points[sample],t=tangents[sample];
        object.position.set(p.x,.507+p.y,p.z);
        object.rotation.set(-Math.asin(T.MathUtils.clamp(t.y,-1,1)),Math.atan2(t.x,t.z),0,'YXZ');
        object.updateMatrix();ribs.setMatrixAt(i,object.matrix);
      }
      ribs.instanceMatrix.needsUpdate=true;
    }
  }
  update(0);
  return {curves,update,wet(value) {
    black.roughness=.89-value*.36;blue.roughness=.78-value*.29;ground.roughness=.76-value*.24;
  }};
}

export function createParcel(scene,scale=1) {
  const group=new T.Group();scene.add(group);group.scale.setScalar(scale);
  const shell=finish(0xc99654,{roughness:.86});
  const tape=finish(0xf2cc78,{roughness:.66});
  box(group,shell,0,.25,0,.52,.50,.49,.055);
  box(group,tape,0,.493,0,.127,.019,.491,.012);
  box(group,tape,0,.27,.245,.127,.46,.019,.010);
  box(group,tape,0,.27,-.245,.127,.46,.019,.010);
  const label=box(group,stone,.133,.501,.068,.113,.017,.137,.012);
  label.rotation.y=.09;
  const shades={task:[0xc89250,0xf2c870],reply:[0x60a89c,0xb8eee0],next:[0x809f67,0xcae5ad],retry:[0xe7a33e,0xffd67a],stopping:[0xb75a51,0xf3a89c]};
  const halo=ring(group,finish(0x73caba,{emissive:0x35a890,emissiveIntensity:.5}),0,-.01,0,.44,.018);
  let shade='';
  return {group,halo,position(path,u,type='task') {
    const p=path.getPointAt(u),t=path.getTangentAt(u);
    group.position.set(p.x,.52+p.y,p.z);
    group.rotation.set(-Math.asin(T.MathUtils.clamp(t.y,-1,1)),Math.atan2(t.x,t.z),0,'YXZ');
    if(type!==shade) {shade=type;shell.color.setHex(shades[type][0]);tape.color.setHex(shades[type][1]);}
  }};
}
