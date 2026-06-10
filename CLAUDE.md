# Архитектура

## Стек
- **Frontend**: Vanilla JS (без React/Vue), Vite, hash-роутер (`#/path`)
- **Backend**: Node.js HTTP-сервер `server-vps.js` (продакшн на VPS), `server.js` (локальный dev)
- **БД**: SQLite через Drizzle ORM. Схема: `db/schema.js`, инициализация: `db/setup.js`, соединение: `db/index.js`
- **Аутентификация**: better-auth. Таблицы: `user`, `session`, `account`, `verification`
- **Сборка**: Vite, `dist/` — собранный фронт

## Ключевые файлы фронтенда

| Файл | Роль |
|------|------|
| `src/main.js` | Точка входа: event delegation (паттерн `data-action`), инит роутера, WS-события |
| `src/ui.js` | Все render-функции, модалки, панели |
| `src/api.js` | Все fetch-вызовы к бэкенду и внешним API |
| `src/state.js` | Глобальный `state` объект + `filteredCoins()` |
| `src/router.js` | Hash-роутер: `registerRoute(path, fn)`, `initRouter()` |
| `src/events.js` | Event bus: `on(event, fn)` / `emit(event, data)` |
| `src/styles.css` | Основные стили |
| `src/design/` | CSS-токены, base, components, layout |

## Паттерн UI

Клики обрабатываются через делегирование в `main.js`:
```js
document.body.addEventListener('click', function (e) {
  var target = e.target.closest('[data-action]');
  switch (target.dataset.action) { ... }
});
```
Новые действия → добавлять в `switch` в `main.js`. Рендер → функция в `ui.js`. Запрос к серверу → функция в `api.js`.

## Роуты фронтенда
- `#/` — основной экран с карточками монет
- `#/screener` — скринер
- `#/profile` — профиль (сейчас заглушка, будет журнал)
- `#/settings` — настройки (заглушка)

## API-эндпоинты (server-vps.js)
- `POST /api/analyze` — анализ монеты через Claude + web_search
- `POST /api/levels` — уровни цены
- `POST /api/alerts` — алерты
- `POST /api/briefing` — CRUD брифинга
- `GET  /api/account` — профиль пользователя
- `POST /api/proxy` — прокси к Binance
- `GET  /api/notifications` — уведомления
- `/api/auth/*` — better-auth

## Состояние приложения (state.js)
```js
state.coins[]          // монеты с CoinGecko
state.analysisCache{}  // кэш анализов Claude
state.briefing[]       // [{sym, date, addedAt, status, note}]
state.trades{}         // 'sym:date' → данные сделок
state.weekSummary      // агрегат за неделю
state.journalToday     // запись дневника за сегодня (добавляется в задаче журнала)
```

## Inplay-движок (`inplay/`)
Отдельный модуль для торговых сигналов в реальном времени. Конфиг весов: `inplay/config.json`.
Файлы: `phase-detector.js`, `indicators.js`, `microstructure.js`, `orderbook.js`, `score.js`, `buffers.js`.
Каждый модуль имеет тесты (`*.test.js`).

## Дизайн-система

**Правило:** любой новый UI обязан использовать токены из `src/design/tokens.css`. Никаких хардкоженных цветов, отступов или размеров — только CSS-переменные.

### Ключевые токены

**Цвета поверхностей:** `--canvas`, `--paper`, `--cloud`, `--fog`, `--steel` (бордер)
**Цвета текста:** `--ink-deep` (основной), `--graphite` (мuted)
**Бренд/статус:** `--primary`, `--bullish`, `--danger`, `--level-deep`
**Тёмная тема** работает автоматически через CSS-переменные — отдельно обрабатывать не нужно

**Отступы:** `--space-2` (4px) → `--space-4` (8px) → `--space-6` (12px) → `--space-8` (16px) → `--space-12` (24px) → `--space-16` (32px). Все значения кратны 2.
**Типографика:** `--text-2xs` (10) → `--text-xs` (12) → `--text-sm` (14) → `--text-base` (16) → `--text-lg` (18). Веса: `--font-normal/medium/semi/bold`.
**Радиусы:** `--radius-md` (8px), `--radius-xl` (16px), `--radius-full`
**Высоты кнопок/инпутов:** `--h-btn-sm` (26), `--h-btn-md` (30), `--h-btn-lg` (36), `--h-input` (40)
**Тень:** `--shadow-md`

### Готовые компоненты (`src/design/components.css`)

| Что | Класс |
|-----|-------|
| Инпут (text, textarea) | `.ds-input` |
| Select (нативный) | `select.ds-input` |
| Select (кастомный) | `.ds-select` + `.ds-select-btn` + `.ds-select-dd` + `.ds-select-item` |
| Popup/модалка | `.popup` → `.popup-header` → `.popup-title` → `.popup-body` → `.popup-footer` |
| CTA-кнопка | `.btn-cta` (`.danger` модификатор для деструктивных) |
| Иконка-кнопка | `.btn-icon` |
| Кнопка в шапке | `.btn-topbar` |
| Спиннер кнопки | `.btn-loading` (добавить к `<button>`) |
| Спиннер инлайн | `.spinner` |
| Оверлей (fullscreen) | `.overlay` (position:fixed;inset:0) |
| Модалки журнала | `.journal-modal-overlay`, `.journal-modal`, `.journal-modal--morning/evening`, `.journal-field`, `.journal-static`, `.journal-history` |

Модалки журнала **уже есть** в `components.css` — не добавлять повторно в `styles.css`.

### Анимации

`popup-in` — для попапов, `overlay-in` — для оверлеев. Подключаются через `animation: popup-in 0.15s ease-out` или `overlay-in 0.2s ease`.

## Деплой
- VPS: `server-vps.js` запускает HTTP + WebSocket на одном порту
- Vercel: `vercel.json` + `api/` (serverless functions) — только для dev/preview
- `.env` содержит `ANTHROPIC_API_KEY`, `DATABASE_URL`, ключи Binance и др.

---

# Правила работы с кодом

- Если видишь упоминание CVD/OBI/OI до Этапа 2-4 — это контекст, не задача.

- Каждая формула из спеки = отдельная функция + тест с известным входом.

- Веса скора — в config.json (`inplay/config.json`), не в коде.

- Не добавлять индикаторы помимо указанных в спеке. Хочешь добавить — сначала спроси.
