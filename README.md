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

## Міграції

Міграція `20261106120000_add_unique_start_url_and_drop_unused_enum` створює
унікальний індекс на `SiteConfig.startUrl`. На БД, де вже є дублікати,
спочатку перевірте їх:

```sql
SELECT "startUrl", COUNT(*)
FROM "public"."SiteConfig"
GROUP BY "startUrl"
HAVING COUNT(*) > 1;
```

Якщо дублікати знайдені, перенесіть події на найстаріший конфіг і видаліть
зайві записи:

```sql
WITH ranked AS (
  SELECT id, "startUrl",
         ROW_NUMBER() OVER (
           PARTITION BY "startUrl" ORDER BY "createdAt", id
         ) AS rn,
         FIRST_VALUE(id) OVER (
           PARTITION BY "startUrl" ORDER BY "createdAt", id
         ) AS keep_id
  FROM "public"."SiteConfig"
), dupes AS (
  SELECT id, keep_id FROM ranked WHERE rn > 1
)
UPDATE "public"."Event" e
SET "siteConfigId" = d.keep_id
FROM dupes d
WHERE e."siteConfigId" = d.id;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY "startUrl" ORDER BY "createdAt", id
         ) AS rn
  FROM "public"."SiteConfig"
)
DELETE FROM "public"."SiteConfig" s
USING ranked r
WHERE s.id = r.id AND r.rn > 1;
```

Після цього застосуйте міграції: `npx prisma migrate deploy`.

## Авто-дискавері сайтів

Скрапер може сам згенерувати конфіг за одним URL: знаходить картки подій,
селектори полів, пагінацію та сторінку події, після чого зберігає конфіг у
статусі `REVIEW`. Активувати сайт потрібно вручну.

Дискавері не перевіряє якість даних: на цьому етапі важливо лише, щоб
картки та поля взагалі витягувалися, а формат дати може бути будь-яким.
Спочатку перевіряються структуровані дані (JSON-LD/microdata) і, якщо
знайдено достатньо карток, Gemini не викликається. Інакше робиться до трьох
LLM-викликів: вибір картки й полів, виправлення рецепта, якщо карток
витягнуто замало, та, за потреби, уточнення полів на сторінці події.
Сканування сайтів LLM не використовує — працює лише зі збереженим рецептом.
Дати не фільтруються за минулим/майбутнім і не валідуються — це робиться
пізніше.

### API

`name` у `POST /site_configs/discover` обов'язковий. Для одного `startUrl`
створюється лише один `SiteConfig` (унікальний індекс у БД) — повторний
виклик оновлює існуючий запис.

`DELETE /site_configs/:id` виконує м'яке видалення: конфіг отримує
`deletedAt`, статус `ARCHIVED` і `isActive = false`, зникає зі списків та
вибірок, але всі його події залишаються в БД. Ендпоінт повертає
`{ "success": true }`. Повторне додавання того ж `startUrl` через
`POST /site_configs/discover` відновлює конфіг (`deletedAt = null`).

### UI

У адмінці: **Site configs → Додати сайт за URL** (`/site-configs/discover`).
Майстер показує живий лог і кнопку активації.

### Формат нового рецепта

`SiteConfig.actions` — масив дій:

- `paginate` — `{ mode: "url" | "loadMore", selector, param, maxPages }`
- `extractListItems` — `{ item, link, fields, source }`, де кожне поле є
  ланцюжком CSS-селекторів
- `extractDetails` — `{ source: "auto", fields }` для дозаповнення з детейла
- `seedUrls` — `{ urls: [] }` додаткові сторінки (наприклад, «ці вихідні»)

Підтримується лише цей формат. Конфіги з `extractList` / плоскими
`extractDetails` потрібно перегенерувати через дискавері.

## Скрипти

```bash
npm run lint          # ESLint
```
