import * as THREE from '../vendor/three.module.min.js';
import { PopAudio } from '../audio.js';

const $ = (id) => document.getElementById(id);
const canvas = $('toy'), stage = $('stage'), keys = $('keys');
const audio = new PopAudio();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const modes = { full: { cols: 6, rows: 4, side: 1 }, sample: { cols: 2, rows: 2, side: 1 }, chase: { cols: 6, rows: 4, side: 1 } };
const palette = ['#d987a9', '#eda875', '#e1c878', '#83bba9'];
const rimLightColor = new THREE.Color('#fff2bb');
const rimLightIntensity = .45;
let comparisonVariant = 'current';
let pulseStart = 0, pulseLevel = 1;
const svgNS = 'http://www.w3.org/2000/svg';
const fallingLight = document.createElementNS(svgNS, 'svg');
fallingLight.setAttribute('aria-hidden', 'true');
fallingLight.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:none;z-index:1;overflow:visible';
fallingLight.innerHTML = '<defs><linearGradient id="rim-rain" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff2bb" stop-opacity="0"/><stop offset=".72" stop-color="#fff2bb" stop-opacity=".5"/><stop offset="1" stop-color="#fffcef" stop-opacity="1"/></linearGradient></defs>';
const rainLines = Array.from({length:16}, () => {
  const line = document.createElementNS(svgNS,'line');
  line.setAttribute('stroke','url(#rim-rain)'); line.setAttribute('stroke-linecap','round');
  fallingLight.append(line); return line;
});
stage.append(fallingLight);
function drawRimRain(cell, progress) {
  const rect = canvas.getBoundingClientRect(), point = screenPoint(cell);
  const diameter = Math.abs(screenPoint({x:cell.x + .968,y:cell.y}).x - point.x);
  const length = diameter * .33;
  fallingLight.style.display = 'block';
  fallingLight.style.opacity = String(Math.sin(Math.PI * progress));
  for (let i=0;i<rainLines.length;i++) {
    const angle=i/rainLines.length*Math.PI*2;
    const end=screenPoint({x:cell.x + .484*Math.cos(angle),y:cell.y + .484*Math.sin(angle)});
    const y=end.y-rect.top-length*.65*(1-progress);
    const line=rainLines[i];
    line.setAttribute('x1',end.x-rect.left);line.setAttribute('x2',end.x-rect.left+.01);
    line.setAttribute('y1',y-length);line.setAttribute('y2',y);
    line.setAttribute('stroke-width',Math.max(1.2,diameter*.025));
  }
}
let rimGlowTexture;
function roundedRimGlow() {
  if (rimGlowTexture) return rimGlowTexture;
  const pixels = new Uint8Array(128 * 4);
  for (let y = 0; y < 128; y++) {
    // Torus UV v follows the tube: its crest glows, while its flanks retain shading.
    const light = Math.round(255 * (.08 + .92 * Math.pow(Math.abs(Math.sin(y / 127 * Math.PI * 2)), 4)));
    pixels.set([light, light, light, 255], y * 4);
  }
  rimGlowTexture = new THREE.DataTexture(pixels, 1, 128);
  rimGlowTexture.magFilter = THREE.LinearFilter;
  rimGlowTexture.minFilter = THREE.LinearFilter;
  rimGlowTexture.needsUpdate = true;
  return rimGlowTexture;
}
const chase = { target: 0, progress: 0, completedFaces: 0, reveal: null };
const chaseSigns = Array(24).fill(1);
const chaseMode = modes.chase; chaseMode.signs = chaseSigns;
const initialMode = 'chase';
let mode = initialMode, cells = [], buttons = [], renderer, scene, camera, toy, ground;
let flipAnimation = null, frame = 0, lastTime = 0, alive = true, focusIndex = 0;
let stats = { frames: 0, maxFrameMs: 0, recentFrameMs: [] };
const pointers = new Map(), raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
const interactables = [], projected = new THREE.Vector3();
let dirty = true;

function showError() {
  $('loading').hidden = true;
  $('error-panel').hidden = false;
  $('flip').disabled = true;
  keys.replaceChildren();
}

