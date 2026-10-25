import 'dotenv/config'
import { prisma } from '../db/prisma.js'
import { getCoordinates, toUnix } from '../utils.js'

async function main () {
  const events = await prisma.event.findMany({
    where: { unixTime: null },
    select: { id: true, title: true, date: true, time: true, location: true }
  })

  console.log(`Знайдено ${events.length} подій без unixTime`)

  let updated = 0
  let skipped = 0

  for (const event of events) {
    const unixTime = toUnix(event.date, event.time)

    if (unixTime == null) {
      skipped += 1
      console.warn(`⚠️ Не вдалось розпарсити дату: id=${event.id} date="${event.date}"`)
      continue
    }

    let coordinates = null
    if (event.location) {
      const coords = await getCoordinates(event.location)
      coordinates = coords ? `${coords.lat},${coords.lon}` : null
    }

    await prisma.event.update({
      where: { id: event.id },
      data: {
        unixTime,
        ...(coordinates ? { coordinates } : {})
      }
    })

    updated += 1
  }

  console.log(`✅ Оновлено: ${updated}, пропущено: ${skipped}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
