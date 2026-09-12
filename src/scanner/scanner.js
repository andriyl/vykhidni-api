import { PlaywrightCrawler, log } from 'crawlee'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export async function scanSites () {
  const sites = await prisma.siteConfig.findMany()
  let totalEvents = 0

  for (const site of sites) {
    if (!site.isActive) {
      log.info(`⏸️ Skipping inactive site: ${site.name}`)
      continue
    }
    log.info(`🔍 Scanning site: ${site.name} (${site.startUrl})`)
    const scannedUrls = await prisma.event
      .findMany({
        where: { siteConfigId: site.id },
        select: { url: true }
      })
      .then((events) => events.map((e) => e.url))
    console.log('scanned', scannedUrls)

    const config = site
    const newEvents = []

    const crawler = new PlaywrightCrawler({
      // maxConcurrency: 1,
      async requestHandler ({ page, request, enqueueLinks }) {
        const getAction = (type) => config.actions.find((a) => a.type === type)

        const paginationAction = getAction('paginate')
        const extractListAction = getAction('extractList')
        const extractDetailsAction = getAction('extractDetails')

        log.debug(`Visiting: ${request.url} [${request.label}]`)

        if (paginationAction && request.label !== 'DETAIL') {
          await enqueueLinks({
            selector: paginationAction.selector,
            transformRequestFunction: (req) => {
              // відсікаємо сторінки без "page=" або ті, що вже скановані
              if (!req.url.includes('page=') || scannedUrls.includes(req.url)) { return null }
              return req
            },
            label: 'PAGINATION'
          })
        }

        if (extractListAction && request.label !== 'DETAIL') {
          const links = await page.$$eval(extractListAction.selector, (els) =>
            els.map((el) => el.href).filter(Boolean)
          )

          log.info(`🔗 Found ${links.length} links on list page`)

          for (const url of links) {
            if (!scannedUrls.includes(url)) {
              await enqueueLinks({ urls: [url], label: 'DETAIL' })
            }
          }
        }

        if (extractDetailsAction && request.label === 'DETAIL') {
          const { title, date, time, location, description, image } =
            extractDetailsAction

          const event = {
            title: (await page.locator(title).textContent())?.trim() || '',
            date: (await page.locator(date).textContent())?.trim() || '',
            time: (await page.locator(time).textContent())?.trim() || '',
            location:
              (await page.locator(location).textContent())?.trim() || '',
            description:
              (await page.locator(description).innerText())?.trim() || '',
            image: (await page.locator(image).getAttribute('src')) || '',
            url: page.url()
          }

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

    log.info(`📦 ${site.name}: saved ${newEvents.length} events`)
    totalEvents += newEvents.length
  }

  log.success(`🎉 Done! Total new events: ${totalEvents}`)
  return totalEvents
}
