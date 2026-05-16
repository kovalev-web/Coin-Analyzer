# Altcoin Pump Monitor

Локальный веб-сервис для мониторинга альткоинов с AI-анализом.

## Запуск

### 1. Установить зависимости

```bash
npm install
```

### 2. Установить API ключ Gemini

**Windows (PowerShell):**
```powershell
$env:GEMINI_API_KEY = "AIza..."
```

**Windows (cmd):**
```cmd
set GEMINI_API_KEY=AIza...
```

**Mac/Linux:**
```bash
export GEMINI_API_KEY=AIza...
```

### 3. Запустить сервер

```bash
npm start
```

### 4. Открыть в браузере

```
http://localhost:3000
```

## Структура

```
pump-analyzer/
├── server.js      # Node.js/Express backend (POST /api/analyze)
├── index.html     # Frontend (vanilla JS, SPA)
├── package.json
└── README.md
```

## Использование

- **Обновить** — перезагружает список монет с CoinGecko (кеш 2 минуты)
- **Анализировать все** — последовательно анализирует все монеты через Gemini API
- **Анализ** на строке таблицы — анализирует конкретную монету
- Фильтры объёма и роста настраиваются в реальном времени

## Требования

- Node.js 18+
- Бесплатный ключ Gemini API (gemini-2.5-flash)