// The membrane is a two-sided surface: its actual height changes sign when popped.
function membraneGeometry() {
  const radial = 16, angular = 48, positions = [], indices = [], profiles = [];
  positions.push(0, 0, 0); profiles.push(1);
  for (let ring = 1; ring <= radial; ring++) {
    const r = ring / radial;
    for (let s = 0; s < angular; s++) {
      const a = s / angular * Math.PI * 2;
      positions.push(Math.cos(a) * r * .459, Math.sin(a) * r * .459, 0);
      profiles.push(Math.pow(1 - r * r, 1.15));
    }
  }
  for (let s = 0; s < angular; s++) indices.push(0, 1 + s, 1 + (s + 1) % angular);
  for (let ring = 0; ring < radial - 1; ring++) {
    for (let s = 0; s < angular; s++) {
      const a = 1 + ring * angular + s, b = 1 + ring * angular + (s + 1) % angular;
      const c = a + angular, d = b + angular;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.userData.profiles = profiles;
  // Fixed conservative bounds include both the raised and depressed states.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), .7);
  return geo;
}

function updateMembrane(cell) {
  const geo = cell.mesh.geometry, attr = geo.attributes.position;
  const profile = geo.userData.profiles;
  for (let i = 0; i < attr.count; i++) attr.setZ(i, profile[i] * cell.height);
  attr.needsUpdate = true;
  geo.computeVertexNormals();
}

function roundedShape(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h); s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r); s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function silicone(color) {
  return new THREE.MeshPhysicalMaterial({ color, roughness: .63, metalness: 0,
    clearcoat: .18, clearcoatRoughness: .62, side: THREE.DoubleSide });
}

let haloTexture;
function diffuseHaloTexture() {
  if (haloTexture) return haloTexture;
  const size = 256, sheet = document.createElement('canvas');
  sheet.width = size; sheet.height = size;
  const context = sheet.getContext('2d');
  const glow = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // Halve the halo's overhang from the fixed rim at arrival, not the entire circle.
  const rimAtArrival = .484 / (.82 * 1.22);
  const narrowed = radius => (rimAtArrival + radius) / 2;
  // The transparent center preserves the bubble surface; the light lives outside the rim.
  glow.addColorStop(0, 'rgba(255,244,197,0)');
  glow.addColorStop(narrowed(.52), 'rgba(255,244,197,0)');
  glow.addColorStop(narrowed(.62), 'rgba(255,244,197,.06)');
  glow.addColorStop(narrowed(.72), 'rgba(255,244,197,.68)');
  glow.addColorStop(narrowed(.84), 'rgba(255,244,197,.12)');
  glow.addColorStop(narrowed(1), 'rgba(255,244,197,0)');
  glow.addColorStop(1, 'rgba(255,244,197,0)');
  context.fillStyle = glow; context.fillRect(0, 0, size, size);
  haloTexture = new THREE.CanvasTexture(sheet);
  haloTexture.colorSpace = THREE.SRGBColorSpace;
  return haloTexture;
}

function chooseChaseTarget() {
  const remaining = chaseSigns.map((sign, index) => sign === modes.chase.side ? index : -1).filter(index => index >= 0);
  chase.target = remaining.length ? remaining[Math.floor(Math.random() * remaining.length)] : null;
  // A short arrival glow makes the new destination feel placed, not merely switched.
  chase.reveal = chase.target === null ? null : { index: chase.target, start: performance.now() };
  pulseStart = performance.now() + 900;
}
function lightRim(cell, progress) {
  // Keep lighting-dependent shading visible on the torus instead of clipping it to solid white.
  const material = cell.indicator.material;
  material.color.copy(cell.mesh.material.color).lerp(rimLightColor, progress * .65);
  material.emissive.set('#ffe46b');
  material.emissiveIntensity = .02 + (rimLightIntensity - .02) * progress;
}
function chaseReadyToFlip() {
  return mode !== 'chase' || chase.progress === 24;
}
chooseChaseTarget();

function releaseResources(group) {
  const geometries = new Set(), materials = new Set();
  group.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.material) materials.add(object.material);
  });
  geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
}

