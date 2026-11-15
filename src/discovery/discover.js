import { chromium } from 'playwright'
import { MICRODATA_ITEM_SELECTOR, probeListing } from './probe.js'
import {
  extractDetail,
  extractItems,
  workingFields
} from '../scanner/extract.js'
import {
  proposeRecipe,
  pruneHtml,
  refineDetail,
  repairRecipe
} from './llm.js'
import {
  autoScroll,
  safeGoto,
  USER_AGENT
} from '../scanner/browser.js'
import { validateEvent, parseDateParts } from '../utils.js'

const MAX_LLM_CALLS = 3
const MIN_REPAIR_ITEMS = 3
const MIN_DETAIL_DESCRIPTION = 200
const DETAIL_FIELDS = ['title', 'date', 'location', 'image', 'description']

// A description that is missing, tiny or just repeats the title is not a
// usable event description even though the field is non-empty.
function weakDescription (event) {
  const text = (event?.description || '').trim()
  return (
    !text ||
    text.length < MIN_DETAIL_DESCRIPTION ||
    text === (event?.title || '').trim()
  )
}

const FIELD_LABELS = {
  title: 'назва',
  date: 'дата',
  time: 'час',
  location: 'місце',
  description: 'опис',
  image: 'картинка',
  price: 'ціна'
}

// A value that may be written to the site config: no markup, right shape.
function saneValue (field, value) {
  const text = (value || '').trim()
  if (!text) return false
  if (field === 'date') {
    return Boolean(parseDateParts(text)) || /\d{1,2}\s*[./-]\s*\d{1,2}/.test(text)
  }
  if (field === 'time') {
    return /^([01]\d|2[0-3])[:.]\d{2}$/.test(text) || /T\d{2}:\d{2}/.test(text)
  }
  if (field === 'title') {
    return text.length >= 3 && text.length <= 300 && /[a-zа-яіїєґ]/i.test(text)
  }
  if (field === 'image') return /^(https?:|data:|\/)/.test(text)
  if (field === 'description') {
    return (
      text.length >= 40 &&
      !/<(?:script|iframe|div|html|body|head|p|span|img)\b/i.test(text)
    )
  }
  return text.length > 1
}

export function normalizeStartUrl (value) {
  if (!value || typeof value !== 'string') {
    throw new Error('URL is required')
  }
  let url = value.trim()
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  const parsed = new URL(url)
  parsed.hash = ''
  return parsed.toString()
}

function choosePagination (candidates = []) {
  const url =
    candidates.find((entry) => entry?.kind === 'url' && entry.selector) ||
    candidates.find((entry) => entry?.kind === 'url')
  const loadMore =
    candidates.find((entry) => entry?.kind === 'loadMore' && entry.selector) ||
    candidates.find((entry) => entry?.kind === 'loadMore')
  return url || loadMore || null
}

function toPagination (candidate) {
  if (!candidate) return { mode: 'none' }
  if (candidate.kind === 'loadMore') {
    return {
      mode: 'loadMore',
      selector: candidate.selector || null,
      text: candidate.text || null
    }
  }
  return {
    mode: 'url',
    selector: candidate.selector || null,
    param: candidate.param || 'page'
  }
}

function fallbackRecipe (candidate, pagination) {
  return {
    item: candidate?.selector || null,
    link: ['a[href]'],
    fields: {},
    source: candidate?.selector === MICRODATA_ITEM_SELECTOR
      ? 'microdata'
      : 'fields',
    pagination
  }
}

function recipeFromDecision (decision, candidates, pagination) {
  if (!decision?.item) return null
  const allowed = new Set(candidates.map((candidate) => candidate.selector))
  if (!allowed.has(decision.item)) return null

  const chosenPagination =
    decision.pagination && decision.pagination.mode !== 'none'
      ? decision.pagination
      : pagination.selector
        ? pagination
        : { mode: 'none' }

  return {
    item: decision.item,
    link: decision.link || ['a[href]'],
    fields: decision.fields || {},
    source: decision.item === MICRODATA_ITEM_SELECTOR
      ? 'microdata'
      : 'fields',
    pagination: chosenPagination
  }
}

async function mergeRecipe (current, decision, page) {
  const next = { ...current }
  if (decision.item) {
    const count = await page
      .evaluate((selector) => {
        try {
          return document.querySelectorAll(selector).length
        } catch {
          return 0
        }
      }, decision.item)
      .catch(() => 0)
    if (count >= 3 || decision.item === MICRODATA_ITEM_SELECTOR) {
      next.item = decision.item
    }
  }
  if (decision.link) next.link = decision.link
  if (decision.fields) next.fields = { ...(current.fields || {}), ...decision.fields }
  if (decision.pagination) next.pagination = decision.pagination
  next.source = next.item === MICRODATA_ITEM_SELECTOR ? 'microdata' : 'fields'
  return next
}

