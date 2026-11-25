import {stations,routes} from './layout.js';
import * as THREE from 'three';

const pond = { x: -6.65, z: -4.95, rx: 2.44, rz: 1.56 };
const clearings = [[-9, 3, 2.65], [-1, -2, 2.75], [7, -4.5, 2.9], [7, 4.2, 2.8], [0, 6.8, 2.7], [-1, -7.4, 2.45]];
const treeTones = ['#6d9c58', '#83aa61', '#568f65', '#739e61', '#98af62', '#58805b'];
const groveTones = ['#628e64', '#76a365', '#81a36d', '#537d59'];
const autumnTones = ['#c2a553', '#dabc67', '#a6ad5e', '#bd8d4e'];

function random(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function sample(list, rand) {
  return list[Math.floor(rand() * list.length)];
}

function texture(size, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  paint(canvas.getContext('2d'));
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  return map;
}

function earthTexture() {
  const size = 512;
  const map = texture(size, ctx => {
    const rand = random(24);
    ctx.fillStyle = '#7f9955';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 100; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 12 + rand() * 44;
      const veil = rand() < .51 ? 'rgba(64,90,50,.3)' : 'rgba(183,191,109,.32)';
      for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) {
        if (x + dx + r < 0 || x + dx - r > size || y + dy + r < 0 || y + dy - r > size) continue;
        const gradient = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        gradient.addColorStop(0, veil);
        gradient.addColorStop(1, 'rgba(127,153,85,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
      }
    }
    const grains = ['#b6ba82', '#9fa668', '#9cab67', '#64864f', '#739050', '#546e43'];
    ctx.globalAlpha = .49;
    for (let i = 0; i < 21000; i++) {
      ctx.fillStyle = sample(grains, rand);
      ctx.fillRect(rand() * size, rand() * size, .3 + rand() * 2, .35 + rand() * 1.6);
    }
  });
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return map;
}

function soilMaterial(map, winter) {
  const material = new THREE.MeshStandardMaterial({ map, roughness: .94 });
  material.onBeforeCompile = shader => {
    shader.uniforms.winter = winter;
    shader.fragmentShader = 'uniform float winter;\n' + shader.fragmentShader.replace(
      '#include <map_fragment>',
      '#include <map_fragment>\n diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.67, 0.77, 0.80) + diffuseColor.rgb * 0.29, winter * 0.91);',
    );
  };
  return material;
}

function mesh(root, geometry, material, x, y, z, cast = false) {
  const model = new THREE.Mesh(geometry, material);
  model.position.set(x, y, z);
  model.castShadow = cast;
  model.receiveShadow = true;
  root.add(model);
  return model;
}

function batch(root, geometry, material, instances, { cast = false, receive = true } = {}) {
  const model = new THREE.InstancedMesh(geometry, material, instances.length);
  const proxy = new THREE.Object3D();
  const color = new THREE.Color();
  for (let i = 0; i < instances.length; i++) {
    const { x, y, z, sx, sy, sz, ry = 0, rx = 0, rz = 0, shade } = instances[i];
    proxy.position.set(x, y, z);
    proxy.scale.set(sx, sy, sz);
    proxy.rotation.set(rx, ry, rz);
    proxy.updateMatrix();
    model.setMatrixAt(i, proxy.matrix);
    if (shade) model.setColorAt(i, color.set(shade));
  }
  model.castShadow = cast;
  model.receiveShadow = receive;
  model.computeBoundingSphere();
  root.add(model);
  return model;
}

function pondRadius(angle) {
  return 1 + .065 * Math.sin(angle * 3 + .2) + .058 * Math.cos(angle * 2 - .9) + .028 * Math.cos(angle * 5);
}

function shoreXz(angle, scale = 1) {
  const radius = pondRadius(angle) * scale;
  return [pond.x + Math.cos(angle) * radius * pond.rx, pond.z + Math.sin(angle) * radius * pond.rz];
}

