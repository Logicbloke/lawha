import { expect, test } from '@playwright/test'
import { addCard, addMember, card, createBoard, joinVia, newPeer, onboard } from './helpers'

test('a viewer reads but cannot edit; a removed member stops getting updates', async ({ browser }) => {
  const alice = await newPeer(browser)
  const vera = await newPeer(browser)
  const eve = await newPeer(browser)
  await onboard(alice.page)
  const veraKey = await onboard(vera.page)
  const eveKey = await onboard(eve.page)

  await createBoard(alice.page, 'Roadmap')
  await addCard(alice.page, 'To do', 'Visible to all')
  await addMember(alice.page, veraKey, 'Viewer')
  const link = await addMember(alice.page, eveKey, 'Editor')
  await alice.page.getByRole('button', { name: 'Back to the board' }).click()

  await joinVia(vera.page, link)
  await expect(card(vera.page, 'Visible to all')).toBeVisible()
  await expect(vera.page.getByText('You can view this board.')).toBeVisible()
  await expect(vera.page.getByRole('button', { name: 'Add card' })).toHaveCount(0)

  await joinVia(eve.page, link)
  await expect(card(eve.page, 'Visible to all')).toBeVisible()

  // remove Eve, then write something new
  await alice.page.getByRole('button', { name: 'Members' }).click()
  alice.page.once('dialog', (d) => void d.accept())
  await alice.page.locator('.member-list li', { hasText: eveKey.slice(0, 8) }).getByRole('button', { name: 'Remove' }).click()
  await expect(alice.page.locator('.member-list li', { hasText: eveKey.slice(0, 8) })).toHaveCount(0)
  await alice.page.getByRole('button', { name: 'Back to the board' }).click()
  await addCard(alice.page, 'To do', 'After Eve left')

  await expect(card(vera.page, 'After Eve left')).toBeVisible()
  await expect(eve.page.getByRole('heading', { name: 'You are not a member of this board' })).toBeVisible()
  await expect(card(eve.page, 'After Eve left')).toHaveCount(0)

  for (const p of [alice, vera, eve]) await p.ctx.close()
})
