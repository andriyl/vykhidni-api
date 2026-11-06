import { model } from '../gemini.js'
import { broadcastLog, getCoordinates, toUnix } from '../utils.js'
import { prisma } from '../db/prisma.js'

const DESCRIPTION_LIMIT = 500
const CATEGORIES = new Set([
  'музика',
  'мистецтво',
  'спорт',
  'театр',
  'конференція',
  'фестиваль',
  'освіта',
  'майстерклас',
  'книги',
  'інша'
])

// Gemini може повернути будь-які поля (id, createdAt, siteConfigId тощо).
// У БД пишемо лише явний білий список.
const AI_FIELDS = [
  'title',
  'date',
  'time',
  'location',
  'description',
  'image',
  'category',
  'isForKids'
]

let validationRunning = false

function cleanText (value, max = 500) {
  if (value === undefined || value === null) return ''
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max)
}

function toBoolean (value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'так'].includes(normalized)) return true
    if (['false', '0', 'no', 'ні'].includes(normalized)) return false
  }
  return Boolean(value)
}

function buildUpdate (parsed, event) {
  const data = {
    status: 'APPROVED_BY_AI',
    aiProcessed: true
  }

  for (const field of AI_FIELDS) {
    if (parsed[field] === undefined) continue

    if (field === 'isForKids') {
      data.isForKids = toBoolean(parsed[field])
      continue
    }

    if (field === 'description') {
      data.description = cleanText(parsed.description, DESCRIPTION_LIMIT)
      continue
    }

    if (field === 'category') {
      const category = cleanText(parsed.category, 40).toLowerCase()
      data.category = CATEGORIES.has(category) ? category : 'інша'
      continue
    }

    if (field === 'title') {
      const title = cleanText(parsed.title, 300)
      data.title = title || event.title
      continue
    }

    if (field === 'image') {
      const image = cleanText(parsed.image, 2000)
      data.image = /^https?:\/\//i.test(image) ? image : event.image
      continue
    }

    data[field] = cleanText(parsed[field], 500)
  }

  const date = data.date !== undefined ? data.date : event.date
  const time = data.time !== undefined ? data.time : event.time
  const location = data.location !== undefined
    ? data.location
    : event.location

  data.unixTime = toUnix(date, time) ?? null

  return { data, location }
}

export default async function aiFunctionsRoutes (fastify) {
  fastify.post('/validate-by-ai', async (request, reply) => {
    if (validationRunning) {
      return reply.code(409).send({ error: 'AI-валідація вже виконується' })
    }

    validationRunning = true
    broadcastLog('🤖 Починаємо валідацію через AI...')

    try {
      const events = await prisma.event.findMany({
        where: { status: 'DRAFT' }
      })

      if (!events.length) {
        return { message: 'Немає подій для валідації' }
      }

      const results = []

      for (const ev of events) {
        try {
          const prompt = `
        Ти — AI, який нормалізує та класифікує дані подій.
        Приведи значення до правильного формату:
        - title: коротка назва події (текст)
        - date: у форматі YYYY-MM-DD
        - time: у форматі HH:mm або порожнє
        - location: чітке місце проведення
        - description: максимум 500 символів, без тегів
        - image: URL або порожнє
        - category: вибери одну з типових категорій (музика, мистецтво, спорт, театр, конференція, фестиваль, освіта, майстерклас, книги, інша)
        - isForKids: true якщо подія орієнтована на дітей (казки, мультфільми, сімейні заходи, цирк, дитячі майстер-класи, тощо), інакше false.

        Вхідні дані (JSON):
        ${JSON.stringify(ev, null, 2)}

        Відповідай ТІЛЬКИ валідним JSON без коментарів.
        `

          const aiResponse = await model.generateContent(prompt)
          const text = aiResponse.response.text()
          const cleaned = text.replace(/```json|```/g, '').trim()

          let parsed
          try {
            parsed = JSON.parse(cleaned)
          } catch {
            console.warn('⚠️ AI повернув невалідний JSON:', text)
            broadcastLog(`⚠️ AI повернув невалідний JSON для події ${ev.id}`)
            continue
          }

          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            console.warn('⚠️ AI повернув не обʼєкт JSON для події:', ev.id)
            continue
          }

          const { data, location } = buildUpdate(parsed, ev)

          if (location !== ev.location || !ev.coordinates) {
            const coords = await getCoordinates(location)
            data.coordinates = coords
              ? `${coords.lat},${coords.lon}`
              : (location === ev.location ? ev.coordinates : null)
          }

          const updated = await prisma.event.update({
            where: { id: ev.id },
            data
          })

          console.log(`✅ Оновлено подію: ${updated.title}`)
          broadcastLog(`✅ Оновлено подію: ${updated.title}`)
          results.push(updated)

          await new Promise(resolve => setTimeout(resolve, 2000))
        } catch (innerErr) {
          console.error('❌ Помилка при обробці події:', ev.id, innerErr.message)
          broadcastLog(`❌ Помилка при обробці події ${ev.id}: ${innerErr.message}`)

          try {
            await prisma.event.update({
              where: { id: ev.id },
              data: { aiProcessed: false }
            })
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 5000))
        }
      }

      broadcastLog(
        `🏁 Валідацію завершено: успішно ${results.length} з ${events.length}`
      )

      return {
        message: `Оброблено ${results.length} подій`,
        updated: results
      }
    } catch (err) {
      console.error('🔥 Глобальна помилка:', err)
      broadcastLog(`🔥 Глобальна помилка: ${err.message}`)
      return reply
        .code(500)
        .send({ error: 'Помилка при валідації подій' })
    } finally {
      validationRunning = false
    }
  })
}
