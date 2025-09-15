const { initViewer } = await import('../static/js/viewer.js');

test('initViewer renvoie le canvas', async () => {
  document.body.innerHTML = `<div id="viewerContainer"></div>`;
  const result = await initViewer();
  expect(result.canvas.id).toBe('xktCanvas');
});

