# Djinni RSS Telegram Bot (v0.1)

Telegram-бот, який:

- парсить RSS Djinni за категорією (`primary_keyword`) і роками досвіду (`exp_level`)
- надсилає нові вакансії в чат
- зберігає налаштування користувача в SQLite
- дозволяє змінювати категорію та досвід через `inline_keyboard`

## Запуск

```bash
npm install
cp .env.example .env
# заповніть TELEGRAM_BOT_TOKEN
npm run dev
```

## Продакшн

```bash
npm run build
npm start
```

`npm run build` використовує `tsup` (конфіг: `tsup.config.ts`).

## Змінні середовища

- `TELEGRAM_BOT_TOKEN` (обов'язково)
- `POLL_INTERVAL_MS` (опційно, за замовчуванням `180000`)
- `DATABASE_PATH` (опційно, за замовчуванням `./data.sqlite`)

## Команди в боті

- `/start` - старт і первинний вибір категорії/досвіду
- `/settings` - зміна категорії, років досвіду, пауза/активація

## Архітектура

- OOP + DI через `awilix`
- Composition root: `/Users/sviatoslav/Documents/Projects/djinni-parser/src/main.ts`
- Класи:
  - `/Users/sviatoslav/Documents/Projects/djinni-parser/src/app/bot-app.ts`
  - `/Users/sviatoslav/Documents/Projects/djinni-parser/src/repositories/settings-repository.ts`
  - `/Users/sviatoslav/Documents/Projects/djinni-parser/src/services/rss-feed-service.ts`
  - `/Users/sviatoslav/Documents/Projects/djinni-parser/src/services/ui-formatter.ts`
  - `/Users/sviatoslav/Documents/Projects/djinni-parser/src/services/app-logger.ts`

## Логіка роботи

1. На старті користувач вибирає категорію через `inline_keyboard` (з пагінацією).
   Є опція `Всі категорії` (RSS без `primary_keyword`: `https://djinni.co/jobs/rss`).
2. Фільтр за роками досвіду (`exp_level`) опційний: можна вибрати кілька або не вибирати зовсім.
3. Налаштування зберігаються в SQLite.
4. Бот зберігає `last_job_link` (посилання найновішої вакансії у фіді).
5. На кожному polling-циклі бот шукає цей лінк у RSS і надсилає всі вакансії, що з'явилися перед ним.
6. У консолі є лог кожного polling-циклу: кількість чатів, URL RSS, `previous_link`, `latest_link`, скільки вакансій надіслано.
