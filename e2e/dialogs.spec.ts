import { expect, test } from '@playwright/test'
import { createBoard, newPeer, onboard } from './helpers'

test('dialog fields keep focus while typing', async ({ browser }) => {
  const alice = await newPeer(browser)
  await onboard(alice.page)
  await createBoard(alice.page, 'Focus')

  await alice.page.getByLabel('Board options').click()
  await alice.page.getByRole('button', { name: 'Your name on this board' }).click()
  const field = alice.page.getByRole('textbox', { name: 'Display name' })
  await expect(field).toBeFocused()
  // typed into whatever has focus: a dialog that steals it after a keystroke loses the rest
  await alice.page.keyboard.type('Alice Lindqvist', { delay: 20 })
  await expect(field).toHaveValue('Alice Lindqvist')
  await expect(field).toBeFocused()

  await alice.page.keyboard.press('Escape')
  await expect(field).toHaveCount(0)

  await alice.ctx.close()
})
