import { expect, test, type Page } from '@playwright/test'
import { addCard, card, newPeer, onboard } from './helpers'

interface DevHandle {
  view(id: string): { cards: Map<string, { title: string }> } | null
  sync: { peersOf(id: string): Array<{ key: string }> }
}

const titlesOf = (page: Page, board: string) =>
  page.evaluate((id) => {
    const v = (window as unknown as { __lawha: DevHandle }).__lawha.view(id)
    return v ? [...v.cards.values()].map((c) => c.title) : []
  }, board)

const sessionsOf = (page: Page, board: string) =>
  page.evaluate((id) => (window as unknown as { __lawha: DevHandle }).__lawha.sync.peersOf(id).map((p) => p.key), board)

test('coworkers stay in sync on a board only one of them has open, and count as one peer', async ({ browser }) => {
  const alice = await newPeer(browser)
  const bob = await newPeer(browser)
  await onboard(alice.page)
  const bobKey = await onboard(bob.page)
  const a = alice.page
  const b = bob.page

  await a.getByRole('button', { name: 'New company workspace' }).click()
  await a.getByPlaceholder('Company name').fill('Acme')
  await a.getByPlaceholder('Company name').press('Enter')
  await expect(a.getByRole('heading', { name: 'Acme roster' })).toBeVisible()
  await a.getByPlaceholder('Paste a public key').fill(bobKey)
  await a.getByRole('button', { name: 'Add', exact: true }).click()
  const wsLink = (await a.locator('.invite code').textContent())!.trim()

  await a.getByRole('button', { name: 'New board' }).click()
  await a.getByPlaceholder('Board name').first().fill('Ops')
  await a.getByPlaceholder('Board name').first().press('Enter')
  await expect(a.getByRole('heading', { name: 'Ops', level: 1 })).toBeVisible()
  const ops = a.url().split('#/b/')[1]!
  await a.getByRole('button', { name: 'Members' }).click()
  await a.locator('.candidates button').first().click()
  await a.getByRole('button', { name: 'Add', exact: true }).click()
  const boardLink = (await a.locator('.invite code').textContent())!.trim()
  await a.getByRole('button', { name: 'Back to the board' }).click()

  await b.goto('/' + wsLink.slice(wsLink.indexOf('#')))
  await b.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(b.getByRole('heading', { name: 'Acme roster' })).toBeVisible()
  await b.goto('/' + boardLink.slice(boardLink.indexOf('#')))
  await b.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(b.getByRole('heading', { name: 'Ops', level: 1 })).toBeVisible()

  // Bob moves on: he leaves Ops' room, the company's stays
  await b.locator('.wordmark').click()
  await expect(b.getByRole('heading', { name: 'Ops', level: 1 })).toHaveCount(0)
  await addCard(a, 'To do', 'Written while Bob looks elsewhere')
  await expect.poll(() => titlesOf(b, ops)).toContain('Written while Bob looks elsewhere')
  // it came over the company connection, not from Ops' own room
  const keys = await sessionsOf(b, ops)
  expect(keys.length).toBeGreaterThan(0)
  expect(keys.every((k) => k.includes('>'))).toBe(true)

  // and back the other way, Bob editing from his side of the same connection
  await b.getByRole('button', { name: /Ops/ }).first().click()
  await expect(card(b, 'Written while Bob looks elsewhere')).toBeVisible()
  await addCard(b, 'To do', 'Bob was here')
  await expect(card(a, 'Bob was here')).toBeVisible()

  // one coworker is one peer, however many rooms and networks connect them
  await expect(a.locator('.peer-status summary')).toContainText('1 peer')
  await expect(b.locator('.peer-status summary')).toContainText('1 peer')
  await b.locator('.peer-status summary').click()
  await expect(b.getByText('Connected to 1 peer. Every board you share with them stays in sync.')).toBeVisible()
  await expect(b.locator('.net-relays li')).toHaveText([/MQTT\s*1\/1/])

  await alice.ctx.close()
  await bob.ctx.close()
})
