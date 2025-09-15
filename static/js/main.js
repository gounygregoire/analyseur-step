// static/js/main.js
import { startViewer } from './viewer.js';

export function attachViewerHandlers() {
  const bind = () => {
    const btn = document.querySelector('#btn-visualiser, #visualizeBtn');
    if (!btn) return;
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      console.info('[viewer] visualize click');
      const fid = window.currentFileId;
      if (fid && window.viewerAdapter?.loadFromFileId) {
        try {
          await window.viewerAdapter.loadFromFileId(fid);
          console.info('[viewer] XKT loaded', fid);
        } catch (err) {
          console.error('[viewer] load failed', err);
        }
      } else {
        console.warn('[viewer] no XKT disponible');
      }
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }
}

startViewer();
attachViewerHandlers();
