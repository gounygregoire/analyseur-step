import { jest } from '@jest/globals';

// Mock minimal API du SDK Xeokit
jest.unstable_mockModule('@xeokit/xeokit-sdk', () => {
  const Viewer = jest.fn().mockImplementation(() => ({
    scene: {
      canvas: { canvas: { addEventListener: jest.fn() } },
      getAABB: jest.fn(),
    },
    cameraControl: { fit: jest.fn() },
    cameraFlight: { fit: jest.fn() },
    model: null,
  }));

  const loadMock = jest.fn().mockRejectedValue(new Error('404'));

  const XKTLoaderPlugin = jest.fn().mockImplementation(() => ({
    load: loadMock,
    on: jest.fn(),
  }));

  const DistanceMeasurementsPlugin = jest.fn().mockImplementation(() => ({ on: jest.fn() }));
  const SectionPlanesPlugin = jest.fn();
  const AxisGizmoPlugin = jest.fn();

  return {
    Viewer,
    XKTLoaderPlugin,
    DistanceMeasurementsPlugin,
    SectionPlanesPlugin,
    AxisGizmoPlugin,
  };
});

// Mock de l'adaptateur DFM pour éviter les imports CDN
jest.unstable_mockModule('../static/js/modules/DFMViewerAdapter.js', () => ({
  default: class {
    constructor() {}
  }
}));

// Import après mock
const { initViewer } = await import('../src/main.js');

test('affiche une erreur si le chargement du modèle échoue', async () => {
  document.body.innerHTML = `
    <div id="progressSection"></div>
    <div id="errorAlert" style="display:none"></div>
    <div id="errorMessage"></div>
    <canvas id="viewer3d"></canvas>
  `;
  window.showError = jest.fn();

  await initViewer();

  const result = await window.viewerAdapter.loadFromFileId('foo');
  expect(result).toBe(false);
  expect(window.showError).toHaveBeenCalledWith('Impossible de charger le modèle 3D');
});

