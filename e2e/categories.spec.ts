import { expect, test, type Locator, type Page } from '@playwright/test'
import { newPeer, onboard } from './helpers'

const sideBoard = (page: Page, name: string) => page.locator('.sidebar .side-board', { hasText: name })
const category = (page: Page, name: string) => page.locator('.sidebar .side-cat', { hasText: name })

async function newSideBoard(page: Page, name: string): Promise<void> {
  await page.locator('.sidebar').getByRole('button', { name: 'New board' }).click()
  await page.locator('.sidebar').getByPlaceholder('Board name').fill(name)
  await page.locator('.sidebar').getByPlaceholder('Board name').press('Enter')
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
}

async function newCategory(page: Page, name: string): Promise<void> {
  await page.locator('.sidebar').getByRole('button', { name: 'New category' }).click()
  await page.locator('.sidebar').getByPlaceholder('Category name').fill(name)
  await page.locator('.sidebar').getByPlaceholder('Category name').press('Enter')
  await expect(category(page, name)).toBeVisible()
}

async function dragBoardOnto(page: Page, board: string, target: Locator): Promise<void> {
  const from = (await sideBoard(page, board).boundingBox())!
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + 20, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + 30, from.y + from.height / 2, { steps: 4 })
  await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 12 })
  await page.mouse.up()
  // dnd-kit swallows clicks for 50ms after a drop (so the drop is not also a click)
  await page.waitForTimeout(100)
}

test('personal boards: drag into a category, collapse it, and it stays that way', async ({ browser }) => {
  const { ctx, page } = await newPeer(browser)
  await onboard(page)
  await newSideBoard(page, 'Alpha')
  await newSideBoard(page, 'Beta')
  await newCategory(page, 'Side projects')
  await expect(category(page, 'Side projects').getByText('Drag boards here')).toBeVisible()

  await dragBoardOnto(page, 'Beta', category(page, 'Side projects').locator('.side-cat-head'))
  await expect(category(page, 'Side projects').locator('.side-board', { hasText: 'Beta' })).toBeVisible()
  await expect(page.locator('.sidebar .side-main .side-board', { hasText: 'Beta' })).toHaveCount(0)

  // collapsed, it hides its boards (except the one that is open)
  await page.locator('.wordmark').click()
  const toggle = category(page, 'Side projects').getByRole('button', { name: /Side projects/ })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(sideBoard(page, 'Beta')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Side projects', level: 2 })).toBeVisible() // home groups too

  await page.reload()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(category(page, 'Side projects').locator('.side-board', { hasText: 'Beta' })).toBeVisible()

  // the keyboard route: Board options > Category
  await sideBoard(page, 'Alpha').click()
  await page.getByLabel('Board options').click()
  await page.getByRole('button', { name: 'Category', exact: true }).click()
  await page.getByRole('dialog', { name: 'Category' }).getByRole('combobox').selectOption({ label: 'Side projects' })
  await page.getByRole('dialog', { name: 'Category' }).getByRole('button', { name: 'Save' }).click()
  await expect(category(page, 'Side projects').locator('.side-board', { hasText: 'Alpha' })).toBeVisible()

  // and back out to the main list by dragging
  await dragBoardOnto(page, 'Beta', page.locator('.sidebar .side-main .side-title'))
  await expect(page.locator('.sidebar .side-main .side-board', { hasText: 'Beta' })).toBeVisible()

  // menus close on Escape and on a click elsewhere
  await page.getByLabel('Options for Side projects').click()
  await expect(page.getByRole('button', { name: 'Delete category' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Delete category' })).toBeHidden()
  await page.getByLabel('Options for Side projects').click()
  await page.getByRole('heading', { level: 1 }).click()
  await expect(page.getByRole('button', { name: 'Delete category' })).toBeHidden()
  await ctx.close()
})

test('company categories: an admin groups the boards, every coworker sees it', async ({ browser }) => {
  const alice = await newPeer(browser)
  const bob = await newPeer(browser)
  await onboard(alice.page)
  const bobKey = await onboard(bob.page)
  const a = alice.page

  await a.getByRole('button', { name: 'New company workspace' }).click()
  await a.getByPlaceholder('Company name').fill('Acme')
  await a.getByPlaceholder('Company name').press('Enter')
  await expect(a.getByRole('heading', { name: 'Acme roster' })).toBeVisible()
  await a.getByPlaceholder('Paste a public key').fill(bobKey)
  await a.getByRole('button', { name: 'Add', exact: true }).click()
  const wsLink = (await a.locator('.invite code').textContent())!.trim()

  await newSideBoard(a, 'Ops')
  await a.getByRole('button', { name: 'Members' }).click()
  await a.locator('.candidates button').first().click()
  await a.getByRole('button', { name: 'Add', exact: true }).click()
  const boardLink = (await a.locator('.invite code').textContent())!.trim()
  await newCategory(a, 'Back office')
  await dragBoardOnto(a, 'Ops', category(a, 'Back office').locator('.side-cat-head'))
  await expect(category(a, 'Back office').locator('.side-board', { hasText: 'Ops' })).toBeVisible()

  const b = bob.page
  await b.goto('/' + wsLink.slice(wsLink.indexOf('#')))
  await b.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(b.getByRole('heading', { name: 'Acme roster' })).toBeVisible()
  await b.goto('/' + boardLink.slice(boardLink.indexOf('#')))
  await b.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(category(b, 'Back office').locator('.side-board', { hasText: 'Ops' })).toBeVisible()
  // only admins organize
  await expect(b.locator('.sidebar').getByRole('button', { name: 'New category' })).toHaveCount(0)
  await expect(b.getByLabel('Options for Back office')).toHaveCount(0)

  // a rename reaches Bob
  await a.getByLabel('Options for Back office').click()
  await a.getByRole('button', { name: 'Rename' }).click()
  await a.locator('.side-cat').getByRole('textbox', { name: 'Category name' }).fill('Operations')
  await a.locator('.side-cat').getByRole('textbox', { name: 'Category name' }).press('Enter')
  await expect(category(b, 'Operations').locator('.side-board', { hasText: 'Ops' })).toBeVisible()

  await alice.ctx.close()
  await bob.ctx.close()
})
