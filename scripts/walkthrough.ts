import { chromium } from '@playwright/test'

/**
 * Drives a fresh identity through the main screens and saves screenshots.
 *   bun scripts/walkthrough.ts <outDir> [baseUrl]
 */
const out = process.argv[2] ?? 'shots'
const base = process.argv[3] ?? 'http://localhost:5173/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: (process.env.SCHEME as 'dark' | 'light') ?? 'dark' })
const page = await ctx.newPage()
const errors: string[] = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error' && !/WebSocket|net::|Failed to fetch|wss?:/.test(m.text())) errors.push(m.text())
})

await page.goto(base)
await page.getByRole('button', { name: 'Create my key' }).click()
await page.screenshot({ path: `${out}/01-backup.png` })
await page.getByRole('button', { name: 'I saved it' }).click()
await page.getByRole('button', { name: 'Start without a passphrase' }).click()
await page.getByRole('heading', { name: 'Your boards' }).waitFor()
await page.screenshot({ path: `${out}/02-home.png` })

await page.getByPlaceholder('Board name').last().fill('Launch plan')
await page.getByRole('button', { name: 'Create' }).click()
await page.getByRole('heading', { name: 'Launch plan' }).waitFor()
for (const [col, titles] of [
  ['To do', ['Write the announcement', 'Record the demo video', 'Translate the landing page into Arabic']],
  ['Doing', ['Fix iOS install banner']],
] as const) {
  const column = page.locator('section.column', { has: page.getByRole('heading', { name: col }) })
  await column.getByRole('button', { name: 'Add card' }).click()
  for (const t of titles) {
    await column.getByPlaceholder('What needs doing?').fill(t)
    await column.getByPlaceholder('What needs doing?').press('Enter')
  }
  await column.getByRole('button', { name: 'Done' }).click()
}
await page.screenshot({ path: `${out}/03-board.png` })

// drag a card from To do to Done
const card = page.locator('[data-card]', { hasText: 'Write the announcement' }).locator('.card-body')
const done = page.locator('section.column', { has: page.getByRole('heading', { name: 'Done', exact: true }) }).locator('ul.cards')
const a = (await card.boundingBox())!
const b = (await done.boundingBox())!
await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
await page.mouse.down()
await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2, { steps: 4 })
await page.mouse.move(b.x + b.width / 2, b.y + 20, { steps: 12 })
await page.screenshot({ path: `${out}/04-dragging.png` })
await page.mouse.up()
await page.waitForTimeout(400)
await page.screenshot({ path: `${out}/05-dropped.png` })

// select two and open move dialog
await page.locator('[data-card]', { hasText: 'Record the demo' }).locator('.card-body').click({ modifiers: ['Meta'] })
await page.locator('[data-card]', { hasText: 'Translate' }).locator('.card-body').click({ modifiers: ['Meta'] })
await page.screenshot({ path: `${out}/06-selected.png` })
await page.getByRole('button', { name: 'Clear' }).click()

await page.locator('[data-card]', { hasText: 'Fix iOS' }).locator('.card-body').click()
await page.getByRole('dialog').waitFor()
await page.screenshot({ path: `${out}/07-detail.png` })
await page.keyboard.press('Escape')

await page.getByRole('button', { name: 'Members' }).click()
await page.screenshot({ path: `${out}/08-members.png` })

// Arabic
await page.locator('select.lang-picker').selectOption('ar')
await page.getByRole('button', { name: 'العودة إلى اللوحة' }).click()
await page.waitForTimeout(300)
await page.screenshot({ path: `${out}/09-board-ar.png` })

// phone
await page.setViewportSize({ width: 390, height: 844 })
await page.locator('select.lang-picker').selectOption('en').catch(() => undefined)
await page.waitForTimeout(300)
await page.screenshot({ path: `${out}/10-phone.png` })

console.log('errors:', errors.length ? errors : 'none')
await browser.close()
