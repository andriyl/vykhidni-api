import { PlaywrightCrawler, RequestQueue, log } from 'crawlee'
import { prisma } from '../db/prisma.js'
import { broadcastLog } from '../utils.js'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

// Адмінка зберігає extractDetails вкладеним ({ type, fields: {...} }),
// старі конфіги в БД — плоскі. Підтримуємо обидва формати.
function normalizeAction (action) {
  if (!action || action.type !== 'extractDetails') return action
  const { fields, ...rest } = action
  return { ...rest, ...(fields || {}) }
}

function normalizeActions (actions) {
  if (!Array.isArray(actions)) return []
  return actions.map(normalizeAction)
}

function getAction (actions, type) {
  return actions.find((a) => a.type === type)
}

const DEFAULT_MAX_PAGES = 5

function pageNumber (url) {
  const match = url.match(/[?&]page=(\d+)/)
  return match ? Number(match[1]) : 0
}

async function textOf (page, selector) {
  if (!selector) return ''
  try {
    const value = await page.locator(selector).first().textContent({ timeout: 5000 })
    return value?.trim() || ''
  } catch {
    return ''
  }
}

async function imageOf (page, selector) {
  if (!selector) return ''
  try {
    const locator = page.locator(selector).first()
    await locator.waitFor({ state: 'attached', timeout: 5000 })
    for (const attr of ['src', 'data-src', 'data-bg']) {
      const value = await locator.getAttribute(attr)
      if (value) return value.trim()
    }
    return ''
  } catch {
    return ''
  }
}

async function extractEvent (page, config) {
  return {
    title: await textOf(page, config.title),
    date: await textOf(page, config.date),
    time: await textOf(page, config.time),
    location: await textOf(page, config.location),
    description: await textOf(page, config.description),
    image: await imageOf(page, config.image),
    url: page.url()
  }
}

export async function scanSites ({ siteId } = {}) {
  const sites = await prisma.siteConfig.findMany({
    where: siteId ? { id: Number(siteId) } : undefined
  })
  let totalEvents = 0

  for (const site of sites) {
    if (!site.isActive) {
      log.info(`⏸️ Skipping inactive site: ${site.name}`)
      broadcastLog(`⏸️ Пропускаємо неактивний сайт: ${site.name}`)
      continue
    }

    const actions = normalizeActions(site.actions)
    const paginationAction = getAction(actions, 'paginate')
    const extractListAction = getAction(actions, 'extractList')
    const extractDetailsConfig = getAction(actions, 'extractDetails')

    log.info(`🔍 Scanning site: ${site.name} (${site.startUrl})`)
    broadcastLog(`🔍 Скануємо сайт: ${site.name}`)

    const scannedUrls = await prisma.event
      .findMany({
        where: { siteConfigId: site.id },
        select: { url: true }
      })
      .then((events) => events.map((e) => e.url))

    const newEvents = []

    // Окрема черга на кожен сайт. Скидаємо її, щоб необроблені запити
    // з обірваного попереднього скану не потрапили в новий запуск.
    const queueName = `site-${site.id}`
    await (await RequestQueue.open(queueName)).drop().catch(() => {})
    const requestQueue = await RequestQueue.open(queueName)

    try {
      const crawler = new PlaywrightCrawler({
        requestQueue,
        maxConcurrency: 3,
        maxRequestRetries: 1,
        navigationTimeoutSecs: 30,
        requestHandlerTimeoutSecs: 60,
        launchContext: {
          userAgent: USER_AGENT
        },
        async requestHandler ({ page, request, enqueueLinks }) {
          log.debug(`🧭 Visited [${request.label || 'LIST'}] ${request.url}`)

          if (paginationAction && request.label !== 'DETAIL') {
            try {
              const maxPages =
                Number(paginationAction.maxPages) || DEFAULT_MAX_PAGES

              await enqueueLinks({
                selector: paginationAction.selector,
                transformRequestFunction: (req) => {
                  if (scannedUrls.includes(req.url)) return null
                  if (!req.url.includes('page=')) return null
                  if (pageNumber(req.url) >= maxPages) return null
                  return req
                },
                label: 'PAGINATION'
              })
            } catch (err) {
              log.warning(`Pagination failed on ${request.url}: ${err.message}`)
            }
          }

          if (extractListAction && request.label !== 'DETAIL') {
            try {
              const links = await page.$$eval(extractListAction.selector, (els) =>
                els.map((el) => el.getAttribute('href') || el.href).filter(Boolean)
              )

              log.info(`🔗 Found ${links.length} links on list page`)

              for (const url of links) {
                if (!scannedUrls.includes(url)) {
                  await enqueueLinks({ urls: [url], label: 'DETAIL' })
                }
              }
            } catch (err) {
              log.warning(`List extraction failed on ${request.url}: ${err.message}`)
            }
          }

          if (extractDetailsConfig && request.label === 'DETAIL') {
            const event = await extractEvent(page, extractDetailsConfig)
            log.debug(`📄 Extracted event: ${event.title}`)

            try {
              await prisma.event.create({
                data: { ...event, siteConfigId: site.id }
              })
              newEvents.push(event)
              log.info(`✅ Saved: ${event.title}`)
            } catch (err) {
              if (err.code === 'P2002') {
                log.warning(`⚠️ Already exists: ${event.url}`)
              } else {
                log.error(`❌ Error saving event: ${err.message}`)
              }
            }
          }
        }
      })

      await crawler.run([site.startUrl])
    } finally {
      await requestQueue.drop().catch(() => {})
    }

    log.info(`📦 ${site.name}: saved ${newEvents.length} events`)
    broadcastLog(`📦 ${site.name}: нових подій ${newEvents.length}`)
    totalEvents += newEvents.length
  }

  log.info(`🎉 Done! Total new events: ${totalEvents}`)
  broadcastLog(`🎉 Всього нових подій: ${totalEvents}`)
  return totalEvents
}
