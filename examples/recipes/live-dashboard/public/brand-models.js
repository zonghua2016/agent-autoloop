import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { contours } from './brand/contours.js';

const sphere=new T.SphereGeometry(1,28,18);
const materials={
  pearl:new T.MeshPhysicalMaterial({color:0xfffbef,roughness:.43,clearcoat:.25}),
  pupil:new T.MeshPhysicalMaterial({color:0x172b59,roughness:.19,clearcoat:.44}),
  glint:new T.MeshBasicMaterial({color:0xffffff,toneMapped:false}),
  blush:new T.MeshStandardMaterial({color:0xec9ea5,roughness:.54}),
  gold:new T.MeshStandardMaterial({color:0xc6a362,metalness:.48,roughness:.38}),
};
const material=(color,roughness=.35,shine=.43)=>new T.MeshPhysicalMaterial({color,roughness,metalness:.12,clearcoat:shine,clearcoatRoughness:.22});
function mesh(parent,geo,finish,x=0,y=0,z=0,shadow=true){
  const m=new T.Mesh(geo,finish);m.position.set(x,y,z);m.castShadow=shadow;m.receiveShadow=shadow;parent.add(m);return m;
}
function rounded(parent,finish,x,y,z,w,h,d,r=.04){
  return mesh(parent,new RoundedBoxGeometry(w,h,d,3,Math.min(r,w/2,h/2,d/2)),finish,x,y,z);
}
function oval(parent,finish,x,y,z,w,h,d,shadow=true){
  const m=mesh(parent,sphere,finish,x,y,z,shadow);m.scale.set(w,h,d);return m;
}
function group(parent,x=0,y=0,z=0){
  const g=new T.Group();g.position.set(x,y,z);parent.add(g);return g;
}
function graphicPath(path,points,convert){
  for(const [i,p] of points.entries()){
    const {x,y}=convert(p);if(i)path.lineTo(x,y);else path.moveTo(x,y);
  }
  path.closePath();
  return path;
}
function polish(geometry){
  const position=geometry.getAttribute('position'), normal=geometry.getAttribute('normal');
  const keys=[], sums=new Map(), n=new T.Vector3();
  for(let i=0;i<position.count;i++){
    const key=[position.getX(i),position.getY(i),position.getZ(i)].map(v=>Math.round(v*1e5)).join(':');
    keys.push(key);
    if(!sums.has(key))sums.set(key,new T.Vector3());
    sums.get(key).add(n.fromBufferAttribute(normal,i));
  }
  for(const sum of sums.values())sum.normalize();
  for(const [i,key] of keys.entries()){
    const v=sums.get(key);normal.setXYZ(i,v.x,v.y,v.z);
  }
  normal.needsUpdate=true;
}
const hiddenCap=new T.MeshBasicMaterial({visible:false});
function roundedSurface(flat,zAt,uvAt,back=false){
  const position=flat.getAttribute('position'), source=flat.getIndex().array;
  const vertices=[],uvs=[],indices=[],known=new Map(),boundary=new Map(),seam=new Map();
  const subdivisions=2;
  const point=index=>[position.getX(index),position.getY(index)];
  const pointKey=(x,y)=>Math.round(x*1e7)+':'+Math.round(y*1e7);
  for(let i=0;i<source.length;i+=3){
    const [a,b,c]=[source[i],source[i+1],source[i+2]];
    for(const [from,to] of [[a,b],[b,c],[c,a]]){
      const edge=from<to?from+':'+to:to+':'+from;
      if(!boundary.delete(edge))boundary.set(edge,[from,to]);
    }
  }
  // The rim uses the original contour edges, so keep the subdivided cap stitched to them.
  const steps=2**subdivisions;
  for(const [from,to] of boundary.values()){
    const [ax,ay]=point(from),[bx,by]=point(to);
    const start=zAt(ax,ay),end=zAt(bx,by);
    for(let step=0;step<=steps;step++){
      const t=step/steps;
      seam.set(pointKey(T.MathUtils.lerp(ax,bx,t),T.MathUtils.lerp(ay,by,t)),T.MathUtils.lerp(start,end,t));
    }
  }
  function vertex(x,y){
    const key=pointKey(x,y);
    if(known.has(key))return known.get(key);
    const index=vertices.length/3;
    known.set(key,index);
    vertices.push(x,y,seam.get(key)??zAt(x,y));
    uvs.push(...uvAt(x,y));
    return index;
  }
  function triangle(a,b,c,depth){
    if(depth===0){
      const [i,j,k]=[a,b,c].map(([x,y])=>vertex(x,y));
      indices.push(i,...(back?[k,j]:[j,k]));
      return;
    }
    const ab=[(a[0]+b[0])/2,(a[1]+b[1])/2];
    const bc=[(b[0]+c[0])/2,(b[1]+c[1])/2];
    const ca=[(c[0]+a[0])/2,(c[1]+a[1])/2];
    triangle(a,ab,ca,depth-1);triangle(ab,b,bc,depth-1);
    triangle(ca,bc,c,depth-1);triangle(ab,bc,ca,depth-1);
  }
  for(let i=0;i<source.length;i+=3){
    const [a,b,c]=[source[i],source[i+1],source[i+2]].map(point);
    triangle(a,b,c,subdivisions);
  }
  const geometry=new T.BufferGeometry();
  geometry.setAttribute('position',new T.Float32BufferAttribute(vertices,3));
  geometry.setAttribute('uv',new T.Float32BufferAttribute(uvs,2));
  geometry.setIndex(indices);geometry.computeVertexNormals();
  return geometry;
}
function emblem(parent,name,width,y,enamel,{depth,edge,front,back,face}){
  const {pixels:[imW,imH],bounds:[x,y0,w,h],outline,holes}=contours[name];
  const scale=width/w,cx=x+w/2,cy=y0+h/2;
  const toLocal=([u,v])=>({x:(u-cx)*scale,y:(cy-v)*scale});
  const shape=graphicPath(new T.Shape(),outline,toLocal);
  shape.holes=holes.map(points=>graphicPath(new T.Path(),points,toLocal));
  const holder=group(parent,0,y,0);

  // Dome both faces without changing the original front silhouette or UVs.
  const bevel=.077, zBase=depth/2+bevel;
  const relief=(x,y)=>Math.max(.05,1-.55*(x/(width*.5))**2-.59*(y/(h*scale*.5))**2);
  const frontAt=(x,y)=>zBase+front*relief(x,y);
  const rearAt=(x,y)=>-zBase-back*relief(x,y);
  const shapeUV=(x,y)=>[(x/scale+cx)/imW,1-(cy-y/scale)/imH];
  const body=new T.ExtrudeGeometry(shape,{depth,bevelEnabled:true,bevelSegments:6,bevelSize:edge,bevelThickness:bevel,curveSegments:18});
  const skin=body.getAttribute('position');
  for(let i=0;i<skin.count;i++){
    const x=skin.getX(i),y=skin.getY(i),z=skin.getZ(i)-depth/2;
    const t=T.MathUtils.clamp(z/zBase,-1,1);
    skin.setZ(i,z+relief(x,y)*t*(t<0?back:front));
  }
  body.computeVertexNormals();
  polish(body);
  mesh(holder,body,[hiddenCap,enamel]);
  const flat=new T.ShapeGeometry(shape);
  const frontMesh=mesh(holder,roundedSurface(flat,frontAt,shapeUV),face);
  frontMesh.name='codex-white-face';
  mesh(holder,roundedSurface(flat,rearAt,shapeUV,true),enamel);
  flat.dispose();
  function mount(x,y,offset){
    const pose=group(holder,x,y,frontAt(x,y)+offset);
    const d=.002;
    const normal=new T.Vector3(-(frontAt(x+d,y)-frontAt(x-d,y))/(2*d),-(frontAt(x,y+d)-frontAt(x,y-d))/(2*d),1).normalize();
    pose.quaternion.setFromUnitVectors(new T.Vector3(0,0,1),normal);
    return pose;
  }
  return {holder,mount,toLocal};
}
function eye(parent,x,y,z,size=.082){
  const shell=group(parent,x,y,z);
  oval(shell,materials.pearl,0,0,0,size,size*1.15,size*.39,false);
  oval(shell,materials.pupil,size*.07,-size*.015,size*.28,size*.60,size*.76,size*.19,false);
  oval(shell,materials.glint,-size*.13,size*.33,size*.43,size*.16,size*.18,size*.06,false);
  return shell;
}
function mouth(parent,x,y,z,width=.14){
  const pts=[new T.Vector3(-width/2,.019,0),new T.Vector3(0,-.019,.012),new T.Vector3(width/2,.019,0)];
  mesh(parent,new T.TubeGeometry(new T.CatmullRomCurve3(pts),16,.011,8),materials.pupil,x,y,z,false);
}
function foot(parent,finish,x,y,z){
  const g=group(parent,x,y,z);
  rounded(g,finish,0,0,0,.30,.15,.34,.065);
  rounded(g,materials.gold,0,-.060,.017,.28,.034,.29,.015);
  return g;
}
function hand(parent,finish,mitt,sign,x,y,z){
  const pivot=group(parent,x,y,z);
  oval(pivot,materials.gold,0,0,0,.075,.079,.075);
  mesh(pivot,new T.CapsuleGeometry(.052,.14,6,12),finish,sign*.092,-.09,0).rotation.z=sign*.59;
  oval(pivot,mitt,sign*.163,-.194,.016,.082,.089,.072);
  oval(pivot,mitt,sign*.211,-.193,.022,.036,.048,.042);
  return pivot;
}
function codexLeg(parent,blue,silver,x){
  const hip=group(parent,x,.459,-.012);
  oval(hip,materials.gold,0,-.025,0,.082,.082,.086);
  mesh(hip,new T.CapsuleGeometry(.060,.132,8,16),blue,0,-.124,0);
  oval(hip,silver,0,-.214,.01,.070,.074,.071);
  mesh(hip,new T.CapsuleGeometry(.051,.055,8,16),blue,0,-.273,.012);
  foot(hip,silver,0,-.358,.068);
  return hip;
}
function sculptedBody(parent,profile,top,belly){
  // Cross-sections follow the spine so a thin tail joins a rounded body without a rim.
  const spine=new T.CatmullRomCurve3(profile.map(([x,y])=>new T.Vector3(x,y,0)));
  const sections=new T.SplineCurve(profile.map(([,,height,depth])=>new T.Vector2(height,depth)));
  function surface(u,angle){
    const center=spine.getPoint(u),r=sections.getPoint(u);
    center.y+=Math.max(.002,r.x)*Math.cos(angle);
    center.z=Math.max(.002,r.y)*Math.sin(angle);
    return center;
  }
  const length=52,sides=56,points=[],colors=[],indices=[];
  const upper=new T.Color(top),lower=new T.Color(belly),color=new T.Color();
  for(let row=0;row<=length;row++){
    const u=row/length;
    for(let side=0;side<sides;side++){
      const angle=side/sides*2*Math.PI;
      points.push(...surface(u,angle).toArray());
      const shade=(1-T.MathUtils.smoothstep(Math.cos(angle),-.75,-.07))*(1-.50*T.MathUtils.smoothstep(u,.64,1));
      colors.push(...color.copy(upper).lerp(lower,shade).toArray());
      if(row===length)continue;
      const a=row*sides+side,b=row*sides+(side+1)%sides;
      indices.push(a,b,a+sides,b,b+sides,a+sides);
    }
  }
  for(let side=1;side<sides-1;side++){
    indices.push(0,side+1,side,length*sides,length*sides+side,length*sides+side+1);
  }
  const geometry=new T.BufferGeometry();
  geometry.setAttribute('position',new T.Float32BufferAttribute(points,3));
  geometry.setAttribute('color',new T.Float32BufferAttribute(colors,3));
  geometry.setIndex(indices);geometry.computeVertexNormals();
  const finish=material(0xffffff,.40,.29);
  finish.vertexColors=true;
  mesh(parent,geometry,finish);

  function facePoint(u,angle,offset=0){
    const position=surface(u,angle);
    const vertical=surface(u,angle+.002).sub(surface(u,angle-.002));
    const along=surface(u+.002,angle).sub(surface(u-.002,angle));
    const normal=vertical.cross(along).normalize();
    return {position:position.addScaledVector(normal,offset),normal};
  }
  function mount(u,angle,offset){
    const {position,normal}=facePoint(u,angle,offset);
    const pose=group(parent,...position.toArray());
    pose.quaternion.setFromUnitVectors(new T.Vector3(0,0,1),normal);
    return pose;
  }
  return {facePoint,mount};
}
function shapedFoil(parent,finish,outline,hub,depth){
  // Taper both faces into the same rounded perimeter, including out-of-plane bends.
  const contour=outline.map(point=>new T.Vector3(...point));
  const area=contour.reduce((sum,a,i)=>{
    const b=contour[(i+1)%contour.length];
    return sum+a.x*b.y-a.y*b.x;
  },0);
  if(area<0)contour.reverse();
  const path=new T.CatmullRomCurve3(contour,true);
  const center=new T.Vector3(...hub),rowCount=14,sides=56;
  const points=[center.x,center.y,center.z+depth],indices=[];
  const perimeter=Array.from({length:sides},(_,i)=>path.getPoint(i/sides));
  const point=new T.Vector3();
  for(let row=1;row<rowCount;row++){
    const sweep=row/rowCount*Math.PI;
    for(const edge of perimeter){
      point.copy(center).lerp(edge,Math.sin(sweep));
      point.z+=Math.cos(sweep)*depth;
      points.push(...point.toArray());
    }
  }
  const back=points.length/3;
  points.push(center.x,center.y,center.z-depth);
  for(let side=0;side<sides;side++){
    const nextSide=(side+1)%sides;
    indices.push(0,side+1,nextSide+1);
    for(let row=0;row<rowCount-2;row++){
      const a=1+row*sides+side,b=1+row*sides+nextSide;
      indices.push(a,a+sides,b,b,a+sides,b+sides);
    }
    indices.push(back,back-sides+nextSide,back-sides+side);
  }
  const geometry=new T.BufferGeometry();
  geometry.setAttribute('position',new T.Float32BufferAttribute(points,3));
  geometry.setIndex(indices);geometry.computeVertexNormals();
  return mesh(parent,geometry,finish);
}
function blink(eyes,t,shift,reduced){
  const phase=(t+shift)%4.7;
  const closure=!reduced&&phase<.24?Math.sin(phase/.24*Math.PI):0;
  for(const e of eyes)e.scale.y=1-.92*closure;
}
function orbit(parent,r,color){
  const path=mesh(parent,new T.TorusGeometry(r,.010,8,64),materials.gold,0,.051,0,false);
  path.rotation.x=-Math.PI/2;
  const pivot=group(parent,0,.062,0);
  const jewel=new T.MeshStandardMaterial({color,emissive:color,emissiveIntensity:.26,roughness:.34});
  for(const a of [0,2.09,4.19]){
    oval(pivot,jewel,r*Math.cos(a),.008,r*Math.sin(a),.034,.025,.034,false);
  }
  return pivot;
}
export function makeCodexMascot(parent){
  const blue=material(0x625afa,.36,.35),silver=material(0xcad8f6,.31);
  const rim=orbit(parent,1.19,0x6862f4);
  const puppet=group(parent);
  const legs=[codexLeg(puppet,blue,silver,-.185),codexLeg(puppet,blue,silver,.185)];
  oval(puppet,blue,0,.658,.005,.355,.306,.246);
  oval(puppet,silver,0,.658,.196,.225,.164,.076);
  rounded(puppet,blue,0,.650,.268,.137,.037,.024,.012);
  oval(puppet,materials.gold,0,.952,.008,.123,.126,.129);
  const headY=1.481;
  const {holder:cloud,mount,toLocal}=emblem(puppet,'codex',1.18,headY,blue,{depth:.27,edge:.057,front:.168,back:.127,face:new T.MeshPhysicalMaterial({color:0xffffff,roughness:.72,metalness:0,clearcoat:.12,emissive:0xffffff,emissiveIntensity:.10})});
  // Facial features follow the curved face and its head movement.
  const eyes=[[426,470],[598,470]].map(point=>{
    const {x,y}=toLocal(point);
    return eye(mount(x,y,.012),0,0,0,.082);
  });
  const smile=toLocal([512,548]);
  const smileMount=mount(smile.x,smile.y,.012);smileMount.scale.setScalar(1.2);
  mouth(smileMount,0,0,0,.14);
  const arms=[hand(puppet,blue,materials.pearl,-1,-.321,.804,.002),hand(puppet,blue,materials.pearl,1,.321,.804,.002)];
  return (t,active,reduced)=>{
    const m=reduced?0:Math.sin(t*3.1);
    cloud.position.y=headY+m*(active?.040:.019);cloud.rotation.y=m*(active?.11:.035);
    cloud.rotation.z=m*(active?.043:.018);
    puppet.rotation.y=reduced?0:.065*Math.sin(t*1.27);
    arms[0].rotation.z=-.18+m*(active?.24:.08);
    arms[1].rotation.z=active&&!reduced?.61+.52*Math.sin(t*4.4):.18-m*.08;
    legs[0].rotation.x=active?m*.148:0;legs[1].rotation.x=active?-m*.148:0;
    blink(eyes,t,.76,reduced);rim.rotation.y=reduced?0:t*(active?.55:.15);
  };
}

