# ГЛАВНОЕ ПРАВИЛО: UI — только shadcn/ui

В этом проекте UI-библиотека — **shadcn/ui** (React + Tailwind v4 + Radix).
- Любой новый или переделываемый интерфейс собирается из компонентов shadcn (`npx shadcn@latest add <name>`), а не из самописной разметки и CSS.
- Нужного компонента нет — сначала искать в реестре shadcn (и его блоках), только потом собирать из примитивов shadcn. Самописное — лишь там, где у shadcn ничего нет, и сказать об этом пользователю.
- Как подключено и изолировано от vanilla-части — раздел «shadcn в проекте» ниже (`src/react/` — образец). Старые vanilla-экраны переносятся на shadcn, когда до них доходит задача.

# Архитектура

## Стек
- **Frontend**: Vanilla JS, Vite, роутер по pathname (`src/router.js`). Исключение — страница журнала `/journal`: React-остров на **shadcn/ui** (`src/react/journal/`, см. «shadcn в проекте»)
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
- `/journal` — журнал (React + shadcn)
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

## shadcn в проекте (`src/react/`)
Раздел Journal целиком на компонентах shadcn/ui (React 19 + Tailwind v4 + Radix) — образец для остальных экранов. Остальной сайт пока vanilla.
- **Окна поверх vanilla-страниц** (диалоги, поповеры, палитра, тосты) — один React-хост `src/react/host/host.jsx`, грузится лениво (предзагрузка на idle). Vanilla-код зовёт его через `src/react-bridge.js`: `openSurface(name, props)`, `closeSurface(name)`, `isSurfaceOpen()`, `toast(msg, opts)` (Sonner). Имена окон — `src/react/host/surfaces.jsx`: `search` (⌘K, Command), `clear`, `hints`, `weekly`, `notifications`, `morning`, `evening`, `briefing` (панель брифинга под закладкой, `src/react/home/Briefing.jsx` — там же `BriefingDrawer`, выдвижная панель полноэкранного графика: остров в `#fv-briefing-drawer`, монтируется в `openFVBriefingDrawer`; список перерисовывается по `briefing:render`, `renderBriefingPanel()` / `renderFVBriefingDrawer()` теперь только шлют его), `account` (настройки аккаунта, `host/account/`: вкладки Profile / Integrations / Security; торговые ключи и 2FA — `TradingKeys.jsx`, показываются только торговому аккаунту, ключи и 2FA — только по HTTP). Поповер у vanilla-кнопки — `rect` кнопки + `AnchorBox` (`host/anchor.jsx`). Слой окон выше полноэкранного графика (z-index в `shadcn.css`); Esc закрывает только окно (`_onEscKey` в `ui.js` пропускает, пока окно открыто).
- Карточки журнала: кто может открыть — `src/journal-cards.js` (`openMorningJournal` / `openEveningJournal`), после сохранения диалог шлёт событие `journal:saved` ({kind}), vanilla обновляет кнопки в `main.js`. React перерисовывается по событиям `events.js` через `useEvents` (`src/react/shared/use-event.js`).
- **Острова на vanilla-страницах** (`src/react/islands.jsx`): `mountIsland(el, Component, props)` рендерит синхронно (flushSync) в плейсхолдер, `unmountIslands(container)` — перед заменой `#app`. React в основном бандле, чтобы шапка была сразу. Главная (`render()` в `ui.js`): шапка `src/react/home/Topbar.jsx`, полоса дня `DaySummary.jsx` (BTC/ETH/SOL с мини-графиком, Your 24h, Open now с «Close all positions» — подтверждение вторым кликом за 5 с) панель фильтров `SortBar.jsx` и шапка каждой карточки монеты `CardHead.jsx` (коробка карточки и график — vanilla, `renderCard` / `initCharts`, по `#chart-<sym>`; шапки монтирует `mountCardHeads`, цифры перерисовываются общим тиком 500 мс, звезда — по `briefing:changed`); кнопки сохраняют `data-action`, клики по-прежнему обрабатывает `main.js`. Живые значения — через события (`ws:status`, `metrics:update`, `notifications:updated`, `avatar:changed`). Компонент острова не читает экспорты `ui.js` при загрузке модуля (циклический импорт) — только при рендере. Тултип поверх ToggleGroupItem перебивает его `data-state` — выбранный стилизовать по `aria-checked`. Глобальные правила сайта для `button` в `components.css` обёрнуты в `:where(button:not(.jr *, [data-slot], [data-slot] *))` — порядок CSS сайта и shadcn в dev и сборке разный, поэтому они не должны пересекаться. Dev-сервер Tailwind не видит классы из нового файла в `src/react` до перезапуска vite (в сборке всё есть).
- **Страница журнала** `/journal` — `src/react/journal/` (`mount.jsx`), уход со страницы — `unmountJournal` через `onRouteChange` в `router.js`.
- Общее: `src/react/shared/` (`Chips` — выбор одного из чипов, `Field`, `useSiteTheme`, `useEvents`).
- Новые компоненты: `npx shadcn@latest add <name>` (конфиг `components.json`, алиас `@` → `src/react`, файлы в `components/ui/*.jsx`; при запросе перезаписать существующий — `-o`). После `add` проверить импорты: CLI иногда пишет `from "cn"` → заменить на `@/lib/utils`.
- Изоляция (`shadcn.css`): Tailwind-тема `reference inline` (ни одной CSS-переменной в `:root`, наши `--text-sm`/`--radius-md`/`--primary` не перетираются), утилиты только из `src/react` (`source(none)` + `@source`), сброс стилей (`preflight.css`) только внутри `.jr` и порталов shadcn (`[data-slot]`). Цвета shadcn (`background`, `primary`, `muted`, `border`…) смаплены на наши токены — тёмная тема работает сама; свои: `text-bullish`, `text-danger`, `text-brand`.
- Части журнала (`src/react/journal/`): `JournalPage.jsx` (данные, период `state.journalPeriod`), `Header.jsx` (период, Calendar, экспорт, AI), `AiDialog.jsx`, `PnlChart.jsx` (shadcn Chart / recharts), `EdgeSummary.jsx` (Исполнение, Сетапы + редактор, Выводы), `DayTable.jsx` (по дням, сделки, пометки, «На графике»), `format.js`.
- Логика и данные — прежние модули (`api.js`, `setups.js`, `coin-notes.js`, `edge-insights.js`, `openTradeInChart` из `ui.js`).

