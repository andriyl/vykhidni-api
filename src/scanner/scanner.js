import { PlaywrightCrawler, RequestQueue, log } from 'crawlee'
import { prisma } from '../db/prisma.js'
import { broadcastLog, getCoordinates, toUnix } from '../utils.js'
import { clickLoadMore, USER_AGENT } from './browser.js'
import { extractDetail, extractItems, getAction, normalizeActions } from './extract.js'
import { classifyEventsForKids } from '../discovery/llm.js'

const activeScanState = {
  running: false,
  stopped: false,
  reason: null,
  siteId: null,
  startedAt: null,
  crawlers: [],
  queues: []
}

export function getScanState () {
  return {
    running: activeScanState.running,
    stopped: activeScanState.stopped,
    reason: activeScanState.reason,
    siteId: activeScanState.siteId,
    startedAt: activeScanState.startedAt
  }
}

export async function stopScan (reason = 'manual') {
  if (!activeScanState.running) {
    return { stopped: false, message: 'Сканування не запущено' }
  }
  activeScanState.stopped = true
  activeScanState.reason = reason
  broadcastLog('⛔ Зупинка сканування за запитом з адмінки...')

  for (const crawler of activeScanState.crawlers) {
    try {
      if (typeof crawler.stop === 'function') {
        await crawler.stop()
      }
    } catch {}
  }
  for (const queue of activeScanState.queues) {
    try {
      if (typeof queue.drop === 'function') {
        await queue.drop()
      }
    } catch {}
  }
  return { stopped: true }
}

const DEFAULT_MAX_PAGES = 5
const DEFAULT_HYDRATE_LIMIT = 100

function pageNumber (url, param = 'page') {
  const escaped = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = url.match(new RegExp(`[?&]${escaped}=(\\d+)`))
  return match ? Number(match[1]) : 0
}

