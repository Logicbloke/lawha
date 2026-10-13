import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

/**
 * Renders the app icon (three kanban columns, one card mid-move) to the PNG
 * sizes PWA installs need. Run once when the icon changes:
 *   bun scripts/gen-icons.ts
 * Outputs are committed in public/icons/.
 */

// palette from src/ui/styles.css
const BG = '#15171c'
const COLUMN = '#232731'
const CARD = '#4a5263'
const ACCENT = '#f0b429'

// [x, y, w, h] of the resting cards inside each column
const CARDS = [
  [16, 25, 16, 9],
  [16, 37, 16, 9],
  [16, 49, 16, 9],
  [42, 25, 16, 9],
  [68, 25, 16, 9],
  [68, 37, 16, 9],
] as const

function iconSvg(size: number, opts: { maskable?: boolean; square?: boolean } = {}): string {
  const scale = opts.maskable ? 0.66 : 0.86
  const bg =
    opts.square || opts.maskable
      ? `<rect width="100" height="100" fill="${BG}"/>`
      : `<rect width="100" height="100" rx="22" fill="${BG}"/>`
  const columns = [13, 39, 65]
    .map((x) => `<rect x="${x}" y="18" width="22" height="64" rx="4" fill="${COLUMN}"/>`)
    .join('')
  const cards = CARDS.map(
    ([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${CARD}"/>`,
  ).join('')
  // the card being dragged: tilted, lifted, accent-coloured
  const moving = `<rect x="40" y="45" width="20" height="11" rx="2.5" fill="${ACCENT}" transform="rotate(-8 50 50.5)"/>`
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">` +
    bg +
    `<g transform="translate(50 50) scale(${scale}) translate(-50 -50)">` +
    columns +
    cards +
    moving +
    `</g></svg>`
  )
}

mkdirSync('public/icons', { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage()

const outputs: Array<[string, number, Parameters<typeof iconSvg>[1]]> = [
  ['public/icons/icon-192.png', 192, {}],
  ['public/icons/icon-512.png', 512, {}],
  ['public/icons/maskable-512.png', 512, { maskable: true }],
  ['public/icons/apple-touch-icon.png', 180, { square: true }],
]

for (const [path, size, opts] of outputs) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<!doctype html><body style="margin:0">${iconSvg(size, opts)}</body>`)
  await page.locator('svg').screenshot({ path, omitBackground: true })
  console.log('wrote', path)
}

await browser.close()
