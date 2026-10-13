import { expect, test } from '@playwright/test'
import { addCard, addMember, card, column, createBoard, dragCardTo, joinVia, newPeer, onboard } from './helpers'

test('two people share a board: invite, live edits and drags sync both ways', async ({ browser }) => {
  const alice = await newPeer(browser)
  const bob = await newPeer(browser)
  await onboard(alice.page)
  const bobKey = await onboard(bob.page)

  await createBoard(alice.page, 'Launch')
  await addCard(alice.page, 'To do', 'Write the announcement')
  const link = await addMember(alice.page, bobKey, 'Editor')
  await alice.page.getByRole('button', { name: 'Back to the board' }).click()

  await joinVia(bob.page, link)
  await expect(bob.page.getByRole('heading', { name: 'Launch', level: 1 })).toBeVisible()
  await expect(card(bob.page, 'Write the announcement')).toBeVisible()

  await addCard(bob.page, 'Doing', 'Record the demo')
  await expect(card(alice.page, 'Record the demo')).toBeVisible()

  await dragCardTo(alice.page, 'Write the announcement', 'Done')
  await expect(column(alice.page, 'Done').getByText('Write the announcement')).toBeVisible()
  await expect(column(bob.page, 'Done').getByText('Write the announcement')).toBeVisible()

  // keyboard drag on Bob's side: space, arrow, space
  const handle = card(bob.page, 'Record the demo').locator('.card-body')
  await handle.focus()
  await bob.page.keyboard.press('Space')
  // the first press may only scroll the board to bring the target into view
  for (let i = 0; i < 4; i++) {
    await bob.page.keyboard.press('ArrowRight')
    await bob.page.waitForTimeout(300) // let the board's smooth scroll settle, as a person would
    const said = (await bob.page.locator('[role=status]').allTextContents()).join(' ')
    if (/is over (Done|Write the announcement)\./.test(said)) break
  }
  await bob.page.keyboard.press('Space')
  await expect(column(bob.page, 'Done').getByText('Record the demo')).toBeVisible()
  await expect(column(alice.page, 'Done').getByText('Record the demo')).toBeVisible()

  await alice.ctx.close()
  await bob.ctx.close()
})

test('a group of cards moves to another board in one go', async ({ browser }) => {
  const alice = await newPeer(browser)
  await onboard(alice.page)
  await createBoard(alice.page, 'Backlog')
  for (const t of ['One', 'Two', 'Three']) await addCard(alice.page, 'To do', t)
  await createBoard(alice.page, 'Sprint')
  await alice.page.locator('.side-board', { hasText: 'Backlog' }).click()

  await card(alice.page, 'One').locator('.card-body').click({ modifiers: ['ControlOrMeta'] })
  await card(alice.page, 'Three').locator('.card-body').click({ modifiers: ['ControlOrMeta'] })
  await expect(alice.page.getByText('2 selected')).toBeVisible()
  await alice.page.getByRole('button', { name: 'Move to…' }).click()
  await alice.page.getByRole('dialog').getByLabel('Board').selectOption({ label: 'Sprint' })
  await alice.page.getByRole('dialog').getByLabel('Column').selectOption({ label: 'Doing' })
  await alice.page.getByRole('button', { name: 'Move', exact: true }).click()

  await expect(card(alice.page, 'Two')).toBeVisible()
  await expect(card(alice.page, 'One')).toHaveCount(0)
  await alice.page.locator('.side-board', { hasText: 'Sprint' }).click()
  await expect(column(alice.page, 'Doing').getByText('One')).toBeVisible()
  await expect(column(alice.page, 'Doing').getByText('Three')).toBeVisible()
  await alice.ctx.close()
})