function pondDistance(x, z) {
  const angle = Math.atan2((z - pond.z) / pond.rz, (x - pond.x) / pond.rx);
  return Math.hypot((x - pond.x) / pond.rx, (z - pond.z) / pond.rz) / pondRadius(angle);
}

function lakeGeometry(scale) {
  const path = new THREE.Shape();
  for (let i = 0; i < 116; i++) {
    const [x, z] = shoreXz(i * Math.PI / 58, scale);
    if (i === 0) path.moveTo(x, -z);
    else path.lineTo(x, -z);
  }
  path.closePath();
  const geometry = new THREE.ShapeGeometry(path);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function addPond(root, rand, clock, winter, daylight) {
  const shoreline = mesh(root, lakeGeometry(1.105), new THREE.MeshStandardMaterial({
    color: '#b5aa83', roughness: .95,
  }), 0, .008, 0);
  shoreline.name = 'Pond stone margin';

  const waterMaterial = new THREE.ShaderMaterial({
    uniforms: { clock, winter, daylight },
    vertexShader: `
      varying vec3 location;
      varying vec3 pointToEye;
      void main() {
        vec4 p = modelMatrix * vec4(position, 1.0);
        location = p.xyz;
        pointToEye = cameraPosition - p.xyz;
        gl_Position = projectionMatrix * viewMatrix * p;
      }
    `,
    fragmentShader: `
      #include <common>
      uniform float clock;
      uniform float winter;
      uniform float daylight;
      varying vec3 location;
      varying vec3 pointToEye;
      void main() {
        vec2 p = location.xz;
        vec2 q = (p - vec2(-6.65, -4.95)) / vec2(2.44, 1.56);
        float r = length(q);
        float angle = atan(q.y, q.x);
        float edge = r / (1.0 + .065*sin(angle*3.0+.2) + .058*cos(angle*2.0-.9) + .028*cos(angle*5.0));
        float waveA = sin(p.x*11.7 + p.y*4.1 + sin(p.y*9.0)*1.01 + clock*1.15);
        float waveB = sin(p.x*5.0 - p.y*15.0 + sin(p.x*3.5)*1.2 - clock*.70);
        float waveC = sin(p.x*14.0 + p.y*10.0 + clock*.65);
        vec3 normal = normalize(vec3(.031*waveA + .017*waveC, 1.0, .035*waveB));
        vec3 view = normalize(pointToEye);
        vec3 f = reflect(-view, normal);
        float fresnel = pow(1.0 - max(dot(view, normal), 0.0), 3.0);
        float reflection = pow(max(dot(f, normalize(vec3(-.55, .83, -.12))), 0.0), 49.0);
        float shallows = smoothstep(.58, 1.04, edge);
        vec3 water = mix(vec3(.053, .257, .25), vec3(.224, .38, .221), shallows);
        water += (waveA + waveB*.25)*.013;
        water = mix(water, vec3(.41, .59, .626), .16 + fresnel*.64);
        water += daylight * reflection * vec3(.73,.53,.27);
        float ribbon = smoothstep(.89,.97,waveA) * smoothstep(.25,.73,waveB);
        water += daylight * ribbon * vec3(.071,.099,.083);
        water = mix(water, vec3(.48,.68,.73)+waveB*.035, winter*.68);
        water = mix(water*.26,water,daylight);
        gl_FragColor = vec4(water, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const water = mesh(root, lakeGeometry(1), waterMaterial, 0, .013, 0);
  water.name = 'Pond with moving highlights';

  const stones = [];
  const reeds = [];
  for (let i = 0; i < 63; i++) {
    const a = Math.PI * 2 * (i + rand() * .69) / 63;
    const [x, z] = shoreXz(a, .986 + rand() * .16);
    const size = .045 + rand() * .115;
    stones.push({ x, y: .017 + rand() * .029, z, sx: size * (1.08 + rand() * .41), sy: size * .55, sz: size, ry: rand() * 6.28,
      shade: sample(['#a6a995', '#b3ac8a', '#9a9c8f', '#bfb8a3'], rand) });
    if (i % 4 === 0 && rand() < .66) {
      for (let j = 0; j < 8; j++) {
        const span = .09 + rand() * .16;
        const h = .09 + rand() * .18;
        reeds.push({ x: x + (rand() - .5) * span, y: .014 + h / 2, z: z + (rand() - .5) * span,
          sx: .009, sy: h, sz: .009, rz: (rand() - .5) * .58, rx: (rand() - .5) * .48, shade: sample(['#758343', '#9fa153', '#7d8d48'], rand) });
      }
    }
  }
  batch(root, new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ roughness: .88 }), stones, { cast: true });
  batch(root, new THREE.CylinderGeometry(.31, .52, 1, 3), new THREE.MeshStandardMaterial({ roughness: .89 }), reeds, { receive: false });

  const pads = [];
  const petals = [];
  for (const [cx, cz] of [[-8.06, -5.09], [-5.02, -4.56], [-7.62, -5.79]]) {
    for (let i = 0; i < 9; i++) {
      const x = cx + (rand() - .5) * .72;
      const z = cz + (rand() - .5) * .43;
      const size = .04 + rand() * .051;
      pads.push({ x, y: .02, z, sx: size, sy: .75 + rand() * .16, sz: size * .83, ry: rand() * 6.28, shade: sample(['#6c915d', '#879e65', '#6d9e60'], rand) });
      if (i % 5 === 2) petals.push({ x, y: .048, z, sx: size * .55, sy: size * .29, sz: size * .55,
        ry: rand() * 6.28, shade: sample(['#e6bcaa', '#d79eac', '#edcfac'], rand) });
    }
  }
  const pad = new THREE.CircleGeometry(1, 12, .19, Math.PI * 1.78);
  pad.rotateX(-Math.PI / 2);
  batch(root, pad, new THREE.MeshStandardMaterial({ roughness: .7 }), pads);
  batch(root, new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ roughness: .67 }), petals);

  const timber = new THREE.MeshStandardMaterial({ color: '#8c694d', roughness: .94 });
  const post = new THREE.MeshStandardMaterial({ color: '#b68d64', roughness: .9 });
  const extension = new THREE.BoxGeometry(.13,.046,1.05);
  for(let i=0;i<9;i++)mesh(root,extension,timber,-6.94+i*.14,.174,-4.27,true);
  const plank = new THREE.BoxGeometry(1.05, .046, .13);
  for (let i = 0; i < 9; i++) mesh(root, plank, i % 3 === 0 ? post : timber, -6.94, .174, -3.26 - i * .147, true);
  for (const x of [-7.39, -6.50]) for (const z of [-3.39, -4.30]) {
    mesh(root, new THREE.CylinderGeometry(.035, .039, .29, 7), post, x, .149, z, true);
  }
  for (const x of [-7.39, -6.50]) mesh(root, new THREE.BoxGeometry(.046, .039, .92), timber, x, .278, -3.83, true);
  for (let i = 0; i < 4; i++) {
    mesh(root, new THREE.BoxGeometry(1.05, .04, .11), post, -6.94, .14 - i * .036, -3.09 + i * .116, true);
  }
}

function grassGeometry() {
  const positions = [];
  const colors = [];
  const shades = [
    new THREE.Color('#7b856e'),
    new THREE.Color('#b5be9f'),
    new THREE.Color('#eff1c5'),
  ];
  for (let i = 0; i < 4; i++) {
    const angle = .4 + i * Math.PI / 2.23;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const w = .027 + i * .002;
    const spread = .065 + i * .008;
    const h = 1 - i * .085;
    const x = dx * spread;
    const z = dz * spread;
    const a = [x - dz * w, 0, z + dx * w];
    const b = [x + dz * w, 0, z - dx * w];
    const m = [x * 1.27 - dz * w * .43, h * .58, z * 1.27 + dx * w * .43];
    const n = [x * 1.27 + dz * w * .43, h * .58, z * 1.27 - dx * w * .43];
    const tip = [x * 1.87, h, z * 1.87];
    positions.push(...a, ...b, ...m, ...b, ...n, ...m, ...m, ...n, ...tip);
    for (const idx of [0, 0, 1, 0, 1, 1, 1, 1, 2]) colors.push(...shades[idx].toArray());
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function addMeadow(root, rand, clock, winter) {
  const material = new THREE.MeshStandardMaterial({
    side: THREE.DoubleSide, vertexColors: true, roughness: 1, emissive: '#3e5525', emissiveIntensity: .14,
  });
  material.onBeforeCompile = shader => {
    shader.uniforms.clock = clock;
    shader.uniforms.winter = winter;
    shader.vertexShader = 'uniform float clock;\nuniform float winter;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       float gust = sin(clock*1.55 + instanceMatrix[3].x*.58 + instanceMatrix[3].z*.52);
       transformed.x += position.y*position.y * (.017 + gust*.031);
       transformed.y *= 1.0 - winter*.51;`,
    );
    shader.fragmentShader = 'uniform float winter;\n' + shader.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.59,.69,.70) + diffuseColor.rgb * .20, winter*.85);',
    );
  };
  const grassTones = ['#81aa4f', '#9ab158', '#789a4d', '#a6b961', '#82a459', '#a3a953', '#698c4d'];
  const desired = matchMedia('(max-width: 700px)').matches ? 10000 : 16000;
  const grass = [];
  for (let i = 0; i < desired; i++) {
    const inside = i < desired * .77;
    const x = (rand() - .5) * (inside ? 31 : 52);
    const z = (rand() - .5) * (inside ? 24 : 40);
    if (pondDistance(x, z) < 1.09 || stations.some(station=>Math.hypot(x-station.at[0],z-station.at[2])<station.radius+.3) || Object.values(routes).some(points=>points.some((p,i)=>{if(!i)return false;const a=points[i-1],dx=p[0]-a[0],dz=p[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz)));return Math.hypot(x-a[0]-t*dx,z-a[1]-t*dz)<.85;}))) continue;
    const dense = Math.sin(x * .93 + Math.cos(z)) * Math.sin(z * 1.11 + x * .55);
    if (dense > .44 && rand() < .37) continue;
    const reduced = clearings.some(([a, b, r]) => (x - a) ** 2 + (z - b) ** 2 < r ** 2);
    const size = (reduced ? .05 : .08) + rand() ** 1.4 * (reduced ? .08 : .22);
    grass.push({ x, y: .003, z, sx: .59 + rand() * .65, sy: size, sz: .59 + rand() * .65, ry: rand() * 6.28, shade: sample(grassTones, rand) });
  }
  batch(root, grassGeometry(), material, grass);

  const stems = [];
  const blooms = [];
  const centers = [[-11.2, -4.9], [-9.25, -6.3], [-4.9, -6.4], [-5.5, 4.65], [-3.5, 6.25], [3.25, -5.7], [4.9, -7.05],
    [10.7, -1.85], [10.75, 4.1], [3.65, 7.8], [8.8, 7.4], [-7.3, 6.9], [1.5, -9.1]];
  for (const [cx, cz] of centers) {
    const tones = rand() < .5 ? ['#ba9ebd', '#d2b9d4', '#696eb2'] : ['#ead68e', '#efead0', '#ddc572'];
    for (let i = 0; i < 19; i++) {
      const x = cx + (rand() - .5) * 1.39;
      const z = cz + (rand() - .5) * .97;
      const h = .11 + rand() * .13;
      const w = .012 + rand() * .023;
      stems.push({ x, y: h / 2, z, sx: .009, sy: h, sz: .009, shade: '#6e8a4d' });
      blooms.push({ x, y: h, z, sx: w*1.05, sy: w * .59, sz: w, ry: rand() * 6.28, shade: sample(tones, rand) });
    }
  }
  batch(root, new THREE.CylinderGeometry(.32, .48, 1, 3), new THREE.MeshStandardMaterial({ roughness: .9 }), stems);
  batch(root, new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({
    roughness: .72, emissive: '#9c7868', emissiveIntensity: .08,
  }), blooms);
}

