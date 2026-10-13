import { expect, test } from '@playwright/test'
import { newPeer, onboard } from './helpers'

test('in Arabic the board flows right to left and cards still drag between columns', async ({ browser }) => {
  const { ctx, page } = await newPeer(browser)
  await onboard(page)
  await page.locator('select.lang-picker').selectOption('ar')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')

  await page.locator('.wordmark').click()
  await page.locator('#new-board-name').fill('خطة الإطلاق')
  await page.getByRole('button', { name: 'إنشاء' }).click()
  await expect(page.getByRole('heading', { name: 'خطة الإطلاق', level: 1 })).toBeVisible()

  const todo = page.locator('section.column', { has: page.getByRole('heading', { name: 'للإنجاز' }) })
  const doing = page.locator('section.column', { has: page.getByRole('heading', { name: 'قيد العمل' }) })
  // first column sits to the right of the second
  const a = (await todo.boundingBox())!
  const b = (await doing.boundingBox())!
  expect(a.x).toBeGreaterThan(b.x)

  await todo.getByRole('button', { name: 'أضف بطاقة' }).click()
  await todo.getByPlaceholder('ما الذي يجب إنجازه؟').fill('ترجمة الصفحة')
  await todo.getByPlaceholder('ما الذي يجب إنجازه؟').press('Enter')
  await todo.getByPlaceholder('ما الذي يجب إنجازه؟').press('Escape')

  const from = (await page.locator('[data-card]', { hasText: 'ترجمة الصفحة' }).locator('.card-body').boundingBox())!
  const to = (await doing.locator('ul.cards').boundingBox())!
  await page.mouse.move(from.x + from.width - 20, from.y + 12)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width - 40, from.y + 12, { steps: 4 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height - 6, { steps: 15 })
  await page.mouse.up()
  await expect(doing.getByText('ترجمة الصفحة')).toBeVisible()
  await expect(todo.getByText('ترجمة الصفحة')).toHaveCount(0)
  await ctx.close()
})
