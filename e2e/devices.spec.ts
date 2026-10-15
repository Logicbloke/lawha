import { expect, test } from '@playwright/test'
import { addCard, card, createBoard, newPeer } from './helpers'

test('a second device that only restored the key finds the first and, once allowed there, takes up its boards', async ({ browser }) => {
  const laptop = await newPeer(browser)
  await laptop.page.getByRole('button', { name: 'Create my key' }).click()
  const backup = (await laptop.page.locator('code.backup').textContent())!.trim()
  await laptop.page.getByRole('button', { name: 'I saved it' }).click()
  await laptop.page.getByRole('button', { name: 'Start without a passphrase' }).click()
  await createBoard(laptop.page, 'Errands')
  await addCard(laptop.page, 'To do', 'Buy stamps')

  // no board, no invite: just the key
  const phone = await newPeer(browser)
  await phone.page.getByRole('button', { name: 'I already have a key' }).click()
  await phone.page.getByLabel('Restore your key').fill(backup)
  await phone.page.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(phone.page.getByRole('heading', { name: 'Your boards' })).toBeVisible()
  const code = (await phone.page.locator('.device-hint code').textContent())!.trim()
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)

  // the laptop asks first, showing the phone's code; nothing reaches the phone before
  const ask = laptop.page.locator('.device-request')
  await expect(ask.locator('code')).toHaveText(code)
  await expect(phone.page.locator('.side-board')).toHaveCount(0)
  await ask.getByRole('button', { name: 'Allow' }).click()
  await expect(ask).toHaveCount(0)

  await phone.page.locator('.side-board', { hasText: 'Errands' }).click()
  await expect(card(phone.page, 'Buy stamps')).toBeVisible()
  // a board this device did not choose: its files only when opened
  const prefs = await phone.page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('lawha:files:'))
      .map((k) => localStorage.getItem(k)),
  )
  expect(prefs).toEqual(['0'])

  await addCard(phone.page, 'Doing', 'Post the letter')
  await expect(card(laptop.page, 'Post the letter')).toBeVisible()

  await laptop.ctx.close()
  await phone.ctx.close()
})