function canopyGeometry() {
  const geometry = new THREE.SphereGeometry(1, 14, 10);
  const p = geometry.getAttribute('position');
  const colors = [];
  const lower = new THREE.Color('#9cae95');
  const upper = new THREE.Color('#fff8d0');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const b = Math.sin(x * 13.3 + y * 8.9) * Math.cos(z * 13.5 - y * 3.3);
    const r = 1 + .083 * b + .056 * Math.cos(z * 17.1 + x * 9.1);
    p.setXYZ(i, x * r, y * r, z * r);
    colors.push(...lower.clone().lerp(upper, Math.min(1, Math.max(0, (y + 1) * .53 + b * .075))).toArray());
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function addGrove(root, rand, winter) {
  const logs = [];
  const leaves = [];
  const shaded = [];
  const evergreens = [];
  const sceneMarkers = [[-12, -5.5, 1], [-12.6, -3.6, .88], [-11.3, -7.8, 1.05], [-9.6, -8.3, .79], [-7.8, -8.6, .9],
    [-5.8, -9.3, 1.05], [-3.8, -9.4, .91], [2.1, -9.1, .93], [4.1, -9.2, 1.0], [6.3, -8.7, .88],
    [8.8, -8.4, 1.0], [11.4, -7.3, 1.01], [12.1, -5.8, 1.13], [11.7, -3.0, .85], [13, -.1, 1.01],
    [12.7, 3.4, .77], [11.9, 5.8, .88], [10.8, 7.7, .84], [7.2, 9.1, .83], [3.2, 9.7, .78],
    [-3.7, 9.8, .87], [-6.2, 9.3, .93], [-8.65, 8.6, .95], [-10.5, 7.45, .94], [-12.3, 6.3, .96]];

  function addTree(x, z, scale, distant = false, pine = false) {
    const autumn = rand() < (distant ? .17 : .27);
    const leaf = sample(autumn ? autumnTones : distant ? groveTones : treeTones, rand);
    const lift = scale * (.86 + rand() * .28);
    logs.push({ x, y: lift * .57, z, sx: scale * .15, sy: lift * 1.15, sz: scale * .15, shade: sample(['#766a52', '#8a7357', '#847054'], rand) });
    if (pine) {
      for (let i = 0; i < 3; i++) evergreens.push({ x, y: lift + (i - 1) * scale * .53, z, sx: scale * (.82 - i * .152), sy: scale * (.98 - i * .06),
        sz: scale * (.82 - i * .152), ry: rand() * 6.28, shade: sample(['#547754', '#57835b', '#6d915e', '#73975e'], rand) });
    } else {
      leaves.push({ x, y: lift + scale * .55, z, sx: scale * .71, sy: scale * .76, sz: scale * .64, ry: rand() * 6.28, shade: leaf });
      for (let i = 0; i < (distant ? 3 : 7); i++) {
        const a = i * 2.39996;
        const offset = scale * (.29 + rand() * .37);
        const crown = scale * (.32 + rand() * .22);
        const shade = new THREE.Color(leaf).multiplyScalar(.83 + rand() * .24);
        leaves.push({ x: x + Math.cos(a) * offset, y: lift + scale * (.18 + rand() * .69), z: z + Math.sin(a) * offset,
          sx: crown * (1.02 + rand() * .11), sy: crown * (1 + rand() * .39), sz: crown, ry: rand() * 6.28, shade });
      }
    }
    if (!distant) shaded.push({ x: x + scale * .11, y: .012, z: z + scale * .09, sx: scale * 1.9, sy: 1, sz: scale * 1.63 });
  }
  for (const [x, z, scale] of sceneMarkers) addTree(x, z, scale, false, rand() < .16);
  for (let i = 0; i < 134; i++) {
    const a = rand() * Math.PI * 2;
    const stretch = 1 + rand() * .97;
    const x = Math.cos(a) * 17.7 * stretch;
    const z = Math.sin(a) * 13.8 * stretch;
    if (z > 12.5 && Math.abs(x) < 9.1 && rand() < .68) continue;
    addTree(x, z, .77 + rand() * 1.16, true, rand() < .4);
  }
  for (let i = 0; i < 59; i++) {
    const a = rand() * Math.PI * 2;
    const r = 1.01 + rand() * .19;
    const x = Math.cos(a) * 13.0 * r;
    const z = Math.sin(a) * 10.5 * r;
    const radius = .13 + rand() * .33;
    leaves.push({ x, y: radius * .69, z, sx: radius * 1.35, sy: radius * .85, sz: radius, ry: rand() * 6.28,
      shade: sample(['#699455', '#75a563', '#93ad64', '#548963'], rand) });
  }

  const shadeTexture = texture(128, ctx => {
    const gradient = ctx.createRadialGradient(64, 64, 5, 64, 64, 62);
    gradient.addColorStop(0, 'rgba(34,47,28,.29)');
    gradient.addColorStop(.58, 'rgba(41,59,31,.18)');
    gradient.addColorStop(1, 'rgba(39,49,27,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
  });
  const shadow = new THREE.PlaneGeometry(2, 2);
  shadow.rotateX(-Math.PI / 2);
  batch(root, shadow, new THREE.MeshBasicMaterial({
    map: shadeTexture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
  }), shaded, { receive: false }).renderOrder = 1;
  const foliage = new THREE.MeshStandardMaterial({ roughness: .94, vertexColors: true, emissive: '#456935', emissiveIntensity: .09 });
  foliage.onBeforeCompile = shader => {
    shader.uniforms.winter = winter;
    shader.vertexShader = 'varying float foliageHeight;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n foliageHeight = position.y;',
    );
    shader.fragmentShader = 'uniform float winter;\nvarying float foliageHeight;\n' + shader.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.65,.75,.77), winter*smoothstep(.06,.73,foliageHeight)*.86);',
    );
  };
  batch(root, new THREE.CylinderGeometry(.29, .60, 1, 7), new THREE.MeshStandardMaterial({ roughness: 1 }), logs, { cast: false });
  batch(root, canopyGeometry(), foliage, leaves, { cast: false });
  batch(root, new THREE.ConeGeometry(1, 1.78, 10), new THREE.MeshStandardMaterial({
    roughness: .91, emissive: '#37572b', emissiveIntensity: .11,
  }), evergreens, { cast: false });
}