function buildToy() {
  if (toy) { scene.remove(toy); releaseResources(toy); }
  ground.visible = true;
  toy = new THREE.Group();
  const state = modes[mode], { cols, rows } = state;
  if (mode === 'chase') state.signs = chaseSigns;
  state.signs ||= Array(cols * rows).fill(1);
  const width = cols * 1.14 + .34, height = rows * 1.14 + .34;
  const bodyShape = roundedShape(width, height, .5);
  cells = []; interactables.length = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = (col - (cols - 1) / 2) * 1.14, y = ((rows - 1) / 2 - row) * 1.14;
      const hole = new THREE.Path(); hole.absarc(x, y, .462, 0, Math.PI * 2, true);
      bodyShape.holes.push(hole);
      const index = row * cols + col;
      const material = silicone(palette[mode === 'sample' ? index : row]);
      const wave = { radius:{value:0}, strength:{value:0} };
      material.onBeforeCompile = shader => {
        shader.uniforms.waveRadius = wave.radius; shader.uniforms.waveStrength = wave.strength;
        shader.vertexShader = 'varying vec2 popSurface;\n' + shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\npopSurface = position.xy;');
        shader.fragmentShader = 'varying vec2 popSurface; uniform float waveRadius; uniform float waveStrength;\n' + shader.fragmentShader.replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\nfloat wave = exp(-pow((length(popSurface)-waveRadius)/0.065,2.0))*waveStrength;\ntotalEmissiveRadiance += vec3(1.0,0.82,0.48)*wave;');
      };
      material.customProgramCacheKey = () => 'pop-spread-v1';
      const membrane = new THREE.Mesh(membraneGeometry(), material);
      // Lighting still shades the curved surface; avoid self-shadow artifacts on the reverse face.
      membrane.position.set(x, y, 0); membrane.castShadow = true; membrane.receiveShadow = false;
      toy.add(membrane);
      const ringGeo = new THREE.TorusGeometry(.484, .057, 12, 48);
      const rims = {};
      for (const side of [1, -1]) {
        // Each physical rim owns its emission, independently of the membrane and opposite face.
        const rim = new THREE.Mesh(ringGeo, material.clone());
        rim.material.emissiveMap = roundedRimGlow();
        rim.position.set(x, y, .168 * side); rim.castShadow = true; rim.receiveShadow = true;
        toy.add(rim); rims[side] = rim;
      }
      // A cylinder lines the hole and connects both faces, without a solid cap.
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(.459, .459, .34, 48, 1, true), material);
      neck.rotation.x = Math.PI / 2; neck.position.set(x, y, 0); neck.receiveShadow = true; toy.add(neck);
      const target = new THREE.Mesh(new THREE.CircleGeometry(.46, 32), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, visible: false }));
      target.position.set(x, y, .2 * state.side); target.userData.index = index;
      toy.add(target); interactables.push(target);
      const indicator = rims[state.side];
      const halo = new THREE.Mesh(new THREE.PlaneGeometry(1.64, 1.64), new THREE.MeshBasicMaterial({ map: diffuseHaloTexture(), color: '#fff0a8', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      halo.position.set(x, y, .205 * state.side); halo.visible = false;
      toy.add(halo);
      const cell = { index, x, y, wave, mesh: membrane, target, rims, indicator, halo, sign: state.signs[index], height: .43 * state.signs[index], velocity: 0, pressing: null };
      cells.push(cell); updateMembrane(cell);
    }
  }
  const bodyGeo = new THREE.ExtrudeGeometry(bodyShape, { depth: .25, bevelEnabled: true, bevelThickness: .045, bevelSize: .035, bevelSegments: 3, steps: 1, curveSegments: 36 });
  bodyGeo.translate(0, 0, -.125);
  const body = new THREE.Mesh(bodyGeo, silicone('#bba9d6'));
  body.castShadow = true; body.receiveShadow = true; toy.add(body);
  scene.add(toy);
  toy.rotation.set(-.18, state.side === 1 ? -.075 : Math.PI - .075, -.035);
  buildKeyboard(); updateStatus(); fitCamera(); dirty = true;
}

function screenPoint(cell) {
  projected.set(cell.x, cell.y, .23 * modes[mode].side);
  toy.localToWorld(projected); projected.project(camera);
  const rect = canvas.getBoundingClientRect();
  return { x: rect.left + (projected.x + 1) / 2 * rect.width, y: rect.top + (1 - projected.y) / 2 * rect.height };
}

