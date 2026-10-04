import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Username').fill('labqc');
  await page.getByLabel('Password').fill('e2e-password-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Sentinel QC').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'QC', exact: true })).toBeVisible();
}

/** Create an HBsAg fixture through the API: assay + materials + frozen baselines. */
async function apiFixture(page: Page) {
  const profiles = await page.request.get('/api/v1/profiles');
  const profileId = (await profiles.json()).find((p: { name: string }) => p.name === 'N2_classic').id;
  const assayRes = await page.request.post('/api/v1/assays', {
    data: {
      name: 'HBsAg ELISA',
      methodology: 'ELISA',
      units: 'OD',
      transform: 'none',
      qcScheme: { levels: [{ level_code: 'L1', replicates: 1 }, { level_code: 'L2', replicates: 1 }] },
      westgardProfileId: profileId,
    },
  });
  const assayId = (await assayRes.json()).id;
  for (const [level, mean, sd] of [
    ['L1', 0.1, 0.01],
    ['L2', 1.4, 0.12],
  ] as const) {
    const m = await page.request.post('/api/v1/materials', {
      data: { assayId, levelCode: level, lot: `CTRL-${level}`, activeFrom: '2020-01-01T00:00:00Z' },
    });
    const materialId = (await m.json()).id;
    await page.request.post('/api/v1/baselines/freeze', {
      data: { assayId, qcMaterialId: materialId, method: 'manual_manufacturer', mean, sd, n: 20 },
    });
  }
  return assayId;
}

test('first-run E-ratio workflow: create assay → enter runs → PDF report', async ({ page }) => {
  await login(page);
  // a fresh database has no assays: the first-assay card is the landing state
  await expect(page.getByText('Set up your first assay')).toBeVisible();
  await page.getByLabel('Assay name').fill('HIV ELISA QC');
  await page.getByRole('button', { name: 'Create assay' }).click();

  // lab name is entered with the report data, not in any admin section
  await page.getByLabel(/Lab \/ blood bank name/).fill('Blood Center, District Hospital');
  await page.getByLabel(/Lab \/ blood bank name/).press('Enter');

  await page.getByLabel('Technician').fill('A. Tech');
  await page.getByLabel('Kit lot').fill('KIT-01');
  await page.getByLabel('IQC OD', { exact: true }).fill('1.263');
  await page.getByLabel('Cutoff OD').fill('0.201');
  await expect(page.getByText('E-ratio:')).toBeVisible();
  await page.getByRole('button', { name: /Add run/ }).click();

  // run log row with computed E-ratio (1.263/0.201 = 6.284)
  await expect(page.getByRole('cell', { name: '6.284' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'A. Tech' })).toBeVisible();
  await expect(page.getByText('QC Run Log')).toBeVisible();

  // a second run establishes self-derived limits
  await page.getByLabel('IQC OD', { exact: true }).fill('1.990');
  await page.getByLabel('Cutoff OD').fill('0.212');
  await page.getByRole('button', { name: /Add run/ }).click();
  await expect(page.getByRole('cell', { name: '9.387' })).toBeVisible();
  await page.getByRole('button', { name: 'Open chart' }).click();
  await expect(page.getByText(/Control limits from the mean and SD of the current 2 runs/)).toBeVisible();
  await expect(page.locator('svg[role="img"]')).toBeVisible();
  await page.getByRole('button', { name: 'Close chart' }).click();

  // the report downloads as an actual PDF file
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download report/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^QC-Report-HIV-ELISA-QC-.*\.pdf$/);
});

