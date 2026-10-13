import { expect, test, type Page } from '@playwright/test'
import { addCard, addMember, card, createBoard, joinVia, newPeer, onboard } from './helpers'

async function defineField(page: Page, name: string, type: string, choices: string[] = []): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Card fields' })
  await dialog.getByPlaceholder('Field name').fill(name)
  await dialog.getByLabel('Type', { exact: true }).selectOption({ label: type })
  await dialog.getByRole('button', { name: 'Add field' }).click()
  await expect(dialog.locator('.field-type', { hasText: type })).toBeVisible()
  // typed back to back: the second choice must not overwrite the first
  for (const c of choices) {
    await dialog.getByLabel(`New choice for ${name}`).fill(c)
    await dialog.getByLabel(`New choice for ${name}`).press('Enter')
  }
  for (const c of choices) await expect(dialog.locator('.option-chip', { hasText: c })).toBeVisible()
}

test('cards take values from the board’s field templates, the same field more than once, and they sync', async ({
  browser,
}) => {
  const alice = await newPeer(browser)
  const vera = await newPeer(browser)
  await onboard(alice.page)
  const veraKey = await onboard(vera.page)
  const a = alice.page

  await createBoard(a, 'Releases')
  await addCard(a, 'To do', 'Ship 2.0')
  await a.getByLabel('Board options').click()
  await a.getByRole('button', { name: 'Card fields' }).click()
  await defineField(a, 'Link', 'Link')
  await defineField(a, 'Priority', 'Choice list', ['High', 'Low'])
  await defineField(a, 'Estimate', 'Number')
  await a.getByRole('dialog', { name: 'Card fields' }).getByRole('button', { name: 'Done' }).click()

  await card(a, 'Ship 2.0').locator('.card-body').click()
  const detail = a.getByRole('dialog', { name: 'Ship 2.0' })
  await expect(detail.locator('.entry')).toHaveCount(0)
  const add = async (field: string) => {
    await detail.getByText('Add field').click()
    await detail.locator('.menu-pop').getByRole('button', { name: field }).click()
  }
  const links = detail.getByRole('textbox', { name: 'Link' })

  await add('Link')
  await a.keyboard.type('example.com/spec')
  await a.keyboard.press('Enter')
  await expect(links).toHaveCount(1)
  await expect(links).toHaveValue('https://example.com/spec')

  await add('Link')
  await a.keyboard.type('https://example.com/design')
  await a.keyboard.press('Enter')
  await expect(links).toHaveCount(2)
  await expect(links.nth(1)).toHaveValue('https://example.com/design')

  await add('Priority')
  await detail.getByRole('combobox', { name: 'Priority' }).selectOption({ label: 'High' })
  await add('Estimate')
  await a.keyboard.type('3.5')
  await a.keyboard.press('Enter')
  await expect(detail.getByRole('spinbutton', { name: 'Estimate' })).toHaveValue('3.5')

  // an invalid link is refused and the unsaved row can be dropped
  await add('Link')
  await a.keyboard.type('not a link')
  await a.keyboard.press('Enter')
  await expect(detail.getByText('Enter a web address, like https://example.com')).toBeVisible()
  await detail.getByRole('button', { name: 'Remove Link' }).last().click()
  await expect(links).toHaveCount(2)
  await detail.getByRole('button', { name: 'Close' }).click()

  // a viewer sees the values read-only, links clickable
  const invite = await addMember(a, veraKey, 'Viewer')
  await a.getByRole('button', { name: 'Back to the board' }).click()
  await joinVia(vera.page, invite)
  await card(vera.page, 'Ship 2.0').locator('.card-body').click()
  const seen = vera.page.getByRole('dialog', { name: 'Ship 2.0' })
  await expect(seen.getByRole('link', { name: 'example.com/spec' })).toHaveAttribute('href', 'https://example.com/spec')
  await expect(seen.getByRole('link', { name: 'example.com/design' })).toBeVisible()
  await expect(seen.locator('.entry', { hasText: 'Priority' })).toContainText('High')
  await expect(seen.locator('.entry', { hasText: 'Estimate' })).toContainText('3.5')
  await expect(seen.getByText('Add field')).toHaveCount(0)

  // removing a value reaches the viewer live
  await card(a, 'Ship 2.0').locator('.card-body').click()
  await detail.getByRole('button', { name: 'Remove Link' }).first().click()
  await expect(seen.getByRole('link', { name: 'example.com/spec' })).toHaveCount(0)
  await expect(seen.getByRole('link', { name: 'example.com/design' })).toBeVisible()

  await alice.ctx.close()
  await vera.ctx.close()
})
