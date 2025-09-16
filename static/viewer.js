// Viewer 3D minimaliste basé sur Three.js en attendant l'intégration Xeokit.
let renderer;
let scene;
let camera;
let controls;
let axesHelper;
let gridHelper;
let hemiLight;
let statusNote;
const persistentObjects = new Set();

function ensureThree() {
  if (!window.THREE) {
    console.error('Three.js non chargé.');
    return false;
  }
  if (!THREE.OrbitControls) {
    console.error('OrbitControls non disponibles.');
    return false;
  }
  return true;
}

function initViewer() {
  if (renderer || !ensureThree()) {
    return;
  }

  const container = document.getElementById('viewer-root');
  if (!container) {
    console.warn('viewer-root introuvable.');
    return;
  }

  const width = container.clientWidth || container.offsetWidth || 640;
  const height = container.clientHeight || container.offsetHeight || 480;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setClearColor(0x1e1f22, 1);

  container.innerHTML = '';
  container.style.position = container.style.position || 'relative';
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 5000);
  camera.position.set(0, 0, 300);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.target.set(0, 0, 0);
  controls.update();

  hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.1);
  scene.add(hemiLight);
  persistentObjects.add(hemiLight);

  axesHelper = new THREE.AxesHelper(100);
  scene.add(axesHelper);
  persistentObjects.add(axesHelper);

  gridHelper = new THREE.GridHelper(500, 20, 0x3a3b40, 0x2a2b30);
  gridHelper.material.opacity = 0.25;
  gridHelper.material.transparent = true;
  scene.add(gridHelper);
  persistentObjects.add(gridHelper);

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener('resize', () => {
    if (!renderer || !camera) return;
    const w = container.clientWidth || container.offsetWidth || width;
    const h = container.clientHeight || container.offsetHeight || height;
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
}

function clearDynamicObjects() {
  if (!scene) return;
  scene.children.slice().forEach((child) => {
    if (!persistentObjects.has(child)) {
      scene.remove(child);
      if (child.geometry) child.geometry.dispose?.();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach((mat) => mat.dispose?.());
        } else {
          child.material.dispose?.();
        }
      }
    }
  });
}

function showStatus(message) {
  const container = document.getElementById('viewer-root');
  if (!container) return;
  if (!statusNote) {
    statusNote = document.createElement('div');
    statusNote.style.cssText = 'position:absolute;top:12px;left:12px;padding:6px 12px;background:#000a;color:#fff;border-radius:8px;font-size:0.9rem;max-width:260px;pointer-events:none;';
    container.appendChild(statusNote);
  }
  statusNote.textContent = message;
}

function clearStatus() {
  if (statusNote && statusNote.parentNode) {
    statusNote.parentNode.removeChild(statusNote);
  }
  statusNote = null;
}

async function loadXKT(url) {
  if (!renderer) {
    initViewer();
  }
  if (!renderer || !scene || !camera) {
    console.error("Viewer non initialisé.");
    return;
  }

  try {
    clearStatus();
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) {
      const text = res.status === 404 ? 'XKT pas encore prêt (conversion en cours).' : `Impossible de charger le XKT (${res.status}).`;
      showStatus(text);
      return;
    }

    clearDynamicObjects();

    const geometry = new THREE.BoxGeometry(100, 100, 100);
    const material = new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.8, color: 0xb0c4de });
    const cube = new THREE.Mesh(geometry, material);
    cube.name = 'placeholder-mesh';
    scene.add(cube);

    fitCameraToObject(camera, cube, 1.2);
    clearStatus();
  } catch (error) {
    console.warn('Erreur de chargement XKT', error);
    showStatus('XKT pas encore prêt (convertissez via worker).');
  }
}

function fitCameraToObject(activeCamera, object3D, offset = 1.25) {
  if (!window.THREE || !activeCamera || !object3D) return;

  const box = new THREE.Box3().setFromObject(object3D);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fov = activeCamera.fov * (Math.PI / 180);
  let cameraZ = Math.abs(maxDim / (2 * Math.tan(fov / 2))) * offset;
  if (!isFinite(cameraZ)) {
    cameraZ = 500;
  }

  activeCamera.position.set(center.x, center.y, center.z + cameraZ);
  activeCamera.near = Math.max(cameraZ / 100, 0.1);
  activeCamera.far = Math.max(cameraZ * 100, activeCamera.near + 1000);
  activeCamera.updateProjectionMatrix();

  if (controls) {
    controls.target.copy(center);
    controls.update();
  } else {
    activeCamera.lookAt(center);
  }
}

window.loadXKT = loadXKT;

function bootstrapViewer() {
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initViewer, { once: true });
  } else {
    initViewer();
  }
}

bootstrapViewer();
