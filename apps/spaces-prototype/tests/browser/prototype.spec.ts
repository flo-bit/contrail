import { expect, test } from '@playwright/test';
import { ORIGIN } from '../../src/lib/config';

// No OAuth grants or real account data. The test server is a fresh process and
// unknown-host previews fail locally, before any network request to a PDS.
test('sign-in screen is minimal, responsive and private', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.headers()['cache-control']).toBe('private, no-store');
  await expect(page.getByRole('heading', { name: 'Private events' })).toBeVisible();
  await expect(page.getByLabel('Account handle')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('hydrates, strips invitation fragment and posts preview without joining', async ({ page }) => {
  const errors: string[] = [];
  const requests: { method: string; url: string; body: string | null }[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('request', (request) => requests.push({ method: request.method(), url: request.url(), body: request.postData() }));
  // Prevent accidental external requests even if a regression introduced one.
  await page.route('**/*', (route) => new URL(route.request().url()).origin === ORIGIN ? route.continue() : route.abort());
  const secret = 'a'.repeat(43);
  await page.goto(`/invite/did%3Aplc%3Aalice/test-link#${secret}`);
  await expect(page.getByText('The host needs to reconnect their account.')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(requests.filter((r) => r.method === 'POST' && r.url.endsWith('?/preview'))).toHaveLength(1);
  expect(requests.find((r) => r.url.endsWith('?/preview'))?.body).toContain(secret);
  expect(requests.some((r) => r.method === 'GET' && r.url.includes(secret))).toBe(false);
  expect(requests.some((r) => r.url.includes('?/accept'))).toBe(false);
  expect(requests.some((r) => new URL(r.url).origin !== ORIGIN)).toBe(false);
  await expect(page.getByRole('button', { name: 'Join event' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('rejects cross-origin mutation and unauthenticated acceptance', async ({ request }) => {
  const csrf = await request.post('/logout', { headers: { origin: 'https://evil.example' } });
  expect(csrf.status()).toBe(403);
  const anonymous = await request.post('/invite/did%3Aplc%3Aalice/test-link?/accept', {
    headers: { origin: ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' }, form: {},
  });
  // Enhanced SvelteKit forms encode ActionFailure's status in the JSON result.
  expect(await anonymous.json()).toMatchObject({ type: 'failure', status: 401 });
});
