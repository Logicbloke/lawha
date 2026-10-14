import { expect, test } from '@playwright/test'
import { addCard, addMember, card, createBoard, joinVia, newPeer, onboard } from './helpers'

test('people see who else has a card open, live', async ({ browser }) => {
  const alice = await newPeer(browser)
  const bob = await newPeer(browser)
  await onboard(alice.page)
  const bobKey = await onboard(bob.page)
  const a = alice.page
  const b = bob.page

  await createBoard(a, 'Launch')
  await addCard(a, 'To do', 'Write the announcement')
  await addCard(a, 'To do', 'Book the venue')
  const link = await addMember(a, bobKey, 'Editor')
  await a.getByRole('button', { name: 'Back to the board' }).click()
  await joinVia(b, link)
  await expect(card(b, 'Write the announcement')).toBeVisible()

  // Bob opens a card: Alice sees it on that card only
  await card(b, 'Write the announcement').locator('.card-body').click()
  await expect(card(a, 'Write the announcement').locator('.viewers')).toHaveAttribute('aria-label', new RegExp(bobKey.slice(0, 8)))
  await expect(card(a, 'Book the venue').locator('.viewers')).toHaveCount(0)

  // both have it open: each sees the other in the dialog
  await card(a, 'Write the announcement').locator('.card-body').click()
  await expect(a.locator('.detail-viewers')).toContainText(`Also viewing${bobKey.slice(0, 8)}`)
  await expect(b.locator('.detail-viewers')).toContainText('Also viewing')

  // Bob closes it: gone on Alice's side
  await b.keyboard.press('Escape')
  await expect(a.locator('.detail-viewers')).toHaveCount(0)
  await a.keyboard.press('Escape')
  await expect(card(a, 'Write the announcement').locator('.viewers')).toHaveCount(0)

  await alice.ctx.close()
  await bob.ctx.close()
})