export function makeDeepSeekMascot(parent){
  const cobalt=material(0x4d6bfe,.39,.32),flipperBlue=material(0x647ffc,.43,.28);
  const rim=orbit(parent,1.19,0x4d6bfe),puppet=group(parent);
  const whale=sculptedBody(puppet,[
    [-.89,1.133,.003,.003],[-.81,1.109,.251,.224],[-.635,1.074,.442,.376],
    [-.40,1.047,.508,.425],[-.13,1.038,.473,.395],[.125,1.060,.369,.319],
    [.35,1.174,.253,.222],[.51,1.335,.169,.159],[.595,1.503,.100,.108],[.619,1.580,.006,.017]
  ],0x4d6bfe,0xa4c7ff);
  const eyes=[];
  for(const side of [-1,1]){
    eyes.push(eye(whale.mount(.414,side*1.28,.007),0,0,0,.066));
    oval(whale.mount(.469,side*1.51,.006),materials.blush,0,0,0,.050,.022,.010,false);
    const lip=[[.129,1.50],[.216,1.81],[.318,2.00],[.422,2.04],[.505,1.91]];
    const curve=new T.CatmullRomCurve3(lip.map(([u,angle])=>whale.facePoint(u,side*angle,.004).position));
    mesh(puppet,new T.TubeGeometry(curve,28,.011,8),materials.pupil,0,0,0,false);
  }
  shapedFoil(puppet,cobalt,[[-.54,1.484,-.025],[-.38,1.568,-.033],[-.18,1.700,-.10],[-.19,1.612,-.09],[-.096,1.451,-.023]],[-.30,1.540,-.056],.043);
  const tail=group(puppet,.587,1.526,0);
  shapedFoil(tail,cobalt,[
    [-.099,-.038,-.037],[-.070,.201,-.042],[-.280,.500,-.116],[-.300,.344,-.170],[-.201,.106,-.107],[-.021,-.043,.011]
  ],[-.141,.183,-.078],.062);
  shapedFoil(tail,cobalt,[
    [-.064,-.029,-.008],[.173,.030,.122],[.378,.299,.196],[.370,.444,.199],[.202,.329,.130],[.064,.260,.079],[-.063,.146,.021]
  ],[.162,.197,.103],.069);
  const flippers=[-1,1].map(side=>{
    const fin=group(puppet,.070,.805,side*.223);
    shapedFoil(fin,flipperBlue,[[-.199,.101,0],[.020,.149,side*.038],[.246,-.011,side*.268],[.264,-.110,side*.257],[.086,-.103,side*.171],[-.061,-.015,side*.082]],
      [.052,.008,side*.112],.044);
    return fin;
  });
  const trail=[];
  const bubble=new T.MeshPhysicalMaterial({color:0xc5e8fe,emissive:0x36567b,emissiveIntensity:.15,roughness:.2,clearcoat:.77,transparent:true,opacity:.87});
  for(let i=0;i<3;i++)trail.push(oval(parent,bubble,-.72+i*.14,.43+i*.11,.29,.040+i*.015,.040+i*.015,.040+i*.015,false));
  return (t,active,reduced)=>{
    const wave=reduced?0:Math.sin(t*2.55+.94);
    puppet.position.y=wave*(active?.090:.045);
    puppet.rotation.z=wave*(active?.106:.050);
    puppet.rotation.y=reduced?0:.14*Math.sin(t*1.35);
    tail.rotation.z=wave*(active?.18:.090);tail.rotation.y=wave*.107;
    flippers[0].rotation.x=wave*.263;flippers[1].rotation.x=-wave*.263;
    for(const [i,b] of trail.entries()){
      const step=reduced?0:(t*(active?1.2:.62)+i*.27)%1;
      b.position.y=.24+i*.085+step*.30;b.position.x=-.77+i*.11-step*.11;
    }
    blink(eyes,t,2.22,reduced);rim.rotation.y=reduced?0:-t*(active?.48:.15);
  };
}

