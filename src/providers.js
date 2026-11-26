import 'dotenv/config'

const DEFAULT_MODEL = 'gemini-3.5-flash-lite'
const FREE_LIMITS = { rpm: 10, tpm: 250000, rpd: 500 }

function makeGeminiProvider (id, key, model, name) {
  return {
    id,
    name,
    key,
    model,
    enabled: true,
    freeLimits: FREE_LIMITS,
    async generate (prompt, opts) {
      const { GoogleGenerativeAI } = await import('@google/generative-ai')
      const genAI = new GoogleGenerativeAI(key)
      const response = await genAI.getGenerativeModel({ model }).generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          ...(opts.generationConfig || {})
        }
      })
      const text = response.response.text()
      const usage = response.response.usageMetadata || null
      return { text, usage }
    }
  }
}

// Gemini-аккаунти: GEMINI_API_KEY — перший, GEMINI_API_KEY_2, GEMINI_API_KEY_3, ... — додаткові.
// Моделі: GEMINI_MODEL — за замовчуванням, GEMINI_MODEL_2, GEMINI_MODEL_3, ... — для додаткових акаунтів.
const geminiAccounts = []
for (let i = 0; ; i++) {
  const key = i === 0 ? process.env.GEMINI_API_KEY : process.env[`GEMINI_API_KEY_${i + 1}`]
  if (!key) break
  const id = i === 0 ? 'gemini' : `gemini-${i + 1}`
  const model = i === 0
    ? (process.env.GEMINI_MODEL || DEFAULT_MODEL)
    : (process.env[`GEMINI_MODEL_${i + 1}`] || process.env.GEMINI_MODEL || DEFAULT_MODEL)
  geminiAccounts.push(makeGeminiProvider(id, key, model, i === 0 ? 'Gemini' : `Gemini ${i + 1}`))
}

function isQuotaError (err) {
  const msg = (err?.message || String(err)).toLowerCase()
  const code = err?.code
  if (code === 3036 || code === 4006) return true
  return /429|quota|resource.?exhausted|rate.?limit|too.?many|high.?demand|used up your daily free allocation/i.test(msg)
}

export function listProviders () {
  return geminiAccounts.map((p) => ({
    id: p.id,
    name: p.name,
    model: p.model,
    enabled: p.enabled,
    hasKey: Boolean(p.key),
    freeLimits: p.freeLimits
  }))
}

export function setProviderEnabled (id, enabled) {
  const p = geminiAccounts.find((x) => x.id === id)
  if (!p) return null
  p.enabled = Boolean(enabled)
  return {
    id: p.id,
    name: p.name,
    model: p.model,
    enabled: p.enabled,
    hasKey: Boolean(p.key),
    freeLimits: p.freeLimits
  }
}

export async function callLLM (prompt, opts = {}) {
  const errors = []
  for (const provider of geminiAccounts) {
    if (!provider.enabled) continue
    try {
      const result = await provider.generate(prompt, opts)
      return { ...result, provider: provider.id }
    } catch (err) {
      errors.push({ provider: provider.id, message: err?.message })
      if (!isQuotaError(err)) {
        return { text: null, usage: null, provider: provider.id, error: err?.message }
      }
    }
  }
  return { text: null, usage: null, provider: null, error: errors.map((e) => `${e.provider}: ${e.message}`).join('; ') }
}
