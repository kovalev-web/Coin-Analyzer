# Journal Flow — Technical Spec

## Обзор

Три фазы в день:
1. **Утро (гейт)** — модалка при открытии приложения, если время ≥ 09:30 МСК и утренняя запись за сегодня отсутствует
2. **День** — монеты + заметки в брифинге (уже реализовано, дополнительных изменений нет)
3. **Вечер (вывод)** — кнопка в шапке или профиле, открывает модалку вечернего вывода

---

## 1. База данных

### Добавить в `db/schema.js`

```js
exports.journalEntries = sqliteTable('journal_entries', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  userId:    text('user_id').notNull().references(() => exports.user.id),
  date:      text('date').notNull(), // 'YYYY-MM-DD', уникально на user

  // Утро
  morningState: text('morning_state'),   // "Состояние сейчас"
  volume:       text('volume'),          // "Объем"
  dayPlan:      text('day_plan'),        // "План на день"
  // "Стратегия" — фиксирована, не хранится

  morningAt: integer('morning_at', { mode: 'timestamp' }),

  // Вечер
  followedProcess:  text('followed_process'),   // да/нет/частично
  tradedPlanned:    text('traded_planned'),      // да/нет/частично
  tradeCount:       integer('trade_count'),      // подтягивается из брифинга
  stopCraneKept:    text('stop_crane_kept'),     // да/нет
  volumeOk:         text('volume_ok'),           // да/нет
  triggerFired:     text('trigger_fired'),       // да/нет
  eveningState:     text('evening_state'),       // "Состояние конца дня"
  feltWorthless:    text('felt_worthless'),      // да/нет/иногда
  freeConclusion:   text('free_conclusion'),     // свободный текст

  eveningAt: integer('evening_at', { mode: 'timestamp' }),
});
```

### Добавить в `db/setup.js`

Создать таблицу `journal_entries` если не существует. Уникальный индекс на `(user_id, date)`.

---

## 2. Backend (`server.js`)

Все эндпоинты требуют аутентификации (проверять сессию через `auth.api.getSession`, как в остальных маршрутах).

### `GET /api/journal/today`

Возвращает запись за сегодня (UTC дата) или `null`.

```js
// response
{ entry: { date, morningState, volume, dayPlan, morningAt, followedProcess, ... } | null }
```

### `POST /api/journal/morning`

Upsert утренних полей за сегодня.

```js
// body
{ morningState, volume, dayPlan }
// response
{ ok: true }
```

### `POST /api/journal/evening`

Upsert вечерних полей за сегодня.

```js
// body
{ followedProcess, tradedPlanned, tradeCount, stopCraneKept, volumeOk, triggerFired, eveningState, feltWorthless, freeConclusion }
// response
{ ok: true }
```

### `GET /api/journal/recent`

Последние 30 записей (по убыванию даты). Используется в профиле.

```js
// response
{ entries: [ { date, morningAt, eveningAt, morningState, eveningState, tradeCount, freeConclusion } ] }
```

Upsert-логика для morning/evening: если запись за сегодня есть — UPDATE только нужные поля; если нет — INSERT. Использовать drizzle `db.insert(...).onConflictDoUpdate(...)`.

---

## 3. Frontend

### `src/state.js` — добавить в `state`

```js
journalToday: null,  // { date, morningAt, morningState, ... } | null
```

### `src/api.js` — добавить 4 функции

```js
export async function fetchJournalToday() { ... }         // GET /api/journal/today → state.journalToday
export async function saveJournalMorning(data) { ... }    // POST /api/journal/morning
export async function saveJournalEvening(data) { ... }    // POST /api/journal/evening
export async function fetchJournalRecent() { ... }        // GET /api/journal/recent → returns entries array
```

### `src/ui.js` — добавить функции

#### `showMorningModal()`
Рендерит и показывает модальное окно утреннего журнала. Блокирует основной UI (z-index выше всего, оверлей на весь экран, без возможности закрыть крестиком).

