import { chromium } from 'playwright'
import {
  extractDetail,
  extractItems,
  extractJsonLd,
  extractMicrodata
} from '../scanner/extract.js'
import {
  refineDetail,
  proposeListRecipe,
  pruneHtml
} from './llm.js'
import {
  autoScroll,
  safeGoto,
  USER_AGENT
} from '../scanner/browser.js'

const DETAIL_FIELDS = ['title', 'date', 'time', 'location', 'image', 'description']

const SANE_CHECKS = {
  date: text => /\d/.test(text),
  time: text => /^([01]\d|2[0-3])[:.]\d{2}$/.test(text) || /T\d{2}:\d{2}/.test(text),
  title: text => text.length >= 3 && text.length <= 300,
  image: text => /^(https?:|data:|\/)/.test(text),
  description: text => text.length >= 20
}
const defaultSaneCheck = text => text.length > 1

function saneValue (field, value) {
  const text = (value || '').trim()
  if (!text) return false
  return (SANE_CHECKS[field] ?? defaultSaneCheck)(text)
}

export function normalizeStartUrl (value) {
  if (!value || typeof value !== 'string') throw new Error('URL is required')
  let url = value.trim()
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  const parsed = new URL(url)
  parsed.hash = ''
  return parsed.toString()
}

function buildActions ({ pagination, item, link, fields, source, detail, seedUrls }) {
  const actions = []
  if (pagination?.mode === 'url') {
    actions.push({ type: 'paginate', mode: 'url', selector: pagination.selector || null, param: pagination.param || 'page', maxPages: 5 })
  } else if (pagination?.mode === 'loadMore') {
    actions.push({ type: 'paginate', mode: 'loadMore', selector: pagination.selector || null, text: pagination.text || null, maxPages: 10 })
  }
  actions.push({ type: 'extractListItems', item, link: link || ['a[href]'], fields: fields || {}, source: source === 'microdata' ? 'microdata' : 'fields' })
  actions.push({ type: 'extractDetails', url: detail?.url || null, source: 'auto', fields: detail?.fields || {} })
  if (seedUrls?.length) actions.push({ type: 'seedUrls', urls: seedUrls })
  return actions
}

async function detailSnippet (page) {
  try {
    return await page.evaluate(() => {
      const root = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role="main"]') || document.body
      return root ? root.innerHTML : ''
    })
  } catch { return '' }
}