async function hydrateEvent (page, event, detailAction) {
  if (!detailAction || !event.url) return true

  const detailPage = await page.context().newPage()
  try {
    await detailPage.goto(event.url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    await detailPage.waitForTimeout(1500)
    const detail = await extractDetail(detailPage, detailAction)

    for (const key of ['title', 'date', 'time', 'location', 'description', 'image']) {
      if (!event[key] && detail[key]) event[key] = detail[key]
      if (
        (key === 'description' || key === 'location') &&
        detail[key] &&
        detail[key].length > (event[key] || '').length
      ) {
        event[key] = detail[key]
      }
    }
    return true
  } catch (error) {
    log.warning(`Detail hydration failed for ${event.url}: ${error.message}`)
    return false
  } finally {
    await detailPage.close().catch(() => {})
  }
}

async function saveEvent (site, event, stats, seenUrls) {
  if (!event?.url) return false
  if (seenUrls.has(event.url)) {
    stats.skipped += 1
    return false
  }

  // Не перезаписуємо та не доповнюємо івенти, що вже затверджені
  const existing = await prisma.event
    .findUnique({
      where: { url: event.url },
      select: { id: true, status: true }
    })
    .catch(() => null)
  if (
    existing &&
    existing.status === 'APPROVED'
  ) {
    seenUrls.add(event.url)
    stats.skipped += 1
    return false
  }

  try {
    if (existing) {
      // Якщо івент вже існує, але не затверджений - не оновлюємо, лише рахуємо
      seenUrls.add(event.url)
      stats.skipped += 1
      return false
    }

    const coords = await getCoordinates(event.location)

    await prisma.event.create({
      data: {
        title: event.title || event.url,
        date: event.date || null,
        time: event.time || null,
        location: event.location || null,
        description: event.description || null,
        image: event.image || null,
        url: event.url,
        siteConfigId: site.id,
        unixTime: toUnix(event.date, event.time) || null,
        coordinates: coords ? `${coords.lat},${coords.lon}` : null
      }
    })
    seenUrls.add(event.url)
    log.info(`✅ Saved: ${event.title || event.url}`)
    return true
  } catch (error) {
    if (error.code === 'P2002') {
      seenUrls.add(event.url)
      stats.skipped += 1
      log.warning(`⚠️ Already exists: ${event.url}`)
    } else {
      log.error(`❌ Error saving event: ${error.message}`)
    }
    return false
  }
}

/**
 * Сканер сайтів за конфігами SiteConfig.
 * Підтримує лише поточний формат:
 * extractListItems + paginate (url/loadMore) + seedUrls + extractDetails.
 */
export async function scanSites ({ siteId } = {}) {
  if (activeScanState.running) {
    throw new Error('Сканування вже запущено')
  }

  let numericSiteId = null
  if (siteId !== undefined && siteId !== null && siteId !== '') {
    numericSiteId = Number(siteId)
    if (!Number.isInteger(numericSiteId) || numericSiteId <= 0) {
      throw new Error('Некоректний siteId')
    }
  }

  activeScanState.running = true
  activeScanState.stopped = false
  activeScanState.reason = null
  activeScanState.siteId = numericSiteId
  activeScanState.startedAt = new Date().toISOString()
  activeScanState.crawlers = []
  activeScanState.queues = []

  let totalEvents = 0

  try {
    const sites = await prisma.siteConfig.findMany({
      where: numericSiteId
        ? { id: numericSiteId, deletedAt: null }
        : { deletedAt: null }
    })

    for (const site of sites) {
      if (activeScanState.stopped) {
        broadcastLog('⛔ Сканування зупинено')
        break
      }
      if (site.status !== 'ACTIVE') {
        log.info(`⏸️ Skipping inactive site: ${site.name}`)
        broadcastLog(`⏸️ Пропускаємо неактивний сайт: ${site.name}`)
        continue
      }

      const actions = normalizeActions(site.actions)
      const paginationAction = getAction(actions, 'paginate')
      const listItemsAction = getAction(actions, 'extractListItems')
      const extractDetailsAction = getAction(actions, 'extractDetails')
      const seedUrlsAction = getAction(actions, 'seedUrls')

      if (!listItemsAction) {
        log.warning(`⏭️ Skipping site without extractListItems: ${site.name}`)
        broadcastLog(
          `⏭️ Пропускаємо сайт без extractListItems: ${site.name}`
        )
        continue
      }

      log.info(`🔍 Scanning site: ${site.name} (${site.startUrl})`)
      broadcastLog(`🔍 Скануємо сайт: ${site.name}`)

      const stats = { skipped: 0 }

      const existingUrls = await prisma.event
        .findMany({
          where: { siteConfigId: site.id },
          select: { url: true }
        })
        .then((events) => events.map((event) => event.url))
      const seenUrls = new Set(existingUrls)
      const newEvents = []

      let hydrateBudget = DEFAULT_HYDRATE_LIMIT
      let hydrateFailures = 0

      const queueName = `site-${site.id}-${Date.now()}`
      const requestQueue = await RequestQueue.open(queueName)

      const saveFromList = async (page) => {
        const events = await extractItems(page, listItemsAction)

        for (const event of events) {
          if (seenUrls.has(event.url)) {
            stats.skipped += 1
            continue
          }
          // Stop hydrating after repeated failures: a slow site otherwise eats
          // the request handler timeout and its pagination pages never load.
          if (hydrateBudget > 0 && hydrateFailures < 3) {
            const hydrated = await hydrateEvent(page, event, extractDetailsAction)
            hydrateBudget -= 1
            if (!hydrated) hydrateFailures += 1
          }
          if (await saveEvent(site, event, stats, seenUrls)) {
            newEvents.push(event)
          }
        }
      }

      try {
        if (activeScanState.stopped) break
        const crawler = new PlaywrightCrawler({
          requestQueue,
          maxConcurrency: 3,
          maxRequestRetries: 1,
          navigationTimeoutSecs: 30,
          requestHandlerTimeoutSecs: 120,
          launchContext: {
            userAgent: USER_AGENT
          },
          async requestHandler ({ page, request, enqueueLinks }) {
            if (activeScanState.stopped) {
              throw new Error('SCAN_STOPPED')
            }
            log.debug(`🧭 Visited ${request.url}`)

            // Let JS-heavy listings render before extracting.
            await page.waitForTimeout(2500)

            if (paginationAction?.mode === 'loadMore') {
              const clicks = await clickLoadMore(
                page,
                paginationAction,
                Number(paginationAction.maxPages) || 10
              )
              if (clicks) {
                log.info(`➕ Loaded more: ${clicks} click(s)`)
              }
            } else if (paginationAction) {
              try {
                const maxPages =
                  Number(paginationAction.maxPages) || DEFAULT_MAX_PAGES
                const param = paginationAction.param || 'page'

                if (paginationAction.selector) {
                  const depth = Number(request.userData?.pageDepth || 0)
                  await enqueueLinks({
                    selector: paginationAction.selector,
                    transformRequestFunction: (req) => {
                      if (seenUrls.has(req.url)) return null
                      if (depth + 1 > maxPages) return null
                      if (pageNumber(req.url, param) > maxPages) return null
                      req.userData = {
                        ...(req.userData || {}),
                        pageDepth: depth + 1
                      }
                      return req
                    },
                    label: 'PAGINATION'
                  })
                } else {
                  const escaped = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                  const links = await page.$$eval(
                    'a[href]',
                    (elements, pattern) => {
                      const re = new RegExp(pattern)
                      return elements
                        .map((el) => el.href)
                        .filter((href) => re.test(href))
                    },
                    `[?&]${escaped}=\\d+`
                  )
                  const depth = Number(request.userData?.pageDepth || 0)
                  if (depth + 1 <= maxPages) {
                    for (const link of links) {
                      if (pageNumber(link, param) > maxPages) continue
                      await enqueueLinks({ urls: [link], label: 'PAGINATION' })
                    }
                  }
                }
              } catch (error) {
                log.warning(
                  `Pagination failed on ${request.url}: ${error.message}`
                )
              }
            }

            await saveFromList(page)
          }
        })

        const urls = [site.startUrl]
        if (Array.isArray(seedUrlsAction?.urls)) {
          for (const seed of seedUrlsAction.urls) {
            try {
              urls.push(new URL(seed, site.startUrl).toString())
            } catch {}
          }
        }

        activeScanState.crawlers.push(crawler)
        activeScanState.queues.push(requestQueue)
        try {
          await crawler.run([...new Set(urls)])
        } catch (error) {
          if (
            error?.message === 'SCAN_STOPPED' ||
            activeScanState.stopped
          ) {
            log.info('Сканування зупинено')
          } else {
            throw error
          }
        }
      } finally {
        await requestQueue.drop().catch(() => {})
      }

      // Класифікація: чи події для дітей (один запит на весь батч)
      try {
        const toClassify = await prisma.event.findMany({
          where: { siteConfigId: site.id, status: 'DRAFT', aiProcessed: false },
          select: { url: true, title: true, date: true, location: true, description: true }
        })
        if (toClassify.length) {
          const results = await classifyEventsForKids(toClassify)
          if (Array.isArray(results) && results.length === toClassify.length) {
            let rejected = 0
            for (let i = 0; i < toClassify.length; i += 1) {
              const isKid = results[i]
              await prisma.event.updateMany({
                where: { url: toClassify[i].url },
                data: {
                  isForKids: isKid,
                  aiProcessed: true,
                  ...(isKid ? {} : { status: 'REJECTED' })
                }
              })
              if (!isKid) rejected += 1
            }
            if (rejected) {
              log.info(`🚫 ${site.name}: відхилено ${rejected} не-дитячих подій`)
              broadcastLog(
                `🚫 ${site.name}: відхилено ${rejected} не-дитячих подій`
              )
            }
          } else {
            log.warning(
              `⚠️ ${site.name}: класифікація не вдалася, залишено DRAFT`
            )
          }
        }
      } catch (error) {
        log.warning(`⚠️ ${site.name}: помилка класифікації: ${error.message}`)
      }

      log.info(`📦 ${site.name}: saved ${newEvents.length} events`)
      broadcastLog(
        `📦 ${site.name}: нових подій ${newEvents.length}` +
          (stats.skipped ? `, пропущено ${stats.skipped}` : '')
      )
      totalEvents += newEvents.length
    }
  } finally {
    activeScanState.running = false
    activeScanState.crawlers = []
    activeScanState.queues = []
  }

  if (activeScanState.stopped) {
    broadcastLog('⛔ Сканування зупинено користувачем')
    return totalEvents
  }

  log.info(`🎉 Done! Total new events: ${totalEvents}`)
  broadcastLog(`🎉 Всього нових подій: ${totalEvents}`)
  return totalEvents
}