test('frozen-baseline assay: violation flags + override via History', async ({ page }) => {
  await login(page);
  await apiFixture(page);
  await page.reload();
  // pick the HBsAg assay
  await page.getByPlaceholder('Type to search…').click();
  await page.getByPlaceholder('Type to search…').fill('HBs');
  await page.keyboard.press('Enter');

  // passing run
  await page.getByLabel('L1', { exact: true }).fill('0.102');
  await page.getByLabel('L2', { exact: true }).fill('1.43');
  await page.getByRole('button', { name: /Add run/ }).click();
  await expect(page.getByText('In Control')).toBeVisible();
  await page.getByRole('button', { name: 'Open chart' }).click();
  await expect(page.getByText(/frozen baseline/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Close chart' }).click();

  // rejection: both controls beyond +2 SD → 2_2s
  await page.getByLabel('L1', { exact: true }).fill('0.125');
  await page.getByLabel('L2', { exact: true }).fill('1.70');
  await page.getByRole('button', { name: /Add run/ }).click();
  await expect(page.getByText('Out of Control')).toBeVisible();
  await expect(page.getByText('2₂ₛ').first()).toBeVisible();

  // supervisor override lives in the History drawer
  await page.getByRole('link', { name: 'History' }).click();
  await page.getByRole('cell', { name: 'REJECT', exact: true }).first().click();
  await page.getByRole('button', { name: /Supervisor override/ }).click();
  await page.locator('div.fixed textarea').fill('e2e: repeat verified in range');
  await page.getByRole('button', { name: 'Accept run' }).click();
  await expect(page.locator('div.fixed').getByText(/accepted by supervisor/)).toBeVisible();
});

test('bulk paste: 30 values with real dates', async ({ page }) => {
  await login(page);
  const profiles = await page.request.get('/api/v1/profiles');
  const profileId = (await profiles.json()).find((p: { name: string }) => p.name === 'N2_classic').id;
  const assayRes = await page.request.post('/api/v1/assays', {
    data: {
      name: 'Batch ELISA',
      qcScheme: { levels: [{ level_code: 'QC1', replicates: 1 }] },
      westgardProfileId: profileId,
    },
  });
  const assayId = (await assayRes.json()).id;
  await page.request.post('/api/v1/materials', {
    data: { assayId, levelCode: 'QC1', lot: 'B-1', activeFrom: '2020-01-01T00:00:00Z' },
  });
  await page.reload();
  await page.getByPlaceholder('Type to search…').click();
  await page.getByPlaceholder('Type to search…').fill('Batch');
  await page.keyboard.press('Enter');

  await page.getByRole('button', { name: /Bulk entry/ }).click();
  let s = 7;
  const vals: string[] = [];
  const dates: string[] = [];
  for (let i = 0; i < 30; i++) {
    s = (s * 48271) % 2147483647;
    vals.push((1.0 + (s / 2147483647 - 0.5) * 0.02).toFixed(4));
    const d = new Date(Date.UTC(2026, 0, 1 + i * 3));
    dates.push(d.toISOString().slice(0, 10));
  }
  await page.getByLabel(/Dates \(optional\)/).fill(dates.join('\n'));
  await page.getByLabel(/QC1 \(/).fill(vals.join('\n'));
  await page.getByLabel('Technician').last().fill('Sarika TS');
  await page.getByRole('button', { name: /Add 30 runs/ }).click();
  await expect(page.getByText(/30 runs added/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Open chart' }).click();
  await expect(page.getByText(/Control limits from the mean and SD of the current 30 runs/)).toBeVisible();
  await expect(page.locator('svg[role="img"]')).toBeVisible();
});

test('plate import → PSAD findings', async ({ page }) => {
  await login(page);
  // each login is its own workspace: create this session's assay first
  const profiles = await page.request.get('/api/v1/profiles');
  const profileId = (await profiles.json()).find((p: { name: string }) => p.name === 'N2_classic').id;
  await page.request.post('/api/v1/assays', {
    data: {
      name: 'Plate ELISA',
      qcScheme: { levels: [{ level_code: 'IQC', replicates: 1 }] },
      westgardProfileId: profileId,
    },
  });
  await page.reload();
  await page.getByRole('link', { name: 'Plates' }).click();
  await page.getByRole('button', { name: 'Import plate' }).click();
  const rows: string[] = [];
  let seed = 12345;
  const rand = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const norm = () => {
    const u = Math.max(rand(), 1e-9);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  for (let i = 0; i < 8; i++) {
    const cells: string[] = [];
    for (let j = 0; j < 12; j++) {
      let od = 0.08 * Math.exp(0.3 * norm());
      if (rand() < 0.08) od = 1.2 * Math.exp(0.4 * norm());
      if (i === 5) od *= Math.exp(1.2);
      cells.push(od.toFixed(4));
    }
    rows.push(cells.join(','));
  }
  await page.locator('div.fixed input[type="file"]').setInputFiles({
    name: 'rowf.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(rows.join('\n')),
  });
  await page.locator('div.fixed').getByRole('button', { name: 'Import & analyse' }).click();
  await expect(page.getByText(/Row F is systematically/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Median-polish residuals')).toBeVisible();
});

test('same credentials keep browser workspaces private, including lab names and downloads', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext({ baseURL: 'http://127.0.0.1:18080', extraHTTPHeaders: { 'x-sentinel-request': '1' } }), browser.newContext({ baseURL: 'http://127.0.0.1:18080', extraHTTPHeaders: { 'x-sentinel-request': '1' } })]);
  try {
    const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
    await login(a); await login(b);
    await expect(a.getByText('Private session', { exact: false }).first()).toBeVisible();
    for (const p of [a, b]) {
      await p.getByLabel('Assay name').fill('Independent HCV');
      await p.getByRole('button', { name: 'Create assay' }).click();
      await expect(p.getByLabel('IQC OD', { exact: true })).toBeVisible();
    }
    await a.getByLabel(/Lab \/ blood bank name/).fill('Alpha private lab');
    await a.getByLabel(/Lab \/ blood bank name/).press('Enter');
    await a.getByLabel('Technician').fill('Private Alpha Tech');
    await a.getByLabel('IQC OD', { exact: true }).fill('1.2');
    await a.getByLabel('Cutoff OD').fill('0.2');
    await a.getByRole('button', { name: /Add run/ }).click();
    await expect(a.getByRole('cell', { name: 'Private Alpha Tech' })).toBeVisible();
    await b.reload();
    await expect(b.getByText('Private Alpha Tech')).toHaveCount(0);
    await expect(b.getByLabel(/Lab \/ blood bank name/)).not.toHaveValue('Alpha private lab');
    const aid = (await (await a.request.get('/api/v1/assays')).json())[0].id;
    const report = await a.request.post('/api/v1/reports/assay', { data: { assayId: aid } });
    const reportId = (await report.json()).id;
    expect((await b.request.get(`/api/v1/runlog?assayId=${aid}`)).status()).toBe(404);
    expect((await b.request.get(`/api/v1/reports/${reportId}/download`)).status()).toBe(404);
    const sibling = await contexts[0].newPage();
    await sibling.goto('/history');
    await expect(sibling.getByRole('cell', { name: 'Independent HCV' })).toBeVisible();
    await a.screenshot({ path: '/private/tmp/sentinel-qc-private-session.png', fullPage: true });
    await a.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => a.locator('nav').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(380);
    await a.screenshot({ path: '/private/tmp/sentinel-qc-mobile.png', fullPage: true });
    await a.getByRole('button', { name: 'Sign out and clear this workspace' }).click();
    await expect(a.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(sibling.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(b.getByLabel('IQC OD', { exact: true })).toBeVisible();
    expect((await b.request.get('/api/v1/assays')).status()).toBe(200);
  } finally { await Promise.all(contexts.map(c => c.close())); }
});