function positionKeys() {
  toy.updateMatrixWorld(true);
  const rect = canvas.getBoundingClientRect();
  cells.forEach((cell, index) => {
    const pos = screenPoint(cell);
    buttons[index].style.left = `${pos.x - rect.left}px`;
    buttons[index].style.top = `${pos.y - rect.top}px`;
  });
}

function buildKeyboard() {
  keys.replaceChildren(); focusIndex = Math.min(focusIndex, cells.length - 1);
  buttons = cells.map(cell => {
    const button = document.createElement('button'); button.className = 'bubble-key';
    button.tabIndex = cell.index === focusIndex ? 0 : -1;
    button.addEventListener('focus', () => { focusIndex = cell.index; });
    button.addEventListener('keydown', event => {
      const { cols } = modes[mode]; const reverse = modes[mode].side === -1 ? -1 : 1;
      const steps = { ArrowRight: reverse, ArrowLeft: -reverse, ArrowDown: cols, ArrowUp: -cols };
      if (event.key in steps) {
        event.preventDefault();
        const next = Math.max(0, Math.min(cells.length - 1, cell.index + steps[event.key]));
        buttons[cell.index].tabIndex = -1; buttons[next].tabIndex = 0; buttons[next].focus();
      } else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        if (!event.repeat) { unlockAudio(); press(cell.index, 'keyboard', performance.now()); }
      }
    });
    button.addEventListener('keyup', event => {
      if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); finishPress('keyboard', true); }
    });
    button.addEventListener('blur', () => finishPress('keyboard', false));
    // Screen readers activate a button through click without keyboard events.
    button.addEventListener('click', event => { if (event.detail === 0) { unlockAudio(); press(cell.index, 'assistive', performance.now()); finishPress('assistive', true); } });
    keys.append(button); return button;
  });
}

function updateStatus() {
  const state = modes[mode], remaining = cells.filter(c => c.sign === state.side).length;
  document.querySelector('.play-area').classList.toggle('is-chase', mode === 'chase');
  if (mode === 'chase') {
    $('face-label').textContent = state.side === 1 ? 'おもて' : 'うら';
    $('hint').textContent = chase.progress === 24 ? 'ぜんぶ、できた！' : 'ひかっている ぷちを おそう。';
    $('status').textContent = chase.progress === 24
      ? `${chase.completedFaces}まい できた！ うらがえして、つづけよう。`
      : `${chase.progress} / 24こ${chase.completedFaces ? ` · ${chase.completedFaces}まい できた！` : ''}`;
    if (chase.target !== null) {
      const description = document.createElement('span');
      description.className = 'sr-only';
      description.textContent = `。${chase.target + 1}ばんが ひかっている。`;
      $('status').append(description);
    }
    cells.forEach((c, i) => {
      const target = i === chase.target;
      const revealing = target && chase.reveal?.index === i && !reducedMotion.matches;
      c.indicator = c.rims[state.side];
      Object.values(c.rims).forEach(rim => {
        rim.material.color.copy(c.mesh.material.color);
        rim.material.emissive.set('#000000'); rim.material.emissiveIntensity = 0;
      });
      if (target) {
        lightRim(c, revealing ? 0 : 1);
      }
      c.wave.strength.value = 0;
      c.halo.visible = revealing && ['current','pulse'].includes(comparisonVariant);
      c.halo.material.color.set('#fff0a8');
      c.halo.position.z = .205 * state.side;
      c.halo.scale.setScalar(revealing ? 1.22 : 1);
      c.halo.material.opacity = revealing ? .68 : 0;
      buttons[i].setAttribute('aria-label', `${i + 1}ばんの ぷち。${target ? 'ひかっている。おせます' : 'おせません'}`);
      buttons[i].setAttribute('aria-pressed', String(c.sign !== state.side));
    });
    $('flip').disabled = !chaseReadyToFlip();
    return;
  }
  $('face-label').textContent = state.side === 1 ? 'おもて' : 'うら';
  $('hint').textContent = remaining ? (mode === 'sample' ? 'ポコッを、くらべよう。' : 'おして、なぞって。') : 'ぜんぶ、ぽこっ。';
  $('status').textContent = remaining === cells.length ? '好きなところから、どうぞ。' : remaining ? 'うらがえすと、また おせるよ。' : 'うらがえして、もういちど。';
  cells.forEach((c, i) => {
    buttons[i].setAttribute('aria-label', `${i + 1}ばんの ぷち。${c.sign === state.side ? 'おせます' : 'へこんでいます'}`);
    buttons[i].setAttribute('aria-pressed', String(c.sign !== state.side));
  });
}