Структура модалки:
```
─────────────────────────────────────
  📋 Утренний журнал   [дата]
─────────────────────────────────────
  Состояние сейчас
  [textarea]

  Объем
  [input text]

  План на день
  [textarea]

  Стратегия входа и стопа
  3% день, стоп 0.5, сделок 8 макс   ← disabled / read-only label

  [Сохранить и начать торговать]   ← button, disabled пока не заполнены все 3 поля
─────────────────────────────────────
```

Кнопка disabled если хотя бы одно из (`morningState`, `volume`, `dayPlan`) пустое.

После успешного сохранения: скрыть модалку, обновить `state.journalToday`.

#### `hideMorningModal()`
Скрывает и удаляет из DOM.

#### `showEveningModal()`
Рендерит вечернюю модалку. Можно закрыть (крестик / клик вне). Закрытие без сохранения — разрешено.

Структура:
```
─────────────────────────────────────
  📝 Вывод дня   [дата]               [×]
─────────────────────────────────────
  Следовал процессу        [dropdown: да / нет / частично]
  Торговал запланированные [dropdown: да / нет / частично]
  Кол-во сделок            [число, prefilled из briefing]
  Стоп-кран после 2 стопов [dropdown: да / нет / н/п]
  Объём был соразмерный    [dropdown: да / нет]
  Сработал триггер         [dropdown: да / нет]
  Состояние конца дня      [input text]
  Чувствовал «никчёмный»   [dropdown: да / нет / иногда]

  Свободный вывод
  [textarea, многострочный]

  [Сохранить вывод]
─────────────────────────────────────
```

Prefill `tradeCount`: считать `state.briefing.filter(e => e.date === today && e.status === 'traded').length`.

Если вечерняя запись уже есть в `state.journalToday` — prefill все поля из неё.

После сохранения: обновить `state.journalToday`, показать toast "Вывод сохранён".

#### `renderProfileJournal(container)`
Рендерит summary последних дней в переданный DOM-контейнер (используется в `/profile` роуте).

Формат: таблица или карточки по дням.

Колонки: Дата | Утро ✓/— | Вечер ✓/— | Сделок | Состояние утра | Свободный вывод (truncated)

### `src/main.js` — изменения

#### 1. Init: проверить нужно ли показать утреннюю модалку

Добавить вызов после `_sessionVerified = true` (внутри `(async function () { ... })()`):

```js
fetchJournalToday().then(function () {
  _checkMorningGate();
});
```

Функция `_checkMorningGate`:
```js
function _checkMorningGate() {
  // Москва = UTC+3. Утренний гейт: 09:30 МСК = 06:30 UTC
  var now = new Date();
  var utcH = now.getUTCHours();
  var utcM = now.getUTCMinutes();
  var minutesUTC = utcH * 60 + utcM;
  var gateUTC = 6 * 60 + 30; // 06:30 UTC = 09:30 МСК
  var endUTC  = 21 * 60;     // 21:00 UTC = 00:00 МСК — ночью не показываем
  if (minutesUTC < gateUTC || minutesUTC >= endUTC) return;
  if (!state.journalToday || !state.journalToday.morningAt) {
    showMorningModal();
  }
}
```

#### 2. Actions в `switch (action)` — добавить

