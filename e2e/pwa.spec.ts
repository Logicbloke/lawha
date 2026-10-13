import { expect, test } from '@playwright/test'

test('the production build is an offline-capable PWA', async ({ page, context }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Create my key' })).toBeVisible()
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration()
    return !!reg?.active
  })
  await page.reload()
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]')!.getAttribute('href')!
    return (await fetch(href)).json()
  })
  expect(manifest.short_name).toBe('Lawha')

  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Create my key' })).toBeVisible()
  await context.setOffline(false)
})
