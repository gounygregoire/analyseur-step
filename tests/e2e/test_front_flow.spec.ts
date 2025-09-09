import { test, expect } from '@playwright/test';
import path from 'path';

const cubePath = path.resolve('tests/data/cube_small.step');

test('parcours front minimal sans viewer', async ({ page }) => {
  let startCount = 0;
  let statusCount = 0;
  let resultCount = 0;

  await page.route('**/api/upload', async route => {
    route.fulfill({ status: 200, body: JSON.stringify({ file_id: 'f1', kind: 'step', filename: 'cube_small.step' }) });
  });
  await page.route('**/api/dfm/start', async route => {
    startCount++;
    const body = JSON.parse(route.request().postData() || '{}');
    expect(body).toMatchObject({ file_id: 'f1', material_profile: 'ABS', axis: 'Z+' });
    route.fulfill({ status: 200, body: JSON.stringify({ job_id: 'j1' }) });
  });
  await page.route('**/api/dfm/status', async route => {
    statusCount++;
    route.fulfill({ status: 200, body: JSON.stringify({ status: 'done', progress: 100 }) });
  });
  await page.route('**/api/dfm/result', async route => {
    resultCount++;
    route.fulfill({ status: 200, body: JSON.stringify({ summary: { bbox_mm: [1,1,1] }, issues: [{ type: 'thin' }] }) });
  });

  await page.setContent(`
    <input id="file" type="file" />
    <select id="material"><option value="ABS">ABS</option></select>
    <button id="axisBtn">Axis</button>
    <div id="axisPicker" style="display:none"><button id="axisZ">Z+</button></div>
    <button id="start">Lancer la DFM</button>
    <button id="cut">coupe</button><button id="reset">reset</button>
    <div id="summary"></div>
    <div id="issues"></div>
    <script>
      window.CAD = {};
      file.onchange = async e => {
        const fd = new FormData();
        fd.append('file', e.target.files[0]);
        const r = await fetch('/api/upload', {method:'POST', body:fd});
        window.CAD.fileIdStep = (await r.json()).file_id;
      };
      axisBtn.onclick = () => axisPicker.style.display = 'block';
      axisZ.onclick = () => { window.CAD.axis = 'Z+'; axisPicker.style.display = 'none'; };
      start.onclick = async () => {
        const r = await fetch('/api/dfm/start', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ file_id: window.CAD.fileIdStep, material_profile:'ABS', axis: window.CAD.axis })});
        const j = await r.json();
        await fetch('/api/dfm/status?job_id='+j.job_id);
        const res = await fetch('/api/dfm/result?job_id='+j.job_id);
        const data = await res.json();
        summary.textContent = JSON.stringify(data.summary);
        issues.textContent = JSON.stringify(data.issues);
      };
      cut.onclick = () => { window.cutClicked = true; };
      reset.onclick = () => { window.resetClicked = true; };
    </script>
  `);

  await page.setInputFiles('#file', cubePath);
  await expect(page.evaluate(() => (window as any).CAD.fileIdStep)).resolves.toBe('f1');
  await page.click('#axisBtn');
  await expect(page.locator('#axisPicker')).toBeVisible();
  await page.click('#axisZ');
  await page.click('#start');
  await expect(page.locator('#summary')).toContainText('bbox_mm');
  await expect(page.locator('#issues')).toContainText('thin');
  await page.click('#cut');
  await page.click('#reset');
  expect(startCount).toBe(1);
  expect(statusCount).toBe(1);
  expect(resultCount).toBe(1);
});
