import 'dotenv/config'
import { Client } from '@googlemaps/google-maps-services-js'

const googleClient = new Client({})
let logClients = []

export function broadcastLog (message) {
  const payload = JSON.stringify({
    message,
    time: new Date().toISOString()
  })

  logClients.forEach((client) => {
    try {
      client.socket.send(payload)
    } catch (err) {
      console.error('Failed to send log:', err)
    }
  })
}

export function addLogClient (connection) {
  if (!connection || !connection.socket) {
    console.error('⚠️ Tried to add invalid WebSocket connection')
    return
  }

  const socket = connection.socket
  logClients.push({ socket })

  socket.on('close', () => {
    logClients = logClients.filter((c) => c.socket !== socket)
  })
}

const UA_MONTHS = {
  січня: 1,
  лютого: 2,
  березня: 3,
  квітня: 4,
  травня: 5,
  червня: 6,
  липня: 7,
  серпня: 8,
  вересня: 9,
  жовтня: 10,
  листопада: 11,
  грудня: 12
}

function parseDateParts (dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null

  let match = dateStr.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/)
  if (match) {
    return { year: +match[1], month: +match[2], day: +match[3] }
  }

  match = dateStr.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/)
  if (match) {
    let year = +match[3]
    if (year < 100) year += 2000
    return { day: +match[1], month: +match[2], year }
  }

  match = dateStr.match(/(\d{1,2})\s+([а-яіїєґА-ЯІЇЄҐ]+)\.?\s*(\d{4})?/u)
  if (match) {
    const month = UA_MONTHS[match[2].toLowerCase()]
    if (month) {
      return {
        day: +match[1],
        month,
        year: match[3] ? +match[3] : new Date().getFullYear()
      }
    }
  }

  // "29.10", "29/10" без року. Для афіш це майже завжди поточний рік.
  match = dateStr.match(/(?:^|[^\d])(\d{1,2})[./-](\d{1,2})(?![\d./-])/)
  if (match) {
    const day = +match[1]
    const month = +match[2]
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { day, month, year: new Date().getFullYear() }
    }
  }

  return null
}

function parseTimeParts (timeStr, allowDot = true) {
  if (!timeStr || typeof timeStr !== 'string') return { hours: 0, minutes: 0 }

  const match = allowDot
    ? timeStr.match(/(\d{1,2})[:.](\d{2})/)
    : timeStr.match(/(?:^|[T\s])(\d{1,2}):(\d{2})(?::\d{2})?/)

  if (!match) return { hours: 0, minutes: 0 }

  const hours = +match[1]
  const minutes = +match[2]
  if (hours > 23 || minutes > 59) return { hours: 0, minutes: 0 }

  return { hours, minutes }
}

export function toUnix (dateStr, timeStr) {
  const parts = parseDateParts(dateStr)
  if (!parts) return null

  // Час беремо з окремого поля. Якщо його немає — з dateStr, але лише
  // коли там справжній час ("2025-10-29T18:00"), а не "29.10".
  const hasTimeField = Boolean(timeStr && timeStr.trim())
  const hasTimeInDate = /\d{1,2}:\d{2}/.test(dateStr)
  const { hours, minutes } = hasTimeField
    ? parseTimeParts(timeStr, true)
    : hasTimeInDate
      ? parseTimeParts(dateStr, false)
      : { hours: 0, minutes: 0 }

  const jsDate = new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    hours,
    minutes
  )

  // Захист від "31.02", яке JS тихо переносить на березень.
  if (
    jsDate.getFullYear() !== parts.year ||
    jsDate.getMonth() !== parts.month - 1 ||
    jsDate.getDate() !== parts.day
  ) {
    return null
  }

  const ms = jsDate.getTime()
  if (Number.isNaN(ms)) return null
  return Math.floor(ms / 1000)
}

export async function getCoordinates (address) {
  if (!address || !process.env.GOOGLE_MAPS_API_KEY) return null

  try {
    const response = await googleClient.geocode({
      params: {
        address,
        key: process.env.GOOGLE_MAPS_API_KEY,
        region: 'ua' // Обмежуємо регіон Україною
      },
      timeout: 5000
    })

    const data = response.data

    if (data.status === 'OK' && data.results.length > 0) {
      const { lat, lng } = data.results[0].geometry.location
      return { lat: parseFloat(lat), lon: parseFloat(lng) }
    }
    return null
  } catch (error) {
    console.error('Помилка:', error.message)
    return null
  }
}