export async function discoverSite (rawUrl, { log = () => {}, useLLM = true } = {}) {
  const startUrl = normalizeStartUrl(rawUrl)
  const startedAt = new Date()
  const warnings = []
  let llmCalls = 0
  let llmTokens = 0

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1440, height: 1000 }, locale: 'uk-UA' })

  try {
    log(`🌐 Відкриваємо ${startUrl}`)
    const page = await context.newPage()
    await safeGoto(page, startUrl)
    await autoScroll(page)

    log('🔍 Отримуємо HTML сторінки...')
    const jsonLd = await extractJsonLd(page)
    const microdata = jsonLd ? null : await extractMicrodata(page)

    const rawHtml = await page.evaluate(() => {
      const root = document.querySelector('.catalog') || document.querySelector('[class*="catalog"]') || document.querySelector('main') || document.body
      const clone = root.cloneNode(true)
      clone.querySelectorAll('header, nav, footer, .preloader, .mobile-menu, script, style, svg, iframe, noscript').forEach((el) => el.remove())
      return clone.innerHTML
    })
    const fullHtml = pruneHtml(rawHtml, 25000)

    log('🤖 Запит до LLM за селекторами списку подій...')
    let listData = null
    let listUsage = null
    const rejectedSelectors = []
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await proposeListRecipe({ html: fullHtml, structured: jsonLd || microdata || {}, rejected: rejectedSelectors })
      listData = result.data
      listUsage = result.usage
      llmCalls += 1
      llmTokens += listUsage?.totalTokenCount || 0
      if (!listData?.item) break
      const count = await page.evaluate((sel) => { try { return document.querySelectorAll(sel).length } catch { return 0 } }, listData.item)
      if (count > 0) break
      rejectedSelectors.push(listData.item)
    }

    if (!listData?.item) throw new Error('LLM не повернув валідний рецепт списку подій')

    const recipe = {
      item: listData.item,
      link: listData.link || ['a[href]'],
      fields: listData.fields || {},
      source: 'fields',
      pagination: listData.pagination || { mode: 'none' }
    }

    const preview = await extractItems(page, recipe)
    log(`📦 Знайдено подій: ${preview.length}`)
    if (!preview.length) warnings.push('Не знайдено жодної події')

    const detailUrl = (preview || []).map((e) => e?.url).filter(Boolean)[0] || null
    const detail = { url: detailUrl, source: 'auto', fields: {}, structured: null, event: null }

    if (detailUrl) {
      log(`📄 Аналізуємо сторінку події: ${detailUrl}`)
      const detailPage = await context.newPage()
      try {
        await safeGoto(detailPage, detailUrl)
        const first = await extractDetail(detailPage, { source: 'auto', fields: {} }, { withMeta: true })
        detail.structured = first.structured
        const detailEvent = first.event

        const refineFields = DETAIL_FIELDS

        if (useLLM) {
          log(`🤖 Запит в AI за деталями: ${refineFields.join(', ')}`)
          const rawDetailHtml = await detailSnippet(detailPage)
          const fullDetailHtml = pruneHtml(rawDetailHtml, 25000)
          const { data, usage } = await refineDetail({
            detailHtml: fullDetailHtml,
            currentFields: detail.fields,
            missingFields: refineFields,
            rejectedFields: {}
          })
          llmCalls += 1
          llmTokens += usage?.totalTokenCount || 0
          if (data?.fields) {
            detail.fields = { ...detail.fields, ...data.fields }
            const refined = await extractDetail(detailPage, { source: 'auto', fields: detail.fields })
            for (const field of refineFields) {
              if (saneValue(field, refined[field])) detailEvent[field] = refined[field]
            }
            for (const field of Object.keys(detail.fields)) {
              if (!saneValue(field, refined[field])) delete detail.fields[field]
            }
          }
        }

        for (const field of DETAIL_FIELDS) {
          if (!saneValue(field, detailEvent?.[field])) delete detailEvent[field]
        }

        detail.event = detailEvent
      } catch (error) {
        warnings.push(`Не вдалося проаналізувати сторінку події: ${error.message}`)
      } finally {
        await detailPage.close().catch(() => {})
      }
    }

    const previewEvent = preview[0] ? { ...preview[0] } : null
    if (previewEvent && detail.event) {
      if (saneValue('title', detail.event.title)) previewEvent.title = detail.event.title
      if (saneValue('description', detail.event.description)) previewEvent.description = detail.event.description
      for (const key of ['date', 'time', 'location', 'image']) {
        if (!previewEvent[key] && saneValue(key, detail.event[key])) previewEvent[key] = detail.event[key]
      }
      if (saneValue('date', detail.event.date) && !/\d{4}/.test(previewEvent.date || '') && /\d{4}/.test(detail.event.date || '')) {
        previewEvent.date = detail.event.date
      }
    }

    const pagination = recipe.pagination || { mode: 'none' }
    const actions = buildActions({ pagination, item: recipe.item, link: recipe.link, fields: recipe.fields, source: recipe.source, detail, seedUrls: [] })

    const finishedAt = new Date()
    const report = {
      status: 'done',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - startedAt,
      url: startUrl,
      finalUrl: page.url(),
      pageTitle: await page.title(),
      sourceType: 'llm',
      itemSelector: recipe.item,
      total: preview.length,
      structured: jsonLd || microdata,
      pagination,
      detail: { url: detail.url, source: detail.source, fields: detail.fields, structured: detail.structured },
      preview: previewEvent,
      warnings: [...new Set(warnings)],
      llmCalls,
      llmTokens
    }

    return { name: '', startUrl, actions, sourceType: 'llm', report }
  } finally {
    await browser.close().catch(() => {})
  }
}