async function unlockAudio() {
  const ready = await audio.unlock();
  $('audio-note').textContent = ready ? '音量は、ここちよい大きさに。' : '音を使えません。音なしで あそべます。';
}

function press(index, owner, now) {
  if (!alive || flipAnimation) return;
  const c = cells[index];
  if (!c || c.sign !== modes[mode].side || c.pressing) return;
  if (mode === 'chase' && index !== chase.target) return;
  c.pressing = { owner, start: now }; dirty = true;
}

function snap(cell) {
  if (!cell.pressing || cell.sign !== modes[mode].side) return;
  if (mode === 'chase' && cell.index !== chase.target) { cell.pressing = null; return; }
  cell.sign *= -1; modes[mode].signs[cell.index] = cell.sign;
  cell.pressing = null; cell.velocity = cell.sign * 9;
  audio.pop(cell.index, modes[mode].side);
  if (mode === 'chase') {
    chase.progress += 1;
    if (chase.progress === 24) { chase.completedFaces += 1; chase.target = null; chase.reveal = null; }
    else chooseChaseTarget();
  }
  updateStatus(); dirty = true;
}

function finishPress(owner, commit) {
  cells.forEach(c => {
    if (c.pressing?.owner !== owner) return;
    if (commit) snap(c); else { c.pressing = null; dirty = true; }
  });
}

function cancelInputs() {
  pointers.clear(); cells.forEach(c => { c.pressing = null; }); dirty = true;
}

function hit(x, y) {
  const r = canvas.getBoundingClientRect();
  ndc.set((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.intersectObjects(interactables)[0]?.object.userData.index ?? -1;
}

canvas.addEventListener('pointerdown', event => {
  if (!renderer || !alive || flipAnimation || event.button !== 0) return;
  event.preventDefault(); unlockAudio();
  canvas.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, index: hit(event.clientX, event.clientY) });
  press(hit(event.clientX, event.clientY), event.pointerId, performance.now());
});
canvas.addEventListener('pointermove', event => {
  const pointer = pointers.get(event.pointerId); if (!pointer || flipAnimation) return;
  event.preventDefault();
  const samples = event.getCoalescedEvents?.() || [];
  for (const sample of samples.length ? samples : [event]) {
    const dx = sample.clientX - pointer.x, dy = sample.clientY - pointer.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 5));
    for (let s = 1; s <= steps; s++) {
      const index = hit(pointer.x + dx * s / steps, pointer.y + dy * s / steps);
      if (index !== pointer.index) {
        finishPress(event.pointerId, true);
        press(index, event.pointerId, performance.now()); pointer.index = index;
      }
    }
    pointer.x = sample.clientX; pointer.y = sample.clientY;
  }
});
canvas.addEventListener('pointerup', event => {
  if (!pointers.has(event.pointerId)) return;
  finishPress(event.pointerId, true); pointers.delete(event.pointerId);
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
});
for (const type of ['pointercancel', 'lostpointercapture']) canvas.addEventListener(type, event => {
  finishPress(event.pointerId, false); pointers.delete(event.pointerId);
});
window.addEventListener('blur', cancelInputs);
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelInputs(); lastTime = 0; });

