import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { addCard, addMember, card, createBoard, joinVia, newPeer, onboard } from './helpers'

/** a 1×1 PNG: decodable, so it gets a preview and opens in the lightbox */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')

function noise(n: number): Buffer {
  const out = Buffer.alloc(n)
  for (let i = 0; i < n; i++) out[i] = (i * 7919 + (i >> 8)) & 0xff
  return out
}

async function openCard(page: Page, title: string) {
  await card(page, title).locator('.card-body').click()
  return page.getByRole('dialog', { name: title })
}

async function attach(page: Page, title: string, files: Array<{ name: string; mimeType: string; buffer: Buffer }>) {
  const detail = await openCard(page, title)
  await detail.locator('.attach-add input[type=file]').setInputFiles(files)
  for (const f of files) await expect(detail.locator('.attach-name', { hasText: f.name })).toBeVisible()
  return detail
}

test('a file reaches the others, and a coworker passes it on once its uploader is gone', async ({ browser }) => {
  const alice = await newPeer(browser)
  const bob = await newPeer(browser)
  const carol = await newPeer(browser)
  await onboard(alice.page)
  const bobKey = await onboard(bob.page)
  const carolKey = await onboard(carol.page)

  await createBoard(alice.page, 'Design')
  await addCard(alice.page, 'To do', 'Logo')
  const bobLink = await addMember(alice.page, bobKey, 'Editor')
  const carolLink = await addMember(alice.page, carolKey, 'Viewer')
  await alice.page.getByRole('button', { name: 'Back to the board' }).click()

  const big = noise(600 * 1024) // three pieces
  const detail = await attach(alice.page, 'Logo', [
    { name: 'logo.png', mimeType: 'image/png', buffer: PNG },
    { name: 'source.bin', mimeType: 'application/octet-stream', buffer: big },
  ])
  await expect(detail.locator('.attach-thumb img')).toHaveCount(1)
  await expect(card(alice.page, 'Logo').locator('.attached')).toHaveText('2')

  await joinVia(bob.page, bobLink)
  const bobDetail = await openCard(bob.page, 'Logo')
  await expect(bobDetail.locator('.attach-row')).toHaveCount(2)
  // both are small enough to be fetched without asking
  await expect(bobDetail.locator('.attach-status')).toHaveCount(0)
  await bobDetail.getByRole('button', { name: 'Open logo.png' }).click()
  const shown = bob.page.locator('.lightbox img')
  await expect(shown).toHaveAttribute('src', /^blob:/)
  await bob.page.keyboard.press('Escape')
  await expect(shown).toHaveCount(0)
  await expect(bobDetail).toBeVisible() // Escape closed the picture, not the card

  await alice.ctx.close()

  await joinVia(carol.page, carolLink)
  const carolDetail = await openCard(carol.page, 'Logo')
  await expect(carolDetail.locator('.attach-row')).toHaveCount(2)
  await expect(carolDetail.locator('.attach-status')).toHaveCount(0)
  const [download] = await Promise.all([
    carol.page.waitForEvent('download'),
    carolDetail.locator('.attach-row', { hasText: 'source.bin' }).getByRole('button', { name: 'Download' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('source.bin')
  expect(readFileSync((await download.path())!).equals(big)).toBe(true)

  await bob.ctx.close()
  await carol.ctx.close()
})

test('a picture that is really markup is only ever downloaded, never shown', async ({ browser }) => {
  const alice = await newPeer(browser)
  await onboard(alice.page)
  await createBoard(alice.page, 'Safety')
  await addCard(alice.page, 'To do', 'Suspicious')
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>parent.pwned=1</script></svg>')
  const detail = await attach(alice.page, 'Suspicious', [{ name: 'cat.png', mimeType: 'image/png', buffer: svg }])
  const [download] = await Promise.all([
    alice.page.waitForEvent('download'),
    detail.getByRole('button', { name: 'Open cat.png' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('cat.png')
  await expect(alice.page.locator('.lightbox')).toHaveCount(0)
  expect(await alice.page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined()
  await alice.ctx.close()
})

test('Arabic: the attachments panel reads right to left', async ({ browser }) => {
  const alice = await newPeer(browser)
  await onboard(alice.page)
  await createBoard(alice.page, 'Files')
  await addCard(alice.page, 'To do', 'Report')
  await attach(alice.page, 'Report', [{ name: 'تقرير.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n') }])
  await alice.page.keyboard.press('Escape')
  await alice.page.locator('select.lang-picker').selectOption('ar')
  await expect(alice.page.locator('html')).toHaveAttribute('dir', 'rtl')
  await card(alice.page, 'Report').locator('.card-body').click()
  const detail = alice.page.getByRole('dialog', { name: 'Report' })
  await expect(detail.getByRole('heading', { name: 'المرفقات' })).toBeVisible()
  const row = detail.locator('.attach-row')
  const thumb = (await row.locator('.attach-thumb').boundingBox())!
  const actions = (await row.locator('.attach-actions').boundingBox())!
  expect(thumb.x).toBeGreaterThan(actions.x) // the preview starts the row, on the right
  await alice.ctx.close()
})