```js
case 'open-evening-journal':
  showEveningModal();
  break;
case 'save-morning-journal': {
  var btn = target;
  btn.disabled = true;
  var modal = document.getElementById('morning-journal-modal');
  saveJournalMorning({
    morningState: modal.querySelector('[name="morningState"]').value.trim(),
    volume:       modal.querySelector('[name="volume"]').value.trim(),
    dayPlan:      modal.querySelector('[name="dayPlan"]').value.trim(),
  }).then(function () {
    hideMorningModal();
  }).catch(function () {
    btn.disabled = false;
  });
  break;
}
case 'save-evening-journal': {
  var eBtn = target;
  eBtn.disabled = true;
  var eModal = document.getElementById('evening-journal-modal');
  saveJournalEvening({
    followedProcess:  eModal.querySelector('[name="followedProcess"]').value,
    tradedPlanned:    eModal.querySelector('[name="tradedPlanned"]').value,
    tradeCount:       parseInt(eModal.querySelector('[name="tradeCount"]').value) || 0,
    stopCraneKept:    eModal.querySelector('[name="stopCraneKept"]').value,
    volumeOk:         eModal.querySelector('[name="volumeOk"]').value,
    triggerFired:     eModal.querySelector('[name="triggerFired"]').value,
    eveningState:     eModal.querySelector('[name="eveningState"]').value.trim(),
    feltWorthless:    eModal.querySelector('[name="feltWorthless"]').value,
    freeConclusion:   eModal.querySelector('[name="freeConclusion"]').value.trim(),
  }).then(function () {
    hideEveningModal();
  }).catch(function () {
    eBtn.disabled = false;
  });
  break;
}
case 'close-evening-journal':
  hideEveningModal();
  break;
```

#### 3. Маршрут `/profile`

Заменить заглушку:

```js
registerRoute('/profile', function () {
  var app = document.getElementById('app');
  app.innerHTML = '<div id="profile-page" style="padding:var(--space-12) var(--space-16);">' +
    '<div style="display:flex;align-items:center;gap:var(--space-8);margin-bottom:var(--space-16);">' +
    '<h2 style="font-size:var(--text-lg);font-weight:var(--font-bold);">Профиль</h2>' +
    '<button data-action="open-evening-journal" class="btn btn-sm btn-outline" style="margin-left:auto;">📝 Вечерний вывод</button>' +
    '</div>' +
    '<div id="profile-journal-section"></div>' +
    '</div>';
  fetchJournalRecent().then(function (entries) {
    renderProfileJournal(document.getElementById('profile-journal-section'), entries);
  });
});
```

### Кнопка вечернего вывода в шапке (опционально)

Если нужно — добавить в `ui.js` в функцию рендера шапки иконку/кнопку "📝" рядом с аватаром, `data-action="open-evening-journal"`. Показывать только если сессия активна.

---

## 4. Стили

Добавить в `src/styles.css`:

- `.journal-modal-overlay` — фиксированный оверлей, `z-index: 9999`, backdrop `rgba(0,0,0,0.6)`
- `.journal-modal` — карточка по центру, max-width 480px, padding, border-radius через дизайн-токены
- `.journal-modal select` — стилизовать под остальные инпуты проекта
- Утренняя модалка (`.journal-modal--morning`) — без кнопки закрытия
- Вечерняя модалка (`.journal-modal--evening`) — с кнопкой `[×]` в правом верхнем углу

---

## 5. Важные детали

- **Дата всегда UTC** на сервере (`new Date().toISOString().slice(0, 10)`), и клиент тоже использует UTC-дату для consistency.
- **Upsert**: если пользователь нажал "Сохранить утро" дважды — второй вызов UPDATE, не INSERT.
- **Ошибки сети**: кнопка "Сохранить" снова становится активной при ошибке, показать toast с текстом ошибки.
- **tradeCount prefill**: `state.briefing` может быть пустым при открытии вечерней модалки — просто показать 0.
- Брифинг status='traded' — проверить реальное значение статуса в `src/ui.js` (функции `briefingCycleStatus`).

---

## Порядок реализации

1. `db/schema.js` — добавить таблицу
2. `db/setup.js` — создать таблицу при старте
3. `server.js` — 4 эндпоинта
4. `src/state.js` — добавить `journalToday: null`
5. `src/api.js` — 4 функции
6. `src/ui.js` — 3 функции (morning modal, evening modal, profile render)
7. `src/main.js` — init check, actions, profile route
8. `src/styles.css` — стили модалок