$('flip').addEventListener('click', () => {
  if (flipAnimation || !renderer || !alive || !chaseReadyToFlip()) return;
  cancelInputs();
  flipAnimation = { start: performance.now(), from: toy.rotation.y, to: toy.rotation.y + Math.PI, duration: reducedMotion.matches ? 100 : 720 };
  $('flip').disabled = true; dirty = true;
});
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.mode === mode || !renderer || !alive) return;
  cancelInputs(); flipAnimation = null;
  mode = button.dataset.mode;
  if (mode === 'chase' && chase.target !== null) {
    chase.reveal = { index: chase.target, start: performance.now() };
  }
  document.querySelectorAll('[data-mode]').forEach(b => { const selected = b === button; b.classList.toggle('is-selected', selected); b.setAttribute('aria-pressed', selected); });
  $('flip').disabled = !chaseReadyToFlip(); buildToy();
}));
$('mute').addEventListener('click', () => {
  const muted = !audio.diagnostics.muted; audio.setMuted(muted); unlockAudio();
  $('mute').setAttribute('aria-pressed', muted); $('mute').setAttribute('aria-label', muted ? '音を出す' : '音を消す'); $('mute-label').textContent = muted ? 'おと なし' : 'おと';
});
$('volume').addEventListener('input', event => { audio.setVolume(Number(event.target.value) / 100); });
document.querySelectorAll('[data-tone]').forEach(button => button.addEventListener('click', () => {
  audio.setTone(button.dataset.tone); unlockAudio();
  document.querySelectorAll('[data-tone]').forEach(b => { const selected = b === button; b.classList.toggle('is-selected', selected); b.setAttribute('aria-pressed', selected); });
}));

function fitCamera() {
  if (!renderer) return;
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const state = modes[mode];
  const worldWidth = state.cols * 1.14 + .7, worldHeight = state.rows * 1.14 + 1.2;
  const halfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.position.z = Math.max(worldHeight / (2 * halfFov), worldWidth / (2 * halfFov * camera.aspect)) * 1.19;
  // Reserve room below the toy for its cast shadow instead of clipping it at the stage edge.
  camera.position.y = -.3;
  camera.updateProjectionMatrix(); dirty = true;
}

function animate(now) {
  if (!alive) return;
  frame = requestAnimationFrame(animate);
  if (document.hidden) return;
  const elapsed = lastTime ? now - lastTime : 16.67; lastTime = now;
  const dt = Math.min(elapsed / 1000, .035);
  let moving = false;
  for (const c of cells) {
    let target = c.sign * .43;
    if (c.pressing) {
      const progress = Math.min(1, (now - c.pressing.start) / 105);
      target = c.sign * (.43 - progress * .31);
      if (progress >= 1) { snap(c); target = c.sign * .43; }
    }
    if (Math.abs(target - c.height) > .0005 || Math.abs(c.velocity) > .004) {
      // Substeps keep spring integration stable across slow frames.
      const steps = Math.ceil(dt / .008), step = dt / steps;
      for (let i = 0; i < steps; i++) {
        c.velocity += ((target - c.height) * 620 - c.velocity * 32) * step;
        c.height += c.velocity * step;
      }
      updateMembrane(c); moving = true;
    } else if (c.height !== target) { c.height = target; c.velocity = 0; updateMembrane(c); moving = true; }
    if (c.pressing) moving = true;
  }
  if (mode === 'chase' && chase.reveal && !reducedMotion.matches) {
    const elapsed = now - chase.reveal.start;
    const cell = cells[chase.reveal.index];
    if (cell && elapsed < 900) {
      // A wide weak glow is gathered into the fixed rim, like a candle or fluorescent tube waking up.
      const progress = Math.max(0, Math.min(1, elapsed / 900));
      // Keep the early phase deliberately weak, then let the rim settle into its full brightness.
      const eased = progress * progress * (3 - 2 * progress);
      cell.halo.visible = ['current','pulse'].includes(comparisonVariant);
      cell.halo.scale.setScalar(1.22 - .22 * eased);
      cell.halo.material.opacity = .68 * Math.pow(1 - eased, 1.15);
      let rimProgress = eased;
      if (comparisonVariant === 'spread') {
        cell.wave.radius.value = .47 * Math.min(1,progress/.8);
        cell.wave.strength.value = .9 * Math.sin(Math.PI * progress);
        const arrival = Math.max(0,(progress-.45)/.55);
        rimProgress = arrival * arrival * (3-2*arrival);
      }
      lightRim(cell, rimProgress);
      if (comparisonVariant === 'rimfall') drawRimRain(cell, progress);
      dirty = true; moving = true;
    } else if (cell) {
      cell.halo.visible = false; cell.halo.material.opacity = 0; cell.wave.strength.value = 0; cell.wave.radius.value = 0;
      lightRim(cell, 1);
      chase.reveal = null; dirty = true;
    }
  }
  if (!chase.reveal || comparisonVariant !== 'rimfall' || reducedMotion.matches || mode !== 'chase') fallingLight.style.display = 'none';
  if (mode === 'chase' && comparisonVariant === 'pulse' && chase.target !== null && !chase.reveal && !flipAnimation) {
    pulseLevel = reducedMotion.matches ? 1 : .7 + .3 * Math.cos((now-pulseStart)/2000*Math.PI*2);
    lightRim(cells[chase.target], pulseLevel);
    if (!reducedMotion.matches) { dirty = true; moving = true; }
  }
  if (flipAnimation) {
    const f = flipAnimation, t = Math.min(1, (now - f.start) / f.duration), eased = t * t * (3 - 2 * t);
    toy.rotation.y = f.from + (f.to - f.from) * eased;
    // Turn slightly away from the viewer, keeping the whole board inside the viewport.
    const turn = Math.sin(Math.PI * eased);
    toy.position.z = -turn * (modes[mode].cols * 1.14 + .42) / 2;
    toy.rotation.x = -.18 * (1 - turn);
    toy.scale.setScalar(1 - .07 * turn);
    ground.visible = t < .05 || t > .95;
    moving = true;
    if (t === 1) {
      modes[mode].side *= -1;
      if (mode === 'chase') {
        chase.progress = 0; chooseChaseTarget();
      }
      flipAnimation = null; toy.position.z = 0; toy.scale.setScalar(1); ground.visible = true;
      toy.rotation.y = modes[mode].side === 1 ? -.075 : Math.PI - .075;
      cells.forEach(c => c.target.position.z = .2 * modes[mode].side);
      if (mode === 'chase') buildToy();
      $('flip').disabled = !chaseReadyToFlip(); updateStatus();
    }
  }
  if (dirty || moving) {
    positionKeys(); renderer.render(scene, camera); dirty = false;
    stats.frames++; stats.maxFrameMs = Math.max(stats.maxFrameMs, elapsed);
    stats.recentFrameMs.push(elapsed); if (stats.recentFrameMs.length > 180) stats.recentFrameMs.shift();
  }
}

