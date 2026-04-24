require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;
const IS_PROD = process.env.NODE_ENV === 'production';

// CORS
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3001').split(',').map(o => o.trim());
app.use(cors({
  origin: (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin)) ? cb(null, true) : cb(new Error('CORS bloccato')),
  credentials: true,
}));
// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Rate limiting
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Troppi tentativi. Riprova tra 15 minuti.' } }));
app.use('/api/auth/setup', rateLimit({ windowMs: 60 * 60 * 1000, max: 3 }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300 }));

// Body parser must run before API routes that read req.body
app.use(express.json({ limit: '20mb' }));

// Static assets
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'horygon_dev_secret',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, secure: IS_PROD }
}));

// Routes
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/utenti',      require('./routes/utenti'));
app.use('/api/anagrafiche', require('./routes/anagrafiche'));
app.use('/api/prodotti',    require('./routes/prodotti'));
app.use('/api/ordini',      require('./routes/ordini'));
app.use('/api/fatture',     require('./routes/fatture'));
app.use('/api/google',      require('./routes/google'));
app.use('/api/contatti',    require('./routes/contatti'));
app.use('/api/system',      require('./routes/system'));
app.use('/api/mepa',        require('./routes/mepa'));
app.use('/api/rdo',         require('./routes/rdo'));
app.use('/api/cig',         require('./routes/cig'));
app.use('/api/analytics',   require('./routes/analytics'));
app.use('/api',             require('./routes/operativo'));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: IS_PROD ? 'Errore interno' : err.message });
});

// SPA fallback
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Horygon CRM → http://localhost:${PORT} [${IS_PROD ? 'PROD' : 'DEV'}]`);
});
