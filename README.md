# vykhidni-api

API для сканування афіш дитячих подій, авто-дискавері сайтів і AI-нормалізації.

## Вимоги

- Node.js **20.19+ / 22.13+ / 24+** (рекомендовано 22 LTS, див. `.nvmrc`)
- PostgreSQL
- Gemini API key
- Google Maps API key (для геокодування)

## Налаштування

Створіть `.env` на основі `.env.example`:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/vykhidni_db"
GEMINI_API_KEY=...
GOOGLE_MAPS_API_KEY=...
# Необов'язково
# PORT=3000
# HOST=127.0.0.1
# CORS_ORIGINS=http://localhost:5173,http://localhost:5174
```

Ключі:

- **GEMINI_API_KEY** — https://aistudio.google.com/u/2/api-keys
- **GOOGLE_MAPS_API_KEY** — Google Cloud Console → увімкніть Geocoding API
  (https://console.cloud.google.com/apis/library) → створіть ключ.

Встановлення та запуск:

```bash
npm install
npx prisma migrate deploy
npm run dev
```

## Авто-дискавері сайтів

Скрапер може сам згенерувати конфіг за одним URL: знаходить картки подій,
селектори полів, пагінацію та сторінку події, після чого зберігає конфіг у
статусі `REVIEW`. Активувати сайт потрібно вручну.

### API

`name` у `POST /site_configs/discover` обов'язковий. Для одного `startUrl`
створюється лише один `SiteConfig` — повторний виклик оновлює існуючий запис.

Видалення сайту видаляє і всі його події (в одній транзакції) та повертає
`{ "success": true, "deletedEvents": <кількість> }`. Якщо події потрібно
зберегти, спочатку перенесіть їх на інший сайт або деактивуйте сайт.

### UI

У адмінці: **Site configs → Додати сайт за URL** (`/site-configs/discover`).
Майстер показує живий лог, валідацію, превʼю подій і кнопку активації.

### Формат нового рецепта

`SiteConfig.actions` — масив дій:

- `paginate` — `{ mode: "url" | "loadMore", selector, param, maxPages }`
- `extractListItems` — `{ item, link, fields, source }`, де кожне поле є
  ланцюжком CSS-селекторів
- `extractDetails` — `{ source: "auto", fields }` для дозаповнення з детейла
- `seedUrls` — `{ urls: [] }` додаткові сторінки (наприклад, «ці вихідні»)

Старі конфіги з `extractList` / плоскими `extractDetails` і далі працюють.

## Скрипти

```bash
npm run lint          # ESLint
npm test              # node:test
npm run backfill:unix # перерахувати unixTime для наявних подій
```
