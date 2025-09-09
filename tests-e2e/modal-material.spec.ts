import { test, expect } from '@playwright/test';

test('Ouverture et fermeture du modal matière', async ({ page }) => {
  await page.goto('/app');
  const analyze = page.locator('#analyzeBtn');
  await expect(analyze).toBeVisible();

  await analyze.click();
  const modal = page.locator('#materialQuestionnaireModal.show, .modal.show:has(#materialQuestionnaireModal)');
  await expect(modal).toBeVisible();

  await modal.getByRole('button', { name: 'Annuler' }).click();

  await expect(page.locator('#materialQuestionnaireModal.show')).toHaveCount(0);
});