function candidateReport (candidate) {
  if (!candidate) return null
  const { selector, count, linkRatio, imageRatio, dateRatio, avgText, score } =
    candidate
  return { selector, count, linkRatio, imageRatio, dateRatio, avgText, score }
}

function buildActions ({
  pagination,
  item,
  link,
  fields,
  source,
  detail,
  seedUrls
}) {
  const actions = []
  if (pagination?.mode === 'url') {
    actions.push({
      type: 'paginate',
      mode: 'url',
      selector: pagination.selector || null,
      param: pagination.param || 'page',
      maxPages: 5
    })
  } else if (pagination?.mode === 'loadMore') {
    actions.push({
      type: 'paginate',
      mode: 'loadMore',
      selector: pagination.selector || null,
      text: pagination.text || null,
      maxPages: 10
    })
  }

  actions.push({
    type: 'extractListItems',
    item,
    link: link || ['a[href]'],
    fields: fields || {},
    source: source === 'microdata' ? 'microdata' : 'fields'
  })
  actions.push({
    type: 'extractDetails',
    url: detail?.url || null,
    source: 'auto',
    fields: detail?.fields || {}
  })
  if (seedUrls?.length) actions.push({ type: 'seedUrls', urls: seedUrls })
  return actions
}

async function detailSnippet (page) {
  try {
    return await page.evaluate(() => {
      // The first container that is likely the event itself; body is last.
      const root =
        document.querySelector('article') ||
        document.querySelector('main') ||
        document.querySelector('[role="main"]') ||
        document.querySelector('[class*="event-page"]') ||
        document.querySelector('[class*="event-detail"]') ||
        document.querySelector('[class*="single-page"]') ||
        document.body
      return root ? root.innerHTML : ''
    })
  } catch {
    return ''
  }
}

