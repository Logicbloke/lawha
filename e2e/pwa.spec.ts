import { readFileSync, writeFileSync } from 'node:fs'
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

test('a tab left open is offered the next deploy', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => !!navigator.serviceWorker.controller)
  // the first install claims the tab too, but this tab is that build
  await page.waitForTimeout(500)
  await expect(page.getByRole('button', { name: 'Update Now' })).toHaveCount(0)

  // deploy: a new sw.js whose build no longer has this page's script or
  // styles. Playwright cannot route a worker's script fetch, but vite preview
  // reads files from disk on each request.
  const file = 'dist-e2e/sw.js'
  const original = readFileSync(file, 'utf8')
  try {
    writeFileSync(
      file,
      original
        .replace(/const CACHE = '([^']+)'/, "const CACHE = '$1-next'")
        .replace(/const ASSETS = (\[.*\])/, (_, list: string) =>
          `const ASSETS = ${JSON.stringify((JSON.parse(list) as string[]).filter((f) => !/\.(js|css)$/.test(f)))}`,
        ),
    )
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update()
    })
    await page.getByRole('button', { name: 'Update Now' }).click()
    await expect(page.getByRole('button', { name: 'Create my key' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Update Now' })).toHaveCount(0)
  } finally {
    writeFileSync(file, original)
  }
})
