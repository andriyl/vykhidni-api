import 'dotenv/config'

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

export function parseDateParts (dateStr) {
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

  match = dateStr.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/)
  if (match) {
    const month = +match[2]
    if (month >= 1 && month <= 12) {
      const year = match[3]
        ? +match[3] < 100
          ? +match[3] + 2000
          : +match[3]
        : new Date().getFullYear()
      return { day: +match[1], month, year }
    }
  }

  return null
}

export function parseTimeParts (timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return { hours: 0, minutes: 0 }

  const match = timeStr.match(/(\d{1,2})[:.](\d{2})/)
  if (!match) return { hours: 0, minutes: 0 }
  return { hours: +match[1], minutes: +match[2] }
}

export function toUnix (dateStr, timeStr) {
  const parts = parseDateParts(dateStr)
  if (!parts) return null

  const { hours, minutes } = parseTimeParts(
    timeStr && timeStr.trim() ? timeStr : dateStr
  )

  const jsDate = new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    hours,
    minutes
  )

  const ms = jsDate.getTime()
  if (Number.isNaN(ms)) return null
  return Math.floor(ms / 1000)
}

const EVENT_TIME_ZONE = 'Europe/Kiev'

// Уніфікована дата для зберігання/відображення: "14 січня 2026".
export function formatEventDate (unixTime) {
  if (unixTime == null) return ''
  const date = new Date(Number(unixTime) * 1000)
  if (Number.isNaN(date.getTime())) return ''
  const text = new Intl.DateTimeFormat('uk-UA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: EVENT_TIME_ZONE
  }).format(date)
  return String(text).replace(/\s*р\.?\s*$/u, '').trim()
}

export const MAX_DESCRIPTION = 500

export function validateEvent (raw = {}) {
  const title = typeof raw?.title === 'string' ? raw.title.trim() : ''
  const date = typeof raw?.date === 'string' ? raw.date.trim() : ''
  const time = typeof raw?.time === 'string' ? raw.time.trim() : ''
  const location = typeof raw?.location === 'string' ? raw.location.trim() : ''
  const description = typeof raw?.description === 'string' ? raw.description.trim() : ''
  const image = typeof raw?.image === 'string' ? raw.image.trim() : ''
  const url = typeof raw?.url === 'string' ? raw.url.trim() : ''

  const valid =
    title.length > 0 &&
    title.length <= 300 &&
    url.length > 0 &&
    Boolean(parseDateParts(date)) &&
    (time === '' || /^([01]\d|2[0-3])[:.][0-5]\d$/.test(time)) &&
    description.length <= MAX_DESCRIPTION

  const normalized = { title, date, time, location, description, image, url }
  return { valid, normalized }
}

const coordinatesCache = new Map()

const LVIV_BBOX = '23.4,49.7,24.3,50.0'

// Nominatim allows one request per second per IP.
const GEOCODE_DELAY_MS = 1100
let lastGeocodeAt = 0

function normalizeAddress (address) {
  const parts = address
    .split(/[|;]/)[0]
    .replace(/\([^)]*\)/g, '')
    .replace(/(?:(?:м\.|смт\.?)?\s*Льв[іiї]в[:\s,]*)+/i, '')
    .replace(/вул\./gi, 'вулиця')
    .replace(/(?:просп|пр)\./gi, 'проспект')
    .replace(/пл\./gi, 'площа')
    .replace(/смт\.?/gi, '')
    .replace(/(^|,\s*)м\.\s*/gi, '$1')
    .replace(/,\s*\d+\s*поверх\S*/gi, '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

  // Listings often repeat the whole address twice.
  return parts
    .filter(
      (part, i) =>
        parts.findIndex((p) => p.toLowerCase() === part.toLowerCase()) === i
    )
    .join(', ')
}

async function geocodeNominatim (query) {
  const wait = lastGeocodeAt + GEOCODE_DELAY_MS - Date.now()
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  lastGeocodeAt = Date.now()

  const response = await fetch(
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ua' +
      `&viewbox=${LVIV_BBOX}&bounded=1&q=${encodeURIComponent(query)}`,
    {
      headers: { 'User-Agent': 'ChildrenEvents/1.0' },
      signal: AbortSignal.timeout(10000)
    }
  )
  if (!response.ok) throw new Error(`Nominatim responded ${response.status}`)
  const [hit] = await response.json()
  const lat = Number(hit?.lat)
  const lon = Number(hit?.lon)
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null
}

async function geocodeGoogle (query) {
  const key = process.env.GOOGLE_MAPS_API_KEY
  // The value in .env is a placeholder until a real key is added.
  if (!key || key.length < 20) return null

  const response = await fetch(
    'https://maps.googleapis.com/maps/api/geocode/json' +
      `?address=${encodeURIComponent(query)}&language=uk&region=ua&key=${key}`,
    { signal: AbortSignal.timeout(10000) }
  )
  if (!response.ok) throw new Error(`Google responded ${response.status}`)
  const data = await response.json()
  const location = data?.results?.[0]?.geometry?.location
  return Number.isFinite(location?.lat) && Number.isFinite(location?.lng)
    ? { lat: location.lat, lon: location.lng }
    : null
}

export async function getCoordinates (address) {
  if (!address) return null
  const key = address.trim().toLowerCase()
  if (coordinatesCache.has(key)) return coordinatesCache.get(key)

  // Query the first address only; multi-address strings ("A | B; C") never
  // match. Nominatim is bounded to Lviv, otherwise a bare street name can
  // resolve to another city. Odd strings (malls, venues) fall through to
  // Google when a key is configured.
  const primary = normalizeAddress(address) || address
  const attempts = [
    [geocodeNominatim, primary],
    [
      geocodeGoogle,
      /Льв[іiї]в/i.test(primary) ? primary : `${primary}, Львів`
    ]
  ]

  for (const [geocode, query] of attempts) {
    try {
      const coords = await geocode(query)
      if (coords) {
        coordinatesCache.set(key, coords)
        return coords
      }
    } catch (error) {
      console.error('Geocoding error:', error.message)
    }
  }
  return null
}
