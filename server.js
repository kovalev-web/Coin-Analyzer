const express = require('express');
const path = require('path');
const { analyzeCoin } = require('./shared/analyze');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

if (!process.env.GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY environment variable is not set');
  process.exit(1);
}

app.post('/api/analyze', async (req, res) => {
  const { name, symbol, change24h, volume, price, natr } = req.body;
  if (!name || !symbol) {
    return res.status(400).json({ error: 'Missing required fields: name, symbol' });
  }
  try {
    const result = await analyzeCoin({ name, symbol, change24h, volume, price, natr });
    res.json(result);
  } catch (err) {
    const msg = err.message || 'Internal error';
    const code = msg.includes('API_KEY') ? 500 : 502;
    res.status(code).json({ error: msg });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('Pump Analyzer API running at http://localhost:' + PORT);
});
