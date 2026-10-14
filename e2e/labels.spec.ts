import { expect, test } from '@playwright/test'
import { addCard, addMember, card, createBoard, joinVia, newPeer, onboard } from './helpers'

test('labels are defined in the board options and picked on cards, and they sync', async ({ browser }) => {
  const alice = await newPeer(browser)
  const bob = await newPeer(browser)
  await onboard(alice.page)
  const bobKey = await onboard(bob.page)
  const a = alice.page
  const b = bob.page

  await createBoard(a, 'Releases')
  await addCard(a, 'To do', 'Ship 2.0')

  // a card offers no way to make up a label, only a pointer to the board options
  await card(a, 'Ship 2.0').locator('.card-body').click()
  const detail = a.getByRole('dialog', { name: 'Ship 2.0' })
  await expect(detail.getByText('This board has no labels yet.', { exact: false })).toBeVisible()
  await expect(detail.getByRole('textbox', { name: 'New label' })).toHaveCount(0)
  await a.keyboard.press('Escape')

  await a.getByLabel('Board options').click()
  await a.getByRole('button', { name: 'Labels', exact: true }).click()
  const settings = a.getByRole('dialog', { name: 'Labels' })
  await settings.getByPlaceholder('New label').fill('Bug')
  await settings.getByPlaceholder('New label').press('Enter')
  await settings.getByPlaceholder('New label').fill('Feature')
  await settings.getByRole('radiogroup', { name: 'Label color' }).getByRole('radio', { name: 'Blue' }).click()
  await settings.getByRole('button', { name: 'Add label' }).click()
  const names = settings.getByRole('textbox', { name: 'Label name' })
  await expect(names).toHaveCount(2)
  await expect(names.nth(0)).toHaveValue('Bug')
  await expect(names.nth(1)).toHaveValue('Feature')
  // each new label starts in a color not taken yet
  await expect(settings.getByRole('radiogroup', { name: 'Change the color of Bug' }).getByRole('radio', { checked: true })).toHaveAccessibleName('Red')
  await expect(settings.getByRole('radiogroup', { name: 'Change the color of Feature' }).getByRole('radio', { checked: true })).toHaveAccessibleName('Blue')
  await settings.getByRole('button', { name: 'Done' }).click()

  await card(a, 'Ship 2.0').locator('.card-body').click()
  await detail.getByRole('button', { name: 'Bug' }).click()
  await expect(detail.getByRole('button', { name: 'Bug' })).toHaveAttribute('aria-pressed', 'true')
  await a.keyboard.press('Escape')
  await expect(card(a, 'Ship 2.0').locator('.label-chip.c-red')).toHaveText('Bug')

  // renamed and recolored in one place, changed on every card
  await a.getByLabel('Board options').click()
  await a.getByRole('button', { name: 'Labels', exact: true }).click()
  await names.nth(0).fill('Defect')
  await names.nth(0).press('Enter')
  await settings.getByRole('radiogroup', { name: 'Change the color of Defect' }).getByRole('radio', { name: 'Orange' }).click()
  await expect(card(a, 'Ship 2.0').locator('.label-chip.c-orange')).toHaveText('Defect')

  // archived labels leave the cards and the picker, and can come back
  await settings.locator('.label-def', { has: a.getByRole('radiogroup', { name: 'Change the color of Defect' }) }).getByRole('button', { name: 'Archive' }).click()
  await expect(names).toHaveCount(1)
  await expect(card(a, 'Ship 2.0').locator('.label-chip')).toHaveCount(0)
  await settings.locator('.archive-list li', { hasText: 'Defect' }).getByRole('button', { name: 'Restore' }).click()
  await expect(names).toHaveCount(2)
  await expect(card(a, 'Ship 2.0').locator('.label-chip.c-orange')).toHaveText('Defect')
  await settings.getByRole('button', { name: 'Done' }).click()

  // an editor sees them and picks from them
  const link = await addMember(a, bobKey, 'Editor')
  await a.getByRole('button', { name: 'Back to the board' }).click()
  await joinVia(b, link)
  await expect(card(b, 'Ship 2.0').locator('.label-chip.c-orange')).toHaveText('Defect')
  await card(b, 'Ship 2.0').locator('.card-body').click()
  await b.getByRole('dialog', { name: 'Ship 2.0' }).getByRole('button', { name: 'Feature' }).click()
  await expect(card(a, 'Ship 2.0').locator('.label-chip.c-blue')).toHaveText('Feature')

  await alice.ctx.close()
  await bob.ctx.close()
})
