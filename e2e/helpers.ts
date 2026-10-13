import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'

export async function newPeer(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext()
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'])
  const page = await ctx.newPage()
  await page.goto('/')
  return { ctx, page }
}

/** Fresh identity without a passphrase. Returns the public key. */
export async function onboard(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Create my key' }).click()
  await page.getByRole('button', { name: 'I saved it' }).click()
  await page.getByRole('button', { name: 'Start without a passphrase' }).click()
  await expect(page.getByRole('heading', { name: 'Your boards' })).toBeVisible()
  await page.getByRole('button', { name: 'People' }).click()
  const key = (await page.locator('code.pubkey').textContent())?.trim()
  if (!key || key.length !== 43) throw new Error(`bad pubkey: ${key}`)
  return key
}

export async function createBoard(page: Page, name: string, inCompany = false): Promise<void> {
  if (inCompany) {
    await page.getByRole('button', { name: 'New board' }).click()
    await page.getByPlaceholder('Board name').first().fill(name)
    await page.getByPlaceholder('Board name').first().press('Enter')
  } else {
    await page.locator('.wordmark').click()
    await page.locator('#new-board-name').fill(name)
    await page.getByRole('button', { name: 'Create' }).click()
  }
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
}

export function column(page: Page, name: string): Locator {
  return page.locator('section.column', { has: page.getByRole('heading', { name, exact: true }) })
}

export function card(page: Page, title: string): Locator {
  return page.locator('[data-card]', { hasText: title })
}

export async function addCard(page: Page, col: string, title: string): Promise<void> {
  const c = column(page, col)
  await c.getByRole('button', { name: 'Add card' }).click()
  await c.getByPlaceholder('What needs doing?').fill(title)
  await c.getByPlaceholder('What needs doing?').press('Enter')
  await c.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(card(page, title)).toBeVisible()
}

/** Add a member by key on the open board's members page; returns the invite link. */
export async function addMember(page: Page, pub: string, role: 'Viewer' | 'Editor' | 'Admin'): Promise<string> {
  if ((await page.getByPlaceholder('Paste a public key').count()) === 0) {
    await page.getByRole('button', { name: 'Members' }).click()
  }
  await page.getByPlaceholder('Paste a public key').fill(pub)
  await page.getByLabel('Role', { exact: true }).selectOption({ label: role })
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('.member-list li', { hasText: pub.slice(0, 8) })).toBeVisible()
  const link = (await page.locator('.invite code').textContent())!.trim()
  return link
}

export async function joinVia(page: Page, link: string): Promise<void> {
  const hash = link.slice(link.indexOf('#'))
  await page.goto('/' + hash)
  await page.getByRole('button', { name: 'Join', exact: true }).click()
}

/** Drag a card onto a column with the mouse. */
export async function dragCardTo(page: Page, title: string, col: string): Promise<void> {
  const from = (await card(page, title).locator('.card-body').boundingBox())!
  const to = (await column(page, col).locator('ul.cards').boundingBox())!
  await page.mouse.move(from.x + 20, from.y + 12)
  await page.mouse.down()
  await page.mouse.move(from.x + 40, from.y + 12, { steps: 4 })
  await page.mouse.move(to.x + 30, to.y + to.height - 8, { steps: 15 })
  await page.mouse.up()
}