## Дизайн-система

**Правило:** любой новый UI обязан использовать токены из `src/design/tokens.css` (в журнале — через классы shadcn, смапленные на эти токены). Никаких хардкоженных цветов, отступов или размеров — только CSS-переменные.

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
| Переключатель вкл/выкл | `.ds-switch` > `<input type="checkbox">` + `<i></i>` |
| Кнопка в шапке | `.btn-topbar` |
| Спиннер кнопки | `.btn-loading` (добавить к `<button>`) |
| Спиннер инлайн | `.spinner` |
| Оверлей (fullscreen) | `.overlay` (position:fixed;inset:0) |


### Анимации

`popup-in` — для попапов, `overlay-in` — для оверлеев. Подключаются через `animation: popup-in 0.15s ease-out` или `overlay-in 0.2s ease`.

## Деплой
- VPS: `server-vps.js` запускает HTTP + WebSocket на одном порту
- Vercel: `vercel.json` + `api/` (serverless functions) — только для dev/preview
- `.env` содержит `ANTHROPIC_API_KEY`, `DATABASE_URL`, ключи Binance и др.
- WebSocket: сначала прямой `wss://trade.questtick.com/ws` (DNS only, nginx `questtick-trade` на VPS, сертификат Let's Encrypt, наружу открыт только `/ws`; из Вьетнама ~70 мс против ~115 через Cloudflare), при неудаче — `wss://api.questtick.com/ws` через Cloudflare, повтор прямого через 5 мин (`src/api.js`). HTTP API — только через Cloudflare.
- Индикатор связи в стакане: `src/latency.js` (+ формулы `src/latency-stats.js`, `npm run test:latency`), сервер отвечает на `{type:'ping'}` в WS с маршрутом, узлом Cloudflare, страной и задержкой сервер → Binance.

## Торговля (`trader/`)
Отдельный процесс (pm2 `trader`), только он держит ключи Binance. Слушает `127.0.0.1:3010`, каждый запрос — с заголовком `x-trader-secret`.
- Конфиг: `/etc/questtick-trader/config.json` (`env: testnet|mainnet`, `internalSecret`, `masterKey`, `publicIp`). Mainnet только с `"allowMainnet": true`.
- Торговые ключи сохраняются из личного кабинета (Integrations → Trading API) и лежат зашифрованными (AES-256-GCM, `masterKey`) в `dataDir/credentials.enc`, по слоту на testnet/mainnet. Секрет никогда не возвращается во фронт; сохранение/удаление требует пароль аккаунта, уведомление уходит в Telegram. Ключи активной среды подхватываются без перезапуска.
- 2FA (TOTP) для торговли: секрет в том же зашифрованном файле, проверяет trader. При включённой 2FA новые ордера/плечо/resume требуют разблокировки (`/unlock`, 12 ч); отмены, kill и reduce-only/close-position работают всегда. На mainnet торговля без 2FA не включится. Включение/выключение 2FA и смена ключей — пароль аккаунта (+ код, если 2FA включена).
- pump-ws проксирует `/api/trade/*` → trader, пускает только `TRADER_USER_ID`; события trader (SSE `/events`) уходят в WS этого пользователя как `trade_event`.
- Стоп/тейк — через Algo API (`/fapi/v1/algoOrder`), обычные ордера — `/fapi/v1/order`. Стакан ставит SL/TP и стоп-входы с триггером по последней цене (`workingType: CONTRACT_PRICE`), не по mark — mark обновляется ~раз в секунду и запаздывает на резком движении.
- Повтор `clientOrderId` в течение 10 минут не создаёт второй ордер. Kill switch хранится в `dataDir/trading.json`, журнал действий — `dataDir/audit.jsonl`.
- Ворота дня (pump-ws): новые входы (`order` без reduceOnly/closePosition, `leverage`, `resume`) открыты только когда за сегодня заполнена утренняя карточка журнала (не skipped) и не заполнена вечерняя. «Сегодня» — `userTodayStr()` (тот же день, что у брифинга/журнала). Вечерняя карточка торгового аккаунта не сохраняется при открытой позиции или заявке на вход. Стакан показывает причину (`GET /api/trade/day`).
- Журнал/брифинг для торгового аккаунта на mainnet берут сделки через trader (`/history/trades`, `/history/income`), иначе — read-only ключ.
- Тесты: `npm run test:trader`. Сквозной сценарий на тестнете: `node trader/scripts/e2e-testnet.js`.
- **Live / Test.** Второй процесс pm2 `trader-test` (порт 3011, env testnet = Binance Demo, конфиг `/etc/questtick-trader/config-testnet.json`, `credentialsFile` общий с боевым — подхватывает пересохранённый тестовый ключ сам). pump-ws маршрутизирует по env (`?env=test` в HTTP, `msg.env` в WS) только торговые команды и их чтения (`TEST_ACTIONS`); ключи, 2FA, журнал — всегда боевой trader. В Test нет ворот дня и 2FA-блокировки, сделки не попадают в журнал.
- **Перенос заявки (drag):** `POST /move` — LIMIT меняется на месте (PUT order, отказ если цена прошла бы через рынок), algo (стоп-вход, SL/TP) — проверка триггера по mark/last, отмена и новая с теми же параметрами, при неудаче старая ставится обратно. Перенос входа = как новая заявка (2FA, ворота дня), SL/TP/reduce-only — всегда.
- **Локальный стоп** (`trader/localstops.js`, как local stop в Tiger, но на сервере в Токио): trader подписан на `aggTrade` (`/market/ws`) по монетам с открытым SL/TP и, как только сделка прошла через триггер, сам закрывает позицию reduce-only MARKET (`ls-<algoId>`), затем снимает биржевой ордер. Биржевой SL/TP остаётся страховкой (trader упал — сработает Binance); двойное срабатывание безопасно (reduce-only). Kill switch его не блокирует. Аудит `local-stop` с задержками, событие `local-stop` → тост в стакане. Выключить: `"localStops": false` в конфиге trader.
- **Безубыток:** trader после каждого fill и при старте считает `realizedPnl` текущей позиции по `userTrades` (от fill, открывшего позицию; комиссии только USDT) и шлёт `breakEven = entry − realized / amount`. Зона PnL в стакане и на графике строится от безубытка.
- Деплой trader/pump-ws на прод — только с явного «да» пользователя (git pull + `pm2 restart …`); перезапуск боевого trader = пара секунд переподключения к Binance.

## Стакан (`src/terminal.js`) — устройство
Слева направо: кластеры (2 колонки) | лента сделок (canvas) | **Volume | Price | Mine** (Binance фьючерс, здесь торгуют; всё это — один фон `--cloud`) | стаканы Spot, Bybit, OKX (только наблюдение, те же строки цен, свой более светлый фон).
- Клики: заявки только в колонках Volume/Price; ЛКМ buy, ПКМ sell, Shift = SL/TP, Option = стоп-вход (BS/SS) — пока клавиша зажата, в Mine наведённой строки виден призрак заявки (BS/SS с объёмом, SL/TP), клик по Mine = отмена уровня, drag метки в Mine = перенос. Повторные клики по уровню суммируются (отдельные ордера). Space = снять все заявки по монете + закрыть позицию; % от цены — в ячейке Volume наведённой строки (вместо её объёма); X = снять все; +/− масштаб; 1…6 слоты объёма. Всё в USDT.
- Настройки — модалка по шестерёнке, **на каждую монету** (`localStorage qt_term_settings_<SYM>`): слоты, полная шкала (Auto по умолчанию, ввод `2M`/`500K`), «Colored from» (чипы), лента, порог ленты (Auto), кластеры (период), другие биржи (вкл, full/compact), рамки (Auto).
- Вид как в Tiger: аски/биды — красный/зелёный фон Volume+Price, лучший аск и бид залиты целиком (спред), бары объёма серые, янтарные (`--level-deep`) только плотности, последняя сделка — рамка ячейки Price. Открытая позиция — яркая полупрозрачная полоса цвета PnL (зелёная в плюсе, красная в минусе) поверх Volume|Price от безубытка до цены с толстым краем цвета PnL; свои заявки — слабый оттенок.
- Автошкала (`src/ladder-scale.js`): длина бара — от 90-го процентиля видимых уровней (сглажено); **цвет только у плотностей** — уровень ≥ 3× медианы видимых и ≥ % от полной шкалы. Та же шкала в долларах для стаканов других бирж.
- Другие биржи: сделки `src/venues.js` (Binance F/S, Bybit linear, OKX swap — прямо из браузера), стаканы `src/venue-books.js` (spot snapshot+diff, Bybit `orderbook.1000`, OKX `books` 400 × ctVal). Нелистинг/делистинг (Bybit status ≠ Trading, OKX state ≠ live, spot −1121) → красная буква, колонка свёрнута. Строки дальше глубины потока заштрихованы. Сторона ячейки (аск/бид) — по собственному стакану биржи, у каждой колонки своя линия спреда (`bestAsk`/`bestBid` из `bookRows`): если Bybit или спот торгуются выше/ниже Binance, это видно по сдвигу их линии. 1000-монеты пересчитываются (`src/venues-stats.js`).
- Рамки на чужих стаканах и порог ленты — `src/hit-stats.js`: удар = сделки на строке за 0.5 с; рамка если > 90-го процентиля сделок этой биржи за 3 мин или съел ≥ 20% настоящего уровня; сила 1/2/3. Лента Auto: скрывает < 60-го процентиля (не меньше 10 $).
- Индикатор связи и маршрут — выше (Деплой). Тесты формул: `npm run test:latency`, `test:ladder`, `test:venues`, `test:hits`.
- Проверка в браузере без логина: открыть `localhost:5174` (vite с `VITE_WS_URL=wss://api.questtick.com/ws`), подменить `fetch` для `/api/trade/*`, перехватить `WebSocket.prototype.send` для `type:'trade'` (чтобы ничего не ушло на биржу), `import('/src/terminal.js?fresh=…')` и `terminalOnFVOpen('SOL')`. Вызов javascript_tool ≤ 45 с.

## Журнал и личный edge
- **Заметки по монете** (`src/coin-notes.js`): много на монету, у каждой время и цена записи. Кнопка в островке графика → поле ввода (Enter сохраняет); заметка добавляет монету в сегодняшний брифинг. На графике — пузырь в точке (время, цена), по наведению текст, скрываются переключателем в окне заметок (`qt_notes_on_chart`); в брифинге — список за день. Сервер: таблица `coin_notes`, `GET/POST /api/journal/notes` (`?symbol=` или `?from=&to=`; POST `{symbol,text,price}` или `{id,delete:true}`). Это шаг 1 «таймлайна монеты»; дальше метка выбора в брифинг + сделки с пометками за любой период, затем экран «Неделя» в журнале.
Флоу: брифинг = день (карточки, монеты, заметки), журнал = период (график по всем сделкам, «По дням», «Мой edge» за любой период, без зависимости от вечерней карточки). Принцип и определения — `docs/TRADER_EDGE.md` (читать перед любой работой с журналом, отчётами или анализом сделок).
Журнал (`#/journal`) сверху вниз: один фильтр периода на всю страницу (Неделя / Месяц / Всё время / Свои даты, `state.journalPeriod`) → график PnL по всем сделкам → сводка «Мой edge» за период (`src/react/journal/EdgeSummary.jsx`): **Исполнение** (% по правилам, число и список ошибок) и **Сетапы** (сделки по правилам, по итогу R, + «Все сделки, с ошибками»), пояснения в тултипах ⓘ → **Выводы** (`conclusions` в `src/edge-insights.js`) → таблица **По дням** (дата, сделок, % по правилам, PnL, бейдж «без сетапа»); день раскрывается: исполнение дня (100% или ошибки) и сделки дня по сетапам (все сделки, ошибки отмечены; «Без сетапа», «Не считаются»), внутри — заметки по монете, чипы перепометки и кнопка «На графике» — открывает обычный полноэкранный график монеты в режиме разбора (`openTradeInChart` в `src/ui.js`): история по REST с Binance (докачка при прокрутке к краю), любой таймфрейм, без живых обновлений, стакана и терминала, всегда открывается на участке сделки (даже спустя месяцы); в островке нет инструментов, уровни/лучи/алерты живого графика не показываются и не двигаются; ПКМ ставит/снимает уровень только для этой сделки — сохраняется у неё (таблица `review_levels`, ключ пользователь+символ+время закрытия, `GET/POST /api/journal/review-levels`), на живой график не попадает; заметки по монете видны; исполнения сделки — наши треугольники (`execs` в фактах дня, версия фактов 3). Данные дня — `byDay` из `computeEdge`. AI-сводка доступна для периода Неделя / Месяц.
Факты дня считает `journal/facts.js` из сделок (`GET /api/journal/facts`), снимок — `journal_entries.facts_json`. Факты приоритетнее самооценки в карточках.

---

# Правила работы с кодом

- Если видишь упоминание CVD/OBI/OI до Этапа 2-4 — это контекст, не задача.

- Каждая формула из спеки = отдельная функция + тест с известным входом.

- Не добавлять индикаторы помимо указанных в спеке. Хочешь добавить — сначала спроси.
