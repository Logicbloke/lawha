import { expect, test, type Browser, type Page } from '@playwright/test'
import { addCard, addMember, card, createBoard, joinVia, onboard } from './helpers'

/** Stands in for the browser's Notification: records what would show, permission starts unasked. */
function fakeNotifications() {
  const shown: Array<{ title: string; body?: string; onclick: (() => void) | null }> = []
  class FakeNotification {
    static permission: NotificationPermission = 'default'
    static requestPermission(): Promise<NotificationPermission> {
      FakeNotification.permission = 'granted'
      return Promise.resolve('granted')
    }
    title: string
    body?: string
    onclick: (() => void) | null = null
    constructor(title: string, opts?: NotificationOptions) {
      this.title = title
      this.body = opts?.body
      shown.push(this)
    }
    close() {}
  }
  Object.assign(window, { Notification: FakeNotification, __shown: shown })
}

async function newPeer(browser: Browser) {
  const ctx = await browser.newContext()
  await ctx.addInitScript(fakeNotifications)
  const page = await ctx.newPage()
  await page.goto('/')
  return { ctx, page }
}

const shown = (p: Page) =>
  p.evaluate(() => (window as unknown as { __shown: Array<{ title: string; body?: string }> }).__shown.map((n) => `${n.title}: ${n.body}`))

test('notifications are chosen per board, for a column and for mentions, and open the card', async ({ browser }) => {
  const alice = await newPeer(browser)
  const bob = await newPeer(browser)
  const aliceKey = await onboard(alice.page)
  const bobKey = await onboard(bob.page)
  const a = alice.page
  const b = bob.page
  const [aliceName, bobName] = [aliceKey.slice(0, 8), bobKey.slice(0, 8)]

  await createBoard(a, 'Launch')
  await addCard(a, 'To do', 'Write the announcement')
  const link = await addMember(a, bobKey, 'Editor')
  await a.getByRole('button', { name: 'Back to the board' }).click()
  await joinVia(b, link)
  await expect(card(b, 'Write the announcement')).toBeVisible()

  // Bob allows notifications and adds the Doing column to what this board tells him about
  await b.getByLabel('Board options').click()
  await b.getByRole('button', { name: 'Notifications' }).click()
  const panel = b.getByRole('dialog', { name: 'Notifications' })
  await panel.getByRole('button', { name: 'Allow notifications' }).click()
  await expect(panel.getByRole('button', { name: 'Allow notifications' })).toHaveCount(0)
  await expect(panel.getByRole('checkbox', { name: 'Comments that mention me' })).toBeChecked()
  await expect(panel.getByRole('checkbox', { name: 'Every change on this board' })).not.toBeChecked()
  await panel.getByRole('checkbox', { name: 'Doing' }).check()
  await panel.getByRole('button', { name: 'Done' }).click()
  // kept on his device only
  expect(await b.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('lawha:notify:')).length)).toBe(1)

  // with the board off his screen, only what he chose shows
  await b.locator('.wordmark').click()
  await addCard(a, 'To do', 'Not for Bob')
  await addCard(a, 'Doing', 'Book the venue')
  await expect.poll(() => shown(b)).toEqual([`Launch: ${aliceName} added “Book the venue” to Doing`])

  // Alice mentions him: @ offers the members, filtered by what follows
  await card(a, 'Write the announcement').locator('.card-body').click()
  const box = a.getByPlaceholder('Write a comment')
  await box.click()
  await box.pressSequentially(`Draft is ready @${bobName.slice(0, 3)}`)
  const list = a.getByRole('listbox', { name: 'Mention someone' })
  await expect(list.getByRole('option')).toHaveCount(1)
  await expect(list.getByRole('option')).toContainText(bobName)
  await box.press('Enter')
  await expect(list).toHaveCount(0)
  await expect(box).toHaveValue(`Draft is ready @${bobName} `)
  await box.pressSequentially('please review')
  await a.getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(a.locator('.comment-text .mention')).toHaveText(`@${bobName}`)

  await expect
    .poll(() => shown(b))
    .toContain(`Launch: ${aliceName} mentioned you on “Write the announcement”: Draft is ready @${bobName} please review`)

  // clicking it opens that card
  await b.evaluate(() => (window as unknown as { __shown: Array<{ onclick: (() => void) | null }> }).__shown.at(-1)!.onclick!())
  const detail = b.getByRole('dialog', { name: 'Write the announcement' })
  await expect(detail).toBeVisible()
  await expect(detail.locator('.mention.me')).toHaveText(`@${bobName}`)

  await alice.ctx.close()
  await bob.ctx.close()
})
