import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createLandscape } from './landscape.js';
import { createArchitecture, createBelts } from './models.js';
import { makeLiveScene } from './scene-live.js';
import { live } from './live.js';
import { stations } from './layout.js';
import { connectWeather } from './weather.js';

const byId=id=>document.getElementById(id);
const viewport=byId('viewport');
const renderer=new T.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,1.75));
renderer.shadowMap.enabled=true;
renderer.shadowMap.type=T.PCFShadowMap;
renderer.toneMapping=T.ACESFilmicToneMapping;
renderer.toneMappingExposure=1.11;
renderer.domElement.setAttribute('role','img');
renderer.domElement.setAttribute('aria-label','微缩流水线，圆顶中台连接事件入口、两个接单站、飞书卡片站和结果归档站');
viewport.append(renderer.domElement);

const scene=new T.Scene();
scene.background=new T.Color(0xc8dbe0);
scene.fog=new T.FogExp2(0xc8dbe0,.010);
const camera=new T.PerspectiveCamera(39,1,.18,165);
const orbit=new OrbitControls(camera,renderer.domElement);
orbit.enableDamping=true;
orbit.dampingFactor=.10;
orbit.minPolarAngle=.42;
orbit.maxPolarAngle=1.38;
orbit.minDistance=10;
orbit.maxDistance=72;
orbit.enablePan=true;
orbit.screenSpacePanning=false;
const direction=new T.Vector3(15,24,31).normalize();
const center=new T.Vector3(-.6,.12,-.39);

const ambient=new T.HemisphereLight(0xeaf5ff,0xb19a6d,1.72);
scene.add(ambient);
const sun=new T.DirectionalLight(0xffead0,2.70);
sun.position.set(-17,27,10);
sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);
sun.shadow.camera.left=-22;sun.shadow.camera.right=22;sun.shadow.camera.top=20;sun.shadow.camera.bottom=-21;
sun.shadow.camera.near=4;sun.shadow.camera.far=61;
sun.shadow.normalBias=.032;sun.shadow.bias=-.00026;
scene.add(sun);
const rim=new T.DirectionalLight(0xd7f1f9,.48);
rim.position.set(14,10,-15);scene.add(rim);
const landscape=createLandscape(scene);
const architecture=createArchitecture(scene);
const belts=createBelts(scene);
const tasks=makeLiveScene(scene,belts);

const flakes=new Float32Array(700*3);
for(let i=0;i<flakes.length;i+=3) {
  flakes[i]=(Math.random()-.5)*48;flakes[i+1]=Math.random()*17;flakes[i+2]=(Math.random()-.5)*43;
}
const snowGeo=new T.BufferGeometry();
snowGeo.setAttribute('position',new T.BufferAttribute(flakes,3));
const snowSprite=document.createElement('canvas');snowSprite.width=snowSprite.height=64;
const snowPaint=snowSprite.getContext('2d');
const snowEdge=snowPaint.createRadialGradient(32,32,12,32,32,30);
snowEdge.addColorStop(0,'rgba(255,255,255,1)');snowEdge.addColorStop(1,'rgba(255,255,255,0)');
snowPaint.fillStyle=snowEdge;snowPaint.fillRect(0,0,64,64);
const snowMap=new T.CanvasTexture(snowSprite);
const snow=new T.Points(snowGeo,new T.PointsMaterial({color:0xffffff,map:snowMap,size:.105,transparent:true,opacity:0,alphaTest:.01,depthWrite:false}));
snow.frustumCulled=false;snow.visible=false;scene.add(snow);
const drops=Array.from({length:1050},()=>[(Math.random()-.5)*49,Math.random()*16,(Math.random()-.5)*42,.37+Math.random()*.60]);
const rainLines=new Float32Array(drops.length*6);
const rainGeo=new T.BufferGeometry();
rainGeo.setAttribute('position',new T.BufferAttribute(rainLines,3).setUsage(T.DynamicDrawUsage));
const rain=new T.LineSegments(rainGeo,new T.LineBasicMaterial({color:0xd6ecf6,transparent:true,opacity:0,depthWrite:false}));
rain.frustumCulled=false;rain.visible=false;scene.add(rain);
function buildClouds() {
  const sheet=document.createElement('canvas');sheet.width=256;sheet.height=128;
  const paint=sheet.getContext('2d');
  for(const [x,y,r] of [[66,72,41],[101,54,54],[145,49,47],[185,67,41],[126,80,52]]) {
    const alpha=paint.createRadialGradient(x,y,r*.23,x,y,r);
    alpha.addColorStop(0,'#fffdf4');alpha.addColorStop(.61,'#fffdf4aa');alpha.addColorStop(1,'#fffdf400');
    paint.fillStyle=alpha;paint.fillRect(x-r,y-r,r*2,r*2);
  }
  const map=new T.CanvasTexture(sheet);map.colorSpace=T.SRGBColorSpace;
  return [[-23,9.5,-27,11],[-10,10.6,-33,13],[4,8.6,-25,10],[16,10.6,-34,16],[28,9.9,-29,11],[-34,10.2,-25,12]]
    .map(([x,y,z,w])=>{
      const puff=new T.Sprite(new T.SpriteMaterial({map,color:0xffffff,transparent:true,depthWrite:false,opacity:0}));
      puff.position.set(x,y,z);puff.scale.set(w,w*.46,1);scene.add(puff);return {puff,x};
    });
}
const clouds=buildClouds();

