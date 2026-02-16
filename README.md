# Habit System MVP

## Запуск

1. Встановити залежності:

```bash
npm install
```

2. Налаштувати `.env`:

```bash
BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
TELEGRAM_BOT_USERNAME=your_bot_username
# Опційно:
# PORT=3000
# DB_PATH=./data/habit.db
```

3. Запустити застосунок:

```bash
npm start
```

## Перевірка /health

```bash
curl http://localhost:3000/health
```

Очікувана відповідь:

```json
{"ok":true}
```

## PM2 (не запускається автоматично)

```bash
pm2 start src/index.js --name habit-bot
```

## Лендінг (публічна сторінка)

Після запуску застосунку відкрий у браузері:

```
http://localhost:3000
```

## Telegram WebApp

Відкривається всередині Telegram через кнопку **⚙️ WebApp** у боті.
Якщо відкрити `/app` у звичайному браузері — зʼявиться повідомлення **“Open inside Telegram”**.

Локально (для перевірки маршруту):

```
http://localhost:3000/app
```

## Перевірка POST /api/leads

```bash
curl -X POST http://localhost:3000/api/leads \\
  -H 'Content-Type: application/json' \\
  -d '{\"email\":\"test@example.com\",\"utm_source\":\"site\",\"utm_medium\":\"landing\"}'
```

Очікувана відповідь:

```json
{\"ok\":true,\"telegramUrl\":\"https://t.me/<BOT_USERNAME>?start=onboarding\"}
```

## Telegram команди

- `/start` — створює користувача і базові звички (Water, Read, Walk) та показує кнопку "Почати день"
- `/stats` — показує серію та % виконання за 7 днів
- `/time HH:MM` — встановлює час нагадування (наприклад, `/time 20:00`)
- `/tz TIMEZONE` — встановлює часовий пояс (наприклад, `/tz Europe/Prague`)

## Щоденні нагадування

- За замовчуванням використовується `Europe/Prague` та `20:00`.
- Планувальник перевіряє нагадування кожні 60 секунд.
- Якщо всі звички на сьогодні відмічені, нагадування не приходить.

### Як протестувати нагадування

1. Дізнайся поточний час у своїй таймзоні.
2. Встанови `/time` на +1 хвилину від поточного часу.
3. Зачекай до наступної хвилини — має прийти повідомлення про нагадування.

> Для таймзон використовуються `dayjs` плагіни `utc` та `timezone` (без додаткових залежностей).