export function createLandscape(scene) {
  const root = new THREE.Group();
  root.name = 'Autoloop landscape';
  scene.add(root);
  const rand = random(93315);
  const clock = { value: 0 };
  const winter = { value: 0 };
  const daylight = { value: 1 };
  const groundMap = earthTexture();
  groundMap.repeat.set(10, 9);
  const ground = mesh(root, new THREE.PlaneGeometry(112, 100), soilMaterial(groundMap, winter), 0, 0, 0);
  ground.rotation.x = -Math.PI / 2;
  const hillPalette = ['#79935f', '#829a68', '#75926a', '#7c9867'];
  const hills = [];
  for (let i = 0; i < 32; i++) {
    const a = i * Math.PI / 16 + rand() * .22;
    const distance = 29 + rand() * 23;
    hills.push({
      x: Math.cos(a) * distance, y: -.18, z: Math.sin(a) * distance * .9,
      shade: sample(hillPalette, rand), sx: 5.5 + rand() * 8, sy: 1.37 + rand() * 1.97, sz: 5.4 + rand() * 7,
    });
  }
  batch(root, new THREE.IcosahedronGeometry(1, 3), new THREE.MeshStandardMaterial({ roughness: 1 }), hills);
  addPond(root, rand, clock, winter, daylight);
  addMeadow(root, rand, clock, winter);
  addGrove(root, rand, winter);

  return {
    update(seconds, night = 0, snow = 0) {
      clock.value = seconds;
      winter.value = THREE.MathUtils.clamp(Number(snow), 0, 1);
      daylight.value = 1 - THREE.MathUtils.clamp(Number(night), 0, 1);
    },
  };
}
