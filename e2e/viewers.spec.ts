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

  // Bob writes a comment: Alice sees it under her comment box until he sends it
  const writing = a.locator('.writing-note')
  await b.getByPlaceholder('Write a comment').fill('Draft is in the doc')
  await expect(writing).toHaveText(`${bobKey.slice(0, 8)} is writing a comment…`)
  await b.getByPlaceholder('Write a comment').fill('')
  await expect(writing).toHaveText('')
  await b.getByPlaceholder('Write a comment').fill('Draft is in the doc')
  await expect(writing).toHaveText(`${bobKey.slice(0, 8)} is writing a comment…`)
  await b.getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(writing).toHaveText('')
  await expect(a.locator('.comment-text')).toHaveText('Draft is in the doc')
  // and stops showing once he pauses
  await b.getByPlaceholder('Write a comment').fill('One more')
  await expect(writing).not.toHaveText('')
  await expect(writing).toHaveText('', { timeout: 10_000 })

  // Bob closes it: gone on Alice's side
  await b.keyboard.press('Escape')
  await expect(a.locator('.detail-viewers')).toHaveCount(0)
  await a.keyboard.press('Escape')
  await expect(card(a, 'Write the announcement').locator('.viewers')).toHaveCount(0)

  await alice.ctx.close()
  await bob.ctx.close()
})
