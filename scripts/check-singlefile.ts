import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

/**
 * Smoke-test dist-single/lawha.html from file:// (run after build:single):
 * onboard, create a board, add a card, switch to Arabic. No console errors
 * allowed apart from unreachable relays.
 */
const file = 'file://' + resolve('dist-single/lawha.html')
const browser = await chromium.launch()
const page = await browser.newPage()
const errors: string[] = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error' && !/WebSocket|net::|Failed to fetch|wss?:|tracker/i.test(m.text())) errors.push(m.text())
})

await page.goto(file)
await page.getByRole('button', { name: 'Create my key' }).click()
await page.getByRole('button', { name: 'I saved it' }).click()
await page.getByRole('button', { name: 'Start without a passphrase' }).click()
await page.locator('#new-board-name').fill('From a file')
await page.getByRole('button', { name: 'Create' }).click()
const todo = page.locator('section.column', { has: page.getByRole('heading', { name: 'To do' }) })
await todo.getByRole('button', { name: 'Add card' }).click()
await todo.getByPlaceholder('What needs doing?').fill('works offline from file://')
await todo.getByPlaceholder('What needs doing?').press('Enter')
await page.locator('[data-card]', { hasText: 'works offline' }).waitFor({ timeout: 10000 })
await page.locator('select.lang-picker').selectOption('ar')
const dir = await page.evaluate(() => document.documentElement.dir)

console.log('dir after switching to Arabic:', dir)
console.log('console/page errors:', errors.length ? errors : 'none')
const ok = dir === 'rtl' && errors.length === 0
console.log(ok ? 'SINGLE FILE OK' : 'PROBLEMS FOUND')
await browser.close()
process.exit(ok ? 0 : 1)
