require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS: en producción solo permite los orígenes declarados en ALLOWED_ORIGINS
// (separados por coma). En desarrollo permite todo.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : null;

app.use(cors({
  origin: allowedOrigins
    ? (origin, cb) => {
        // Permite requests sin origin (curl, mobile apps, Railway health checks)
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`CORS: origen no permitido — ${origin}`));
      }
    : true,
  credentials: true,
}));

// Railway (y cualquier plataforma con proxy) requiere esto para que
// express-rate-limit identifique la IP real del cliente.
app.set('trust proxy', 1);

app.use(express.json());

// Sirve la PWA del staff como archivos estáticos
app.use(express.static(path.join(__dirname, '../pwa'), { dotfiles: 'deny' }));
app.use('/admin', express.static(path.join(__dirname, '../admin'), { dotfiles: 'deny' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', project: 'bodega-saas', ts: new Date().toISOString() });
});


app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/users'));
app.use('/api', require('./routes/warehouses'));
app.use('/api', require('./routes/inventory'));
app.use('/api', require('./routes/movements'));
app.use('/api', require('./routes/tasks'));
app.use('/api', require('./routes/task-templates'));
app.use('/api', require('./routes/reports'));

const prisma = require('./lib/prisma');

async function applyPendingMigrations() {
  await prisma.$executeRaw`ALTER TABLE "task_templates" ADD COLUMN IF NOT EXISTS "default_assignee_id" UUID REFERENCES "users"("id") ON DELETE SET NULL`;
  console.log('[startup] Migraciones aplicadas correctamente');
}

applyPendingMigrations()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor corriendo en http://localhost:${PORT}`);
      require('./lib/cron').startCronJobs();
    });
  })
  .catch((err) => {
    console.error('[startup] Error aplicando migraciones:', err);
    process.exit(1);
  });

module.exports = app;