export async function discoverSite (
  rawUrl,
  { log = () => {}, useLLM = true } = {}
) {
  const startUrl = normalizeStartUrl(rawUrl)
  const startedAt = new Date()
  const warnings = []
  let llmCalls = 0
  let llmTokens = 0

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 1000 },
    locale: 'uk-UA'
  })

  try {
    log(`🌐 Відкриваємо ${startUrl}`)
    const page = await context.newPage()
    await safeGoto(page, startUrl)
    await autoScroll(page)

    log('🔍 Аналізуємо структуру сторінки...')
    const probe = await probeListing(page)
    const candidates = (probe.candidates || []).slice(0, 3)
    const defaultPagination = toPagination(
      choosePagination(probe.pagination)
    )

    let recipe = null
    let sourceType = 'heuristic'

    // Fast path: microdata listing. No LLM needed when the data is complete.
    if (probe.structured?.microdataEvents >= 3) {
      const microdataRecipe = {
        item: MICRODATA_ITEM_SELECTOR,
        link: ['[itemprop="url"]', 'a[href]'],
        fields: {},
        source: 'microdata',
        pagination: defaultPagination
      }
      const sample = await extractItems(page, microdataRecipe)
      if (sample.length >= MIN_REPAIR_ITEMS) {
        recipe = microdataRecipe
        sourceType = 'microdata'
        log(`✅ Знайдено microdata-картки: ${sample.length}`)
      }
    }

    // LLM path, or a deterministic fallback when LLM is disabled.
    if (!recipe) {
      if (!candidates.length) {
        throw new Error(
          'Не вдалося знайти список подій на сторінці (немає повторюваних карток)'
        )
      }

      if (!useLLM) {
        recipe = fallbackRecipe(candidates[0], defaultPagination)
        warnings.push(
          'LLM вимкнено — використано першого кандидата та загальні селектори'
        )
      } else {
        log('🤖 Підбираємо селектори через Gemini...')
        const { data, usage } = await proposeRecipe({
          url: startUrl,
          title: probe.title,
          candidates: candidates.map((candidate) => ({
            selector: candidate.selector,
            count: candidate.count,
            html: pruneHtml(candidate.html, 1800)
          })),
          pagination: probe.pagination || [],
          structured: probe.structured
        })
        llmCalls += 1
        llmTokens += usage?.totalTokenCount || 0

        recipe = recipeFromDecision(data, candidates, defaultPagination)
        if (recipe) {
          sourceType =
            recipe.item === MICRODATA_ITEM_SELECTOR ? 'microdata' : 'llm'
        }
        if (!recipe) {
          warnings.push(
            'LLM не повернув валідний рецепт — використано евристичний fallback'
          )
          recipe = fallbackRecipe(candidates[0], defaultPagination)
        }
      }
    }

    let preview = await extractItems(page, recipe)
    log(`📦 Знайдено подій: ${preview.length}`)

    // One repair call when extraction yields too few cards. Acceptance is
    // based only on the number of extracted events, not on field quality.
    const chosen =
      candidates.find((candidate) => candidate.selector === recipe.item) ||
      candidates[0]
    let repairAttempts = 0
    while (useLLM && repairAttempts < MAX_LLM_CALLS) {
      const tooFew =
        preview.length === 0 ||
        (chosen?.count >= MIN_REPAIR_ITEMS && preview.length < MIN_REPAIR_ITEMS)
      const sampleEvent = preview[0] ? { ...preview[0] } : null
      const sampleValidation = sampleEvent ? validateEvent(sampleEvent) : null
      const shouldRepair = tooFew || (sampleValidation && !sampleValidation.valid)

      if (!shouldRepair) break

      repairAttempts += 1
      const failures = []
      if (sampleValidation && !sampleValidation.valid) {
        const normalized = sampleValidation.normalized
        if (!normalized.title) failures.push('title')
        if (!normalized.url) failures.push('url')
        if (!parseDateParts(normalized.date)) failures.push('date')
        if (normalized.time && !/^([01]\d|2[0-3])[:.][0-5]\d$/.test(normalized.time)) {
          failures.push('time')
        }
        if (normalized.description && normalized.description.length > 500) failures.push('description')
      }

      log(
        `🤖 Уточнюємо селектори списку (${
          (failures.length ? failures : ['item']).join(', ')
        })...`
      )
      const { data, usage } = await repairRecipe({
        cardHtml: pruneHtml(chosen?.html || '', 2200),
        sample: preview.slice(0, 3),
        failures: failures.length ? failures : ['item', 'title', 'date'],
        current: {
          item: recipe.item,
          link: recipe.link,
          fields: recipe.fields
        }
      })
      llmCalls += 1
      llmTokens += usage?.totalTokenCount || 0

      if (data) {
        const repaired = await mergeRecipe(recipe, data, page)
        const repairedPreview = await extractItems(page, repaired)
        const improved = repairedPreview.length > preview.length
        if (improved) {
          recipe = repaired
          preview = repairedPreview
          if (repaired.item !== MICRODATA_ITEM_SELECTOR) sourceType = 'llm'
        }
      }
    }

    if (!preview.length) warnings.push('Не знайдено жодної події')

    // Detail page: generic + structured data first, LLM only as a fallback.
    const detailUrl = preview.find((event) => event.url)?.url || null
    const detail = {
      url: detailUrl,
      source: 'auto',
      fields: {},
      structured: null,
      event: null
    }

    if (detailUrl) {
      log(`📄 Аналізуємо сторінку події: ${detailUrl}`)
      const detailPage = await context.newPage()
      try {
        await safeGoto(detailPage, detailUrl)
        const first = await extractDetail(
          detailPage,
          { source: 'auto', fields: {} },
          { withMeta: true }
        )
        detail.structured = first.structured
        let detailEvent = first.event
        // A value of the wrong shape (a date as the title, page chrome as the
        // time) counts as missing, so the AI is asked to replace it.
        const missingFields = () =>
          DETAIL_FIELDS.filter((field) => !saneValue(field, detailEvent?.[field]))
        let missing = missingFields()
        let rejected = {}
        let attempts = 0

        // The listing card already holds a good value for a field: asking the
        // AI for it again costs a request and can only make it worse.
        const listingValue = (field) => preview[0]?.[field]
        const askable = (field) =>
          field === 'description' || !saneValue(field, listingValue(field))

        // Two AI attempts at most: the first one usually fixes the page, the
        // second gets the selectors that matched nothing as feedback.
        while (useLLM && attempts < 2 && llmCalls < MAX_LLM_CALLS) {
          const refineFields = (
            weakDescription(detailEvent) && !missing.includes('description')
              ? [...missing, 'description']
              : missing
          ).filter(askable)
          if (!refineFields.length) break

          log(
            `🤖 Запит в AI за деталями: ${refineFields
              .map((field) => FIELD_LABELS[field] || field)
              .join(', ')}`
          )
          const { data, usage } = await refineDetail({
            detailHtml: pruneHtml(await detailSnippet(detailPage), 6000),
            currentFields: detail.fields,
            missingFields: refineFields,
            rejectedFields: rejected
          })
          llmCalls += 1
          llmTokens += usage?.totalTokenCount || 0
          attempts += 1
          if (!data?.fields) break

          rejected = {}
          const verified = await workingFields(detailPage, data.fields)
          // Only selectors for the fields we asked about are merged: the model
          // likes to add extras (an organizer as the location) on its own.
          const asked = {}
          for (const field of refineFields) {
            if (verified[field]) asked[field] = verified[field]
          }
          if (!Object.keys(asked).length) continue

          for (const [field, chain] of Object.entries(data.fields)) {
            const ok = new Set(asked[field] || [])
            const failed = chain.filter((selector) => !ok.has(selector))
            if (failed.length) rejected[field] = failed
          }

          const merged = { ...detail.fields, ...asked }
          const refined = await extractDetail(detailPage, {
            source: 'auto',
            fields: merged
          })
          // Drop selectors that match an element but return a wrong value.
          for (const field of Object.keys(asked)) {
            if (!saneValue(field, refined[field])) delete merged[field]
          }
          detail.fields = merged
          // Only the requested fields are replaced, and only with sane values:
          // a guessed selector must never overwrite data that is already good.
          const before = JSON.stringify(detailEvent)
          for (const field of refineFields) {
            if (saneValue(field, refined[field])) detailEvent[field] = refined[field]
          }
          missing = missingFields()
          // Nothing changed, so another identical request would not help.
          if (JSON.stringify(detailEvent) === before) break
        }

        // Never report a value that the preview would reject anyway.
        for (const field of DETAIL_FIELDS) {
          if (!saneValue(field, detailEvent?.[field])) delete detailEvent[field]
        }
        missing = missingFields()

        // Only warn about fields that the listing card does not provide either.
        const stillMissing = missing.filter(
          (field) => !saneValue(field, listingValue(field))
        )
        if (stillMissing.length) {
          log(
            `⚠️ Не знайдено: ${stillMissing
              .map((field) => FIELD_LABELS[field] || field)
              .join(', ')}`
          )
        }

        detail.event = detailEvent
      } catch (error) {
        warnings.push(
          `Не вдалося проаналізувати сторінку події: ${error.message}`
        )
      } finally {
        await detailPage.close().catch(() => {})
      }
    }

    const previewEvent = preview[0] ? { ...preview[0] } : null
    if (previewEvent && detail.event) {
      // The listing card is authoritative for date/time/place/price: a detail
      // page may show related events first. Title and description come from
      // the detail page, which is the event itself.
      if (saneValue('title', detail.event.title)) previewEvent.title = detail.event.title
      if (saneValue('description', detail.event.description)) {
        previewEvent.description = detail.event.description
      }
      for (const key of ['date', 'time', 'location', 'image', 'price']) {
        if (!previewEvent[key] && saneValue(key, detail.event[key])) {
          previewEvent[key] = detail.event[key]
        }
      }
      // A listing date without a year ("26/11") is worse than the full one.
      if (
        saneValue('date', detail.event.date) &&
        !/\d{4}/.test(previewEvent.date || '') &&
        /\d{4}/.test(detail.event.date || '')
      ) {
        previewEvent.date = detail.event.date
      }
    }

    const pagination = recipe.pagination || { mode: 'none' }
    const actions = buildActions({
      pagination,
      item: recipe.item,
      link: recipe.link,
      fields: recipe.fields,
      source: recipe.source,
      detail,
      seedUrls: probe.seedUrls
    })

    const finishedAt = new Date()
    const chosenCandidate =
      (probe.candidates || []).find(
        (candidate) => candidate.selector === recipe.item
      ) || null

    log(`✅ Дискавері завершено: ${preview.length} подій`)

    const report = {
      status: 'done',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - startedAt,
      url: startUrl,
      finalUrl: page.url(),
      pageTitle: probe.title,
      sourceType,
      itemSelector: recipe.item,
      total: preview.length,
      structured: probe.structured,
      candidates: (probe.candidates || [])
        .slice(0, 5)
        .map(candidateReport),
      chosenCandidate: candidateReport(chosenCandidate),
      pagination,
      detail: {
        url: detail.url,
        source: detail.source,
        fields: detail.fields,
        structured: detail.structured
      },
      preview: previewEvent,
      warnings: [...new Set(warnings)],
      llmCalls,
      llmTokens
    }

    return {
      name: '',
      startUrl,
      actions,
      sourceType,
      report
    }
  } finally {
    await browser.close().catch(() => {})
  }
}
