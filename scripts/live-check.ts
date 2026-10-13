import { chromium, expect } from '@playwright/test'

/**
 * Two independent browsers on a hosted copy, syncing a board over the PUBLIC
 * discovery networks (no local broker):
 *   bun scripts/live-check.ts https://logicbloke.github.io/lawha/
 */
const base = process.argv[2] ?? 'https://logicbloke.github.io/lawha/'
const t0 = Date.now()
const log = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`)
const a = await chromium.launch()
const b = await chromium.launch()
const pa = await (await a.newContext()).newPage()
const pb = await (await b.newContext()).newPage()

async function onboard(page: typeof pa): Promise<string> {
  await page.goto(base)
  await page.getByRole('button', { name: 'Create my key' }).click()
  await page.getByRole('button', { name: 'I saved it' }).click()
  await page.getByRole('button', { name: 'Start without a passphrase' }).click()
  await page.getByRole('button', { name: 'People' }).click()
  return (await page.locator('code.pubkey').textContent())!.trim()
}

await onboard(pa)
const bobKey = await onboard(pb)
log('both onboarded; sw: ' + (await pa.evaluate(() => !!navigator.serviceWorker)))

await pa.locator('.wordmark').click()
await pa.locator('#new-board-name').fill(`Live check ${new Date().toISOString().slice(11, 19)}`)
await pa.getByRole('button', { name: 'Create' }).click()
const todo = pa.locator('section.column', { has: pa.getByRole('heading', { name: 'To do' }) })
await todo.getByRole('button', { name: 'Add card' }).click()
await todo.getByPlaceholder('What needs doing?').fill('Hello over public relays')
await todo.getByPlaceholder('What needs doing?').press('Enter')
await pa.getByRole('button', { name: 'Members' }).click()
await pa.getByPlaceholder('Paste a public key').fill(bobKey)
await pa.getByRole('button', { name: 'Add', exact: true }).click()
const link = (await pa.locator('.invite code').textContent())!.trim()
await pa.getByRole('button', { name: 'Back to the board' }).click()
log('board created, bob added: ' + link)

await pb.goto(link)
await pb.getByRole('button', { name: 'Join', exact: true }).click()
await expect(pb.locator('[data-card]', { hasText: 'Hello over public relays' })).toBeVisible({ timeout: 120_000 })
log('bob received the card')
console.log('alice peers:', await pa.locator('.peer-status').textContent(), '| bob peers:', await pb.locator('.peer-status').textContent())

const doing = pb.locator('section.column', { has: pb.getByRole('heading', { name: 'Doing' }) })
await doing.getByRole('button', { name: 'Add card' }).click()
await doing.getByPlaceholder('What needs doing?').fill('Reply from Bob')
await doing.getByPlaceholder('What needs doing?').press('Enter')
await expect(pa.locator('[data-card]', { hasText: 'Reply from Bob' })).toBeVisible({ timeout: 60_000 })
log('alice received bob\'s card')
console.log('LIVE SYNC OK')
await a.close()
await b.close()