try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
  scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(37, 1, .1, 100);
  scene.add(new THREE.HemisphereLight('#fff8f6', '#8d7f9c', 2.2));
  const key = new THREE.DirectionalLight('#fff4e9', 3.2); key.position.set(-4, 7, 9);
  key.castShadow = true; key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: .5, far: 30 });
  key.shadow.bias = -.0005; key.shadow.normalBias = .025; key.shadow.radius = 4;
  scene.add(key);
  const fill = new THREE.DirectionalLight('#e6e0ff', 1.2); fill.position.set(5, -2, 4); scene.add(fill);
  ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: .18 }));
  // Clear the back of depressed membranes, including the board tilt and spring overshoot.
  ground.position.z = -1.2; ground.receiveShadow = true; scene.add(ground);
  document.querySelectorAll('[data-mode]').forEach(button => {
    const selected = button.dataset.mode === mode;
    button.classList.toggle('is-selected', selected); button.setAttribute('aria-pressed', selected);
  });
  buildToy(); $('loading').hidden = true; $('flip').disabled = !chaseReadyToFlip();
  if (mode === 'chase' && chase.target !== null) chase.reveal = { index: chase.target, start: performance.now() };
  new ResizeObserver(fitCamera).observe(stage);
  frame = requestAnimationFrame(animate);
} catch (error) { console.error('Toy renderer unavailable:', error); alive = false; showError(); }
canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); alive = false; cancelAnimationFrame(frame); cancelInputs(); showError(); });
window.addEventListener('pagehide', () => { cancelInputs(); audio.dispose(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

// Local-only comparison controls. Each selection resets the same column for a fair comparison.
window.__lightCompare = Object.freeze({
  set({variant = 'current',row = 0,side = 1} = {}) {
    if (!['current','spread','rimfall','pulse'].includes(variant) || !Number.isInteger(row) || row < 0 || row > 3 || ![1,-1].includes(side)) return;
    cancelInputs(); flipAnimation = null; mode = 'chase'; comparisonVariant = variant;
    modes.chase.side = side; chaseSigns.fill(side); chase.progress = 0; chase.completedFaces = 0;
    chase.target = row * 6 + 2; chase.reveal = {index:chase.target,start:performance.now()};
    pulseStart = performance.now()+900; pulseLevel = 1;
    fallingLight.style.display = 'none'; buildToy();
  },
  replay() {
    if (chase.target === null) return;
    chase.reveal = {index:chase.target,start:performance.now()}; pulseStart=performance.now()+900; updateStatus(); dirty = true;
  },
  snapshot() {
    const cell = cells[chase.target];
    return {variant:comparisonVariant,target:chase.target,side:modes.chase.side,progress:chase.progress,
      revealing:Boolean(chase.reveal),intensity:cell?.indicator.material.emissiveIntensity,
      rimColor:cell?.indicator.material.color.getHexString(),beamVisible:fallingLight.style.display!=='none',
      waveRadius:cell?.wave.radius.value,waveStrength:cell?.wave.strength.value,pulseLevel,height:cell?.height};
  }
});
window.__lightCompare.set();
window.dispatchEvent(new Event('lightcompare-ready'));

// Read-only diagnostics are exposed only in an explicitly requested QA session.
if (new URLSearchParams(location.search).has('qa')) {
  function screenBounds() {
    const points = [], { cols, rows } = modes[mode];
    const rect = canvas.getBoundingClientRect();
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      const p = new THREE.Vector3(x * (cols * 1.14 + .42) / 2, y * (rows * 1.14 + .42) / 2, z * .47);
      toy.localToWorld(p); p.project(camera);
      points.push({x: rect.left + (p.x + 1) / 2 * rect.width, y: rect.top + (1 - p.y) / 2 * rect.height});
    }
    return points;
  }
  Object.defineProperty(window, '__popQA', { value: Object.freeze({
    surface() {
      toy.updateMatrixWorld(true);
      let minZ = Infinity;
      const vertex = new THREE.Vector3();
      for (const cell of cells) {
        const positions = cell.mesh.geometry.attributes.position;
        for (let i = 0; i < positions.count; i++) {
          vertex.fromBufferAttribute(positions, i).applyMatrix4(cell.mesh.matrixWorld);
          minZ = Math.min(minZ, vertex.z);
        }
      }
      return { groundZ: ground.position.z, minMembraneZ: minZ, cells: cells.map(c => ({
        receivesShadow: c.mesh.receiveShadow, membraneEmission: c.mesh.material.emissive.getHex(),
        rimEmission: c.rims[modes[mode].side].material.emissiveIntensity,
        oppositeEmission: c.rims[-modes[mode].side].material.emissive.getHex(),
        physicalRim: c.indicator === c.rims[modes[mode].side],
        rimRadius: c.indicator.geometry.parameters.radius, rimZ: c.indicator.position.z
      })) };
    },
    snapshot() { return { mode, side: modes[mode].side, flipping: Boolean(flipAnimation), activePointers: pointers.size, bounds: screenBounds(), cells: cells.map(c => ({ index: c.index, sign: c.sign, height: c.height, pressing: Boolean(c.pressing), ...screenPoint(c) })), game: mode === 'chase' ? { target: chase.target, progress: chase.progress, completedFaces: chase.completedFaces, reveal: chase.reveal && { index: chase.reveal.index, start: chase.reveal.start }, revealScale: chase.reveal ? cells[chase.reveal.index]?.indicator.scale.x : 1, revealOpacity: chase.reveal ? cells[chase.reveal.index]?.indicator.material.opacity : 1, revealIntensity: chase.reveal ? cells[chase.reveal.index]?.indicator.material.emissiveIntensity : rimLightIntensity, haloVisible: chase.reveal ? cells[chase.reveal.index]?.halo.visible : false, haloScale: chase.reveal ? cells[chase.reveal.index]?.halo.scale.x : 1, haloOpacity: chase.reveal ? cells[chase.reveal.index]?.halo.material.opacity : 0 } : null, audio: audio.diagnostics, stats: structuredClone(stats), drawCalls: renderer?.info.render.calls, triangles: renderer?.info.render.triangles }; }
  }) });
}