const follow=byId('follow'), stationDetail=byId('station-detail');
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
let tracking=false, transition=0, viewer=null;
let weather={kind:'unknown',night:false}, night=0, winter=0, wet=0, cloud=0, fog=0;
let updatedAt=0;
const noActive=new Set();
let liveActive=noActive;
const worldPoint=new T.Vector3(), centerTo=new T.Vector3(), eyeTo=new T.Vector3(), heading=new T.Vector3();
const daySky=new T.Color(0xc7dae4), nightSky=new T.Color(0x122943), snowSky=new T.Color(0xd1dde1);
const warmLight=new T.Color(0xffead0), moon=new T.Color(0x9dc4f1), overcast=new T.Color(0xf0f5ff);
const wetGround=new T.Color(0x546e71),nightGround=new T.Color(0x365270),snowGround=new T.Color(0xc2cddd);
const cloudySky=new T.Color(0xa4b6c3), rainySky=new T.Color(0x889eaf), wetNight=new T.Color(0x233747);
const park=document.querySelector('.park');
connectWeather(value=>{weather=value;});

const pinSizes=new WeakMap(),pinObserver=new ResizeObserver(entries=>{for(const entry of entries)pinSizes.set(entry.target,[entry.borderBoxSize?.[0]?.inlineSize??entry.contentRect.width,entry.borderBoxSize?.[0]?.blockSize??entry.contentRect.height]);});
const pins=stations.map(station=>{
  const el=document.createElement('button');el.type='button';el.className='pin';
  const dot=document.createElement('i');dot.setAttribute('aria-hidden','true');
  el.append(dot,station.name);
  el.addEventListener('click',()=>selectStation(viewer===station?null:station));
  byId('pins').append(el);pinObserver.observe(el);return {el,station};
});
function overview() {
  const radius=Math.max(30.3,31/camera.aspect);
  return center.clone().addScaledVector(direction,Math.min(65,radius));
}
function resize() {
  const {width,height}=viewport.getBoundingClientRect();
  if(!width||!height)return;
  camera.aspect=width/height;camera.updateProjectionMatrix();renderer.setSize(width,height,false);
  if(!tracking&&!viewer&&transition===0){
    camera.position.copy(overview());orbit.target.copy(center);orbit.update();
  }
  park.style.setProperty('--dock-height',document.querySelector('.dock').offsetHeight+'px');
}
document.addEventListener('keydown',event=>{
  if(event.key.toLowerCase()==='r'&&!/input|textarea|select/i.test(event.target.tagName)){tracking=false;selectStation(null);}
  if(event.key==='Escape'&&viewer)selectStation(null);
});
byId('fullscreen').addEventListener('click',async()=>{
  try {
    if(document.fullscreenElement)await document.exitFullscreen();
    else if(park.requestFullscreen)await park.requestFullscreen();
  } catch {
    stationDetail.textContent='浏览器未允许进入全屏。';stationDetail.hidden=false;
  }
});
if(!park.requestFullscreen)byId('fullscreen').hidden=true;
document.addEventListener('fullscreenchange',()=>{
  byId('fullscreen').setAttribute('aria-label',document.fullscreenElement?'退出全屏':'全屏');resize();
});
function moveCamera() {
  transition=1;
  orbit.enabled=false;
  follow.setAttribute('aria-pressed',String(tracking||!!viewer));
  follow.textContent=tracking||viewer?'返回全景':'跟随包裹';
}
function selectStation(station) {
  viewer=station;tracking=false;
  stationDetail.hidden=!station;
  if(station){stationDetail.textContent=station.description;live.openList(station.id);}
  moveCamera();
}
follow.addEventListener('click',()=>{
  if(viewer){selectStation(null);return;}
  tracking=!tracking;moveCamera();
});
function updateCamera(dt) {
  const parcel=tracking?tasks.focused():null;
  if(tracking&&!parcel){tracking=false;moveCamera();}
  if(parcel) {
    const rotation=parcel.rotation.y;
    heading.set(Math.sin(rotation),0,Math.cos(rotation));
    centerTo.copy(parcel.position).add(new T.Vector3(0,.48,0));
    eyeTo.copy(centerTo).addScaledVector(heading,-3.45);
    eyeTo.x+=4.5;eyeTo.z+=4.3;eyeTo.y+=2.42;
    const dx=eyeTo.x-centerTo.x,dz=eyeTo.z-centerTo.z,length=dx*dx+dz*dz;
    for(const {at:[x,,z],radius,height} of stations) {
      const u=length>0 ? T.MathUtils.clamp(((x-centerTo.x)*dx+(z-centerTo.z)*dz)/length,0,1) : 0;
      if(u<.11||Math.hypot(centerTo.x+u*dx-x,centerTo.z+u*dz-z)>radius+.22)continue;
      eyeTo.y=Math.max(eyeTo.y,Math.min(centerTo.y+7,centerTo.y+(height+.38-centerTo.y)/u));
    }
  } else if(viewer&&transition>0) {
    const [x,,z]=viewer.at;
    centerTo.set(x,1.30,z);
    eyeTo.copy(centerTo).add(new T.Vector3(3.05,2.05,5.75).multiplyScalar(Math.max(1,1.02/camera.aspect)));
  } else if(transition>0) {
    centerTo.copy(center);eyeTo.copy(overview());
  }
  if(tracking||transition>0) {
    const speed=reduced.matches?1:1-Math.exp(-dt*4.25);
    camera.position.lerp(eyeTo,speed);
    orbit.target.lerp(centerTo,speed);
    camera.lookAt(orbit.target);
    if(!tracking&&camera.position.distanceTo(eyeTo)<.16) {
      transition=0;orbit.minDistance=viewer?4.5:10;orbit.enabled=true;orbit.update();
    }
  } else {orbit.target.x=T.MathUtils.clamp(orbit.target.x,-14,14);orbit.target.z=T.MathUtils.clamp(orbit.target.z,-12,12);orbit.update();}
}
function updatePins() {
  const w=viewport.clientWidth,h=viewport.clientHeight;
  const placed=[];
  const ordered=[...pins].sort((a,b)=>Number(tasks.talking(b.station.id))-Number(tasks.talking(a.station.id)));
  for(const {station,el} of ordered) {
    const label=tasks.label(station);
    if(el.lastChild?.nodeValue!==label)el.lastChild.nodeValue=label;
    el.classList.toggle('active',tasks.talking(station.id));
    worldPoint.fromArray(station.at).project(camera);
    const px=(worldPoint.x*.5+.5)*w,py=(.5-worldPoint.y*.5)*h;
    el.hidden=worldPoint.z>1||px<0||px>w||py<-6||py>h||(viewer?viewer!==station:tracking);
    if(el.hidden)continue;
    const [bw,bh]=pinSizes.get(el)??[140,32];
    const x=T.MathUtils.clamp(px-bw*.5,4,w-bw-4);
    const options=[0,-(bh+7),bh+7].map(y=>T.MathUtils.clamp(py-bh+y,10,h-bh-52));
    const y=options.find(y=>!placed.some(([a,b,c,d])=>x<a+c+6&&x+bw+6>a&&y<b+d+6&&y+bh+6>b));
    el.hidden=y===undefined;
    if(y===undefined)continue;
    placed.push([x,y,bw,bh]);
    el.style.transform='translate('+Math.round(x)+'px,'+Math.round(y)+'px)';
  }
}
function updateEnvironment(dt,seconds) {
  const weight=reduced.matches?1:1-Math.exp(-dt*2.4);
  const kind=weather.kind;
  document.body.classList.toggle('night',weather.night);
  night=T.MathUtils.lerp(night,Number(weather.night),weight);
  winter=T.MathUtils.lerp(winter,Number(kind==='snow'),weight);
  wet=T.MathUtils.lerp(wet,kind==='storm'?1:kind==='rain'?.79:0,weight);
  cloud=T.MathUtils.lerp(cloud,kind==='cloud'?.52:['overcast','rain','snow','storm','fog'].includes(kind)?1:0,weight);
  fog=T.MathUtils.lerp(fog,Number(kind==='fog'),weight);
  sun.intensity=T.MathUtils.lerp(2.70,.33,night)*(1-cloud*.52-wet*.11);
  sun.color.copy(warmLight).lerp(overcast,cloud*.83).lerp(moon,night);
  ambient.intensity=T.MathUtils.lerp(1.72,.68,night)*(1-wet*.16);
  ambient.groundColor.setHex(0xb19a6d).lerp(wetGround,wet*.7).lerp(nightGround,night).lerp(snowGround,winter);
  rim.intensity=.48+night*.31;
  scene.background.copy(daySky).lerp(cloudySky,cloud*.72).lerp(rainySky,wet).lerp(snowSky,winter)
    .lerp(nightSky,night).lerp(wetNight,night*wet*.6);
  scene.fog.color.copy(scene.background);scene.fog.density=.010+night*.010+winter*.020+wet*.014+fog*.042;
  for(const [i,{puff,x}] of clouds.entries()) {
    puff.visible=cloud>.03;
    puff.material.opacity=cloud*(.68-night*.36)*(1-wet*.32);
    puff.position.x=x+(reduced.matches?0:Math.sin(seconds*.095+i*.3)*.9);
  }
  architecture.update(night,seconds,liveActive,tasks.roles(),reduced.matches);
  belts.wet(wet);
  landscape.update(seconds,night,winter);
  snow.visible=winter>.01;snow.material.opacity=winter*.78;
  if(snow.visible&&!reduced.matches) {
    for(let i=0;i<flakes.length;i+=3) {
      flakes[i]+=Math.sin(seconds*.76+i)*dt*.31;flakes[i+1]-=dt*(.72+i%13*.047);
      if(flakes[i+1]<.15)flakes[i+1]=17;
    }
    snowGeo.attributes.position.needsUpdate=true;
  }
  rain.visible=wet>.01;rain.material.opacity=wet*(reduced.matches?.18:.58);
  if(rain.visible) {
    for(let i=0;i<drops.length;i++) {
      const d=drops[i];
      if(!reduced.matches){
        d[0]+=dt*.95;d[1]-=dt*(8.1+d[3]*2.8);
        if(d[0]>24.5)d[0]=-24.5;
        if(d[1]<0)d[1]=16;
      }
      const offset=i*6;
      rainLines[offset]=d[0];rainLines[offset+1]=d[1];rainLines[offset+2]=d[2];
      rainLines[offset+3]=d[0]-.12;rainLines[offset+4]=d[1]+d[3];rainLines[offset+5]=d[2]-.04;
    }
    rainGeo.attributes.position.needsUpdate=true;
  }
}
let firstPaint=true;
function frame(stamp) {
  requestAnimationFrame(frame);
  if(document.hidden)return;
  if(updatedAt&&stamp-updatedAt<27)return;
  const dt=updatedAt?Math.min(.09,(stamp-updatedAt)/1000):.04;
  updatedAt=stamp;
  updateCamera(dt);
  camera.updateMatrixWorld();
  liveActive=tasks.paint(stamp,camera,viewport.clientWidth,viewport.clientHeight,{tracking,viewer,reduced:reduced.matches});
  if(!reduced.matches)belts.update(stamp*.001,tasks.routes());
  updateEnvironment(dt,stamp/1000);
  renderer.render(scene,camera);
  updatePins();
  if(firstPaint){firstPaint=false;byId('loading').hidden=true;}
}
new ResizeObserver(resize).observe(viewport);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)updatedAt=0;});
resize();requestAnimationFrame(frame);

const raycaster=new T.Raycaster(),pointer=new T.Vector2();let pressed;
renderer.domElement.addEventListener('pointerdown',event=>{pressed=[event.clientX,event.clientY];});
renderer.domElement.addEventListener('pointerup',event=>{
  if(!pressed||Math.hypot(event.clientX-pressed[0],event.clientY-pressed[1])>5)return;pressed=null;
  const rect=renderer.domElement.getBoundingClientRect();pointer.set((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2);raycaster.setFromCamera(pointer,camera);
  for(const hit of raycaster.intersectObjects(scene.children,true)){
    let visible=true;for(let node=hit.object;node;node=node.parent)if(!node.visible)visible=false;if(!visible)continue;
    let object=hit.object;while(object){if(object.userData.entry&&object.visible){live.select(object.userData.entry,true);return;}object=object.parent;}
    const station=stations.find(station=>Math.hypot(hit.point.x-station.at[0],hit.point.z-station.at[2])<station.radius);
    if(station){selectStation(station);return;}
  }
});
