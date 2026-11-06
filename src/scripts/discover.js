#!/usr/bin/env node
import 'dotenv/config'
import { discoverSite, normalizeStartUrl } from '../discovery/discover.js'

const USAGE = `Використання:
  node src/scripts/discover.js <url> [опції]

Опції:
  --name <назва>       Назва сайту для збереження в БД
  --no-llm             Не використовувати Gemini
  --save               Зберегти конфіг у БД (статус REVIEW)
  --activate           Зберегти й одразу активувати сайт
  --max-items <n>      Скільки карток аналізувати (за замовчуванням 20)
  -h, --help           Показати цю довідку`

function parseArgs (argv) {
  const options = {
    url: null,
    name: null,
    useLLM: true,
    save: false,
    activate: false,
    maxItems: 20
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '-h' || arg === '--help') {
      options.help = true
    } else if (arg === '--no-llm') {
      options.useLLM = false
    } else if (arg === '--save') {
      options.save = true
    } else if (arg === '--activate') {
      options.activate = true
      options.save = true
    } else if (arg === '--name') {
      options.name = argv[i + 1]
      i += 1
    } else if (arg.startsWith('--name=')) {
      options.name = arg.slice('--name='.length)
    } else if (arg === '--max-items') {
      options.maxItems = Number.parseInt(argv[i + 1], 10)
      i += 1
    } else if (arg.startsWith('--max-items=')) {
      options.maxItems = Number.parseInt(arg.slice('--max-items='.length), 10)
    } else if (arg.startsWith('-')) {
      throw new Error(`Невідома опція: ${arg}`)
    } else if (!options.url) {
      options.url = arg
    } else {
      throw new Error(`Зайвий аргумент: ${arg}`)
    }
  }

  if (!options.help && !options.url) {
    throw new Error('URL обов’язковий')
  }
  if (!Number.isInteger(options.maxItems) || options.maxItems < 1) {
    throw new Error('--max-items має бути додатним числом')
  }
  if (options.name !== null) {
    options.name = String(options.name).trim()
    if (!options.name) throw new Error('--name не може бути порожнім')
  }

  return options
}

function log (message) {
  const time = new Date().toISOString().slice(11, 19)
  console.log(`[${time}] ${message}`)
}

async function saveResult (result, options) {
  const { prisma } = await import('../db/prisma.js')

  try {
    const status = options.activate ? 'ACTIVE' : 'REVIEW'
    const isActive = options.activate

    const existing = await prisma.siteConfig.findUnique({
      where: { startUrl: result.startUrl }
    })

    const config = await prisma.siteConfig.upsert({
      where: { startUrl: result.startUrl },
      create: {
        name: options.name || result.name || result.startUrl,
        startUrl: result.startUrl,
        actions: result.actions,
        status,
        isActive,
        sourceType: result.sourceType,
        confidence: result.confidence,
        discoveryReport: result.report,
        lastValidatedAt: new Date()
      },
      update: {
        ...(options.name ? { name: options.name } : {}),
        actions: result.actions,
        status,
        isActive,
        sourceType: result.sourceType,
        confidence: result.confidence,
        discoveryReport: result.report,
        lastValidatedAt: new Date()
      }
    })

    await prisma.siteConfigVersion
      .create({
        data: {
          siteConfigId: config.id,
          actions: result.actions,
          sourceType: result.sourceType,
          note: 'CLI discovery'
        }
      })
      .catch((error) => log(`⚠️ Не вдалося зберегти версію: ${error.message}`))

    log(
      `${existing ? '🔄 Оновлено' : '✅ Створено'} SiteConfig #${config.id} ` +
      `(${config.name}), статус ${config.status}, isActive=${config.isActive}`
    )

    return config
  } finally {
    await prisma.$disconnect().catch(() => {})
  }
}

async function main () {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return
  }

  const startUrl = normalizeStartUrl(options.url)
  log(`🌐 Дискавері: ${startUrl}${options.useLLM ? '' : ' (без LLM)'}`)

  const result = await discoverSite(startUrl, {
    log,
    useLLM: options.useLLM,
    maxItems: options.maxItems
  })

  log(
    `🧩 Знайдено подій: ${result.report.validation.total}, ` +
    `confidence ${result.confidence}, джерело ${result.sourceType}`
  )

  if (result.report.warnings?.length) {
    for (const warning of result.report.warnings) log(`⚠️ ${warning}`)
  }

  if (!options.save) {
    console.log(JSON.stringify({
      name: result.name,
      startUrl: result.startUrl,
      sourceType: result.sourceType,
      confidence: result.confidence,
      actions: result.actions,
      report: result.report
    }, null, 2))
    return
  }

  await saveResult(result, options)
}

main().catch((error) => {
  console.error(`❌ ${error.message}`)
  process.exitCode = 1
})
