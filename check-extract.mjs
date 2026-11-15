// Self-check for description assembly in src/scanner/extract.js.
// Run: node check-extract.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { extractDetail, extractItems, sameEventTitle } from './src/scanner/extract.js'

const html = `<!doctype html><html><body>
<nav>МЕНЮ</nav>
<div class="card">
  <a href="/event/1"><h2>Вистава</h2></a>
  <span class="date">20.11.2026</span>
  <div class="wrap">
    <p class="lead">Основний текст події.</p>
    <p class="details">Тривалість: 60 хв. Вік: 3+.</p>
    <p class="price">Ціна: 200 грн.</p>
  </div>
  <div class="shell">
    <p class="lead2">Основний текст події.</p>
    <p class="chrome">Поширити</p>
  </div>
</div>
<footer>ФУТЕР</footer>
</body></html>`

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.setContent(html)

const [joined] = await extractItems(page, {
  item: '.card',
  fields: { description: ['.lead', '.details', '.price'] }
}, { validate: false })
assert.equal(
  joined.description,
  'Основний текст події.\n\nТривалість: 60 хв. Вік: 3+.\n\nЦіна: 200 грн.'
)

// Text inside another selected block is not duplicated.
const [deduped] = await extractItems(page, {
  item: '.card',
  fields: { description: ['.wrap', '.lead'] }
}, { validate: false })
assert.equal(deduped.description, 'Основний текст події. Тривалість: 60 хв. Вік: 3+. Ціна: 200 грн.')

// A wrapper that adds page chrome around the same block: keep the inner block.
const [inner] = await extractItems(page, {
  item: '.card',
  fields: { description: ['.shell', '.lead2'] }
}, { validate: false })
assert.equal(inner.description, 'Основний текст події.')

// Detail page: joined recipe selectors, no page chrome.
const detail = await extractDetail(page, {
  fields: { description: ['.lead', '.details'] }
})
assert.equal(detail.description, 'Основний текст події.\n\nТривалість: 60 хв. Вік: 3+.')
assert.doesNotMatch(detail.description, /МЕНЮ|ФУТЕР/)

// Listing rows are validated (<=500 chars): fall back to the first block
// instead of dropping the event.
await page.setContent(
  html.replace('Тривалість: 60 хв. Вік: 3+.', 'Довгий текст. '.repeat(50))
)
const [long] = await extractItems(page, {
  item: '.card',
  fields: { description: ['.lead', '.details'] }
})
assert.equal(long.description, 'Основний текст події.')

await browser.close()

// A related-event block on the page must not be mistaken for the page's event.
assert.equal(
  sameEventTitle('Гостина у Святого Миколая', 'Ідеї подарунків на свята для дітей | LEOLAND'),
  false
)
assert.equal(
  sameEventTitle('Вистава «Снігова королева»', 'Вистава Снігова королева у Mega Park | Діти в місті'),
  true
)

console.log('OK: description selectors joined, deduped, capped')
