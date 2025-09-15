import test from 'node:test';
import assert from 'node:assert/strict';
import { startViewer } from '../static/js/viewer.js';

test('startViewer renvoie le canvas', async () => {
  const container = {
    id: 'viewerContainer',
    clientHeight: 0,
    clientWidth: 0,
    style: {},
    appendChild(el) { this.child = el; }
  };
  const doc = {
    readyState: 'complete',
    addEventListener() {},
    getElementById(id) {
      if (id === 'viewerContainer') return container;
      if (id === 'xktCanvas') return undefined;
    },
    createElement(tag) {
      if (tag === 'canvas') {
        return {
          id: '',
          style: {},
          getContext() {
            return { clearColor() {}, clear() {}, COLOR_BUFFER_BIT: 16384 };
          }
        };
      }
      return {};
    }
  };
  globalThis.document = doc;

  const { canvas } = await startViewer();
  assert.equal(canvas.id, 'xktCanvas');
});
