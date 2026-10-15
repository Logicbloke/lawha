import { expect, test, type Page } from '@playwright/test'
import { createBoard, newPeer, onboard } from './helpers'

/** What this browser holds: Lawha's identity and boards, and every localStorage key. */
async function stored(page: Page): Promise<{ identity: number; boards: number; keys: string[] }> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((ok, no) => {
      const r = indexedDB.open('lawha')
      r.onsuccess = () => ok(r.result)
      r.onerror = () => no(r.error)
    })
    const count = (store: string): Promise<number> =>
      new Promise((ok) => {
        const q = db.transaction(store).objectStore(store).count()
        q.onsuccess = () => ok(q.result)
      })
    const out = { identity: await count('identity'), boards: await count('boards'), keys: Object.keys(localStorage).sort() }
    db.close()
    return out
  })
}

test('everything Lawha keeps in this browser is deleted in one go, and nothing else', async ({ browser }) => {
  const { ctx, page } = await newPeer(browser)
  await onboard(page)
  await createBoard(page, 'Private')
  // another app on the same origin (the owner's other github.io pages)
  await page.evaluate(() => localStorage.setItem('shabaka-keep', '1'))
  await page.locator('.sidebar select').last().selectOption('sv') // a setting Lawha keeps
  await page.locator('.sidebar select').last().selectOption('en')
  expect((await stored(page)).keys).toContain('lawha-lang')
  await page.getByRole('button', { name: 'Key & security' }).click()

  page.once('dialog', (d) => void d.dismiss())
  await page.getByRole('button', { name: 'Delete everything in this browser' }).click()
  await expect(page.locator('.side-board', { hasText: 'Private' })).toBeVisible()

  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'Delete everything in this browser' }).click()
  await expect(page.getByRole('button', { name: 'Create my key' })).toBeVisible()
  const after = await stored(page)
  expect(after.identity).toBe(0)
  expect(after.boards).toBe(0)
  expect(after.keys.filter((k) => /^lawha/.test(k))).toEqual([])
  expect(after.keys).toContain('shabaka-keep')
  await ctx.close()
})

test('a forgotten passphrase: start over from the locked screen', async ({ browser }) => {
  const { ctx, page } = await newPeer(browser)
  await page.getByRole('button', { name: 'Create my key' }).click()
  await page.getByRole('button', { name: 'I saved it' }).click()
  await page.getByPlaceholder('Passphrase (leave empty to skip)').fill('correct horse')
  await page.getByRole('button', { name: 'Encrypt and start' }).click()
  await expect(page.getByRole('heading', { name: 'Your boards' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Unlock' })).toBeVisible()

  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'Delete everything in this browser' }).click()
  await expect(page.getByRole('button', { name: 'Create my key' })).toBeVisible()
  expect((await stored(page)).identity).toBe(0)
  await ctx.close()
})