export function makeFeishuMascot(parent){
  const blue=material(0x4386ed,.52,.22),teal=material(0x35bcb2,.53,.20);
  const navy=material(0x2858ac,.57,.16),cream=materials.pearl;
  const beak=material(0xf5c16e,.60,.14);
  const rim=orbit(parent,1.19,0x35bcb2),puppet=group(parent,0,-.10,0);
  puppet.name='feishu-messenger';
  const feet=[-.18,.18].map(x=>{
    const leg=group(puppet,x,.10,0);
    mesh(leg,new T.CapsuleGeometry(.080,.07,6,12),navy,0,.185,.01);
    oval(leg,beak,0,.082,.12,.125,.078,.175);
    return leg;
  });
  const torso=group(puppet,0,.78,0);
  oval(torso,blue,0,0,0,.40,.46,.31);
  oval(torso,cream,0,-.015,.256,.29,.33,.083);
  const tail=group(torso,0,-.12,-.23);
  for(const [i,x] of [-.13,0,.13].entries()){
    const feather=oval(tail,i===1?teal:blue,x,.06,-.16,.10,.12,.30);
    feather.rotation.y=x*2;feather.rotation.x=-.25;
  }
  const head=group(puppet,0,1.36,.025);head.name='feishu-head';
  oval(head,blue,0,0,0,.52,.46,.40);
  oval(head,cream,0,-.015,.331,.425,.335,.154);
  const eyes=[-.17,.17].map(x=>eye(head,x,.055,.477,.090));
  for(const x of [-.29,.29])oval(head,materials.blush,x,-.072,.450,.058,.027,.015,false);
  oval(head,beak,0,-.105,.507,.102,.052,.116);
  oval(head,beak,0,-.154,.512,.073,.025,.072);
  const crest=group(head,-.06,.415,-.06);
  for(const [i,x] of [-.10,0,.10].entries()){
    const feather=oval(crest,i===1?teal:blue,x,.065,-i*.038,.072,.16-i*.025,.075);
    feather.rotation.z=-.30+i*.16;feather.rotation.x=-.45;
  }
  const wings=[-1,1].map(sign=>{
    const wing=group(puppet,sign*.36,.91,.025);
    const color=sign<0?teal:blue;
    oval(wing,color,sign*.045,-.15,.06,.16,.30,.125);
    for(let i=0;i<3;i++){
      const feather=oval(wing,color,sign*(.075-i*.045),-.34+i*.016,.10,.060,.105,.071);
      feather.rotation.z=sign*.2;
    }
    wing.rotation.z=sign*.30;return wing;
  });
  const mail=group(puppet,0,.65,.407);mail.name='feishu-envelope';
  rounded(mail,materials.gold,0,0,0,.64,.397,.078,.040);
  rounded(mail,cream,0,0,.040,.603,.36,.035,.027);
  const crease=[new T.Vector3(-.270,.139,.064),new T.Vector3(0,-.047,.072),new T.Vector3(.270,.139,.064)];
  mesh(mail,new T.TubeGeometry(new T.CatmullRomCurve3(crease),18,.010,8),teal,0,0,0,false);
  oval(mail,teal,0,-.046,.075,.043,.043,.015,false);
  for(const sign of [-1,1]){
    const grip=oval(mail,sign<0?teal:blue,sign*.298,-.042,.035,.081,.109,.067);
    grip.rotation.z=-sign*.38;
  }
  return (t,active,reduced)=>{
    const wave=reduced?0:Math.sin(t*(active?2.5:1.6));
    const lift=active&&!reduced?.045*(.5+.5*wave):0;
    puppet.rotation.y=reduced?0:Math.sin(t*.85)*.045;
    head.position.y=1.36+wave*(active?.025:.012);
    head.rotation.z=wave*(active?.055:.025);
    crest.rotation.z=wave*.04;tail.rotation.x=wave*(active?.10:.035);
    for(const [i,wing] of wings.entries())wing.rotation.z=(i?1:-1)*(.30+lift*1.4);
    mail.position.y=.65+lift;mail.rotation.z=wave*(active?.045:.012);
    feet[0].rotation.x=wave*(active?.065:0);feet[1].rotation.x=-wave*(active?.065:0);
    blink(eyes,t,3.08,reduced);rim.rotation.y=reduced?0:t*(active?.48:.12);
  };
}

