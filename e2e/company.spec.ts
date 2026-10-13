import { expect, test } from '@playwright/test'
import { addCard, card, newPeer, onboard } from './helpers'

test('company boards are reachable only by coworkers on the roster', async ({ browser }) => {
  const alice = await newPeer(browser)
  const bob = await newPeer(browser)
  await onboard(alice.page)
  const bobKey = await onboard(bob.page)

  // Alice founds Acme and puts Bob on the roster
  await alice.page.getByRole('button', { name: 'New company workspace' }).click()
  await alice.page.getByPlaceholder('Company name').fill('Acme')
  await alice.page.getByPlaceholder('Company name').press('Enter')
  await expect(alice.page.getByRole('heading', { name: 'Acme roster' })).toBeVisible()
  await alice.page.getByPlaceholder('Paste a public key').fill(bobKey)
  await alice.page.getByRole('button', { name: 'Add', exact: true }).click()
  const wsLink = (await alice.page.locator('.invite code').textContent())!.trim()

  // a company board; Bob is picked from the roster
  await alice.page.getByRole('button', { name: 'New board' }).click()
  await alice.page.getByPlaceholder('Board name').first().fill('Ops')
  await alice.page.getByPlaceholder('Board name').first().press('Enter')
  await expect(alice.page.getByRole('heading', { name: 'Ops', level: 1 })).toBeVisible()
  await addCard(alice.page, 'To do', 'Company secret')
  await alice.page.getByRole('button', { name: 'Members' }).click()
  await alice.page.locator('.candidates button').first().click()
  await alice.page.getByRole('button', { name: 'Add', exact: true }).click()
  const boardLink = (await alice.page.locator('.invite code').textContent())!.trim()
  expect(boardLink).toContain('/join/b/')
  await alice.page.getByRole('button', { name: 'Back to the board' }).click()

  // Bob joins the company, then the board
  await bob.page.goto('/' + wsLink.slice(wsLink.indexOf('#')))
  await bob.page.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(bob.page.getByRole('heading', { name: 'Acme roster' })).toBeVisible()
  await bob.page.goto('/' + boardLink.slice(boardLink.indexOf('#')))
  await bob.page.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(card(bob.page, 'Company secret')).toBeVisible()

  // an outsider with the board link never finds the room
  const carol = await newPeer(browser)
  await onboard(carol.page)
  await carol.page.goto('/' + boardLink.slice(boardLink.indexOf('#')))
  await carol.page.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(carol.page.getByText('This board belongs to a company workspace you are not on yet.')).toBeVisible()
  await carol.page.waitForTimeout(3000)
  await expect(card(carol.page, 'Company secret')).toHaveCount(0)

  for (const p of [alice, bob, carol]) await p.ctx.close()
})