export function makeRobotMascot(parent){
  const body=group(parent,0,.8,0),mint=material(0x7cbbb0);
  rounded(body,mint,0,0,0,.85,.8,.62,.12);
  rounded(body,materials.pearl,0,.6,0,1,.65,.62,.15);
  for(const x of [-.22,.22])oval(body,materials.pupil,x,.62,.32,.07,.10,.04);
  for(const x of [-.36,.36]){rounded(body,materials.gold,x,-.6,0,.22,.4,.25);}
  return (seconds,active,reduced)=>{body.position.y=.8+(active&&!reduced?Math.sin(seconds*3)*.07:0);};
}
export function makeGeminiMascot(parent){
  const body=group(parent,0,1,0);
  function star(size,color,x,y,z){
    const shape=new T.Shape();for(let i=0;i<8;i++){const a=Math.PI/2+i*Math.PI/4,r=i%2?size*.28:size;if(!i)shape.moveTo(Math.cos(a)*r,Math.sin(a)*r);else shape.lineTo(Math.cos(a)*r,Math.sin(a)*r);}shape.closePath();
    const gem=mesh(body,new T.ExtrudeGeometry(shape,{depth:.16,bevelEnabled:true,bevelSize:.04,bevelThickness:.04,bevelSegments:2}),material(color),x,y,z);return gem;
  }
  const main=star(.72,0x7b92ed,0,0,0),small=star(.29,0xb5a0ed,.54,.48,.05);
  for(const x of [-.13,.13])oval(body,materials.pupil,x,-.06,.20,.035,.055,.02,false);
  const orbit=mesh(body,new T.TorusGeometry(.96,.018,6,48),materials.gold);orbit.rotation.x=1.1;orbit.rotation.y=.25;
  return (seconds,active,reduced)=>{body.position.y=1+(active&&!reduced?Math.sin(seconds*2.8)*.13:0);main.rotation.z=active&&!reduced?Math.sin(seconds)*.08:0;small.rotation.z=active&&!reduced?seconds*.7:0;orbit.rotation.z=active&&!reduced?seconds*.5:0;};
}
export function makeThinkMascots(parent){
  const whale=group(parent,-.95,-.12,-.45),star=group(parent,.80,.25,.68);whale.scale.setScalar(.62);star.scale.setScalar(.77);
  const a=makeDeepSeekMascot(whale),b=makeGeminiMascot(star);
  const arc=mesh(parent,new T.TorusGeometry(.66,.025,6,32,Math.PI),material(0x91d8e6),-.35,.85,.40,false);arc.rotation.y=Math.PI/2;
  return (seconds,active,reduced,role)=>{a(seconds,!!role?.deepseek,reduced);b(seconds,!!role?.gemini,reduced);arc.visible=!!role?.deepseek&&!!role?.gemini;};
}
