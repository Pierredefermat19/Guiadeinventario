const prisma = require('./prisma');
const { deleteExpiredPhotos } = require('./supabase');

async function expirePhotoDeadlines() {
  try {
    const { count } = await prisma.task.updateMany({
      where: {
        status: 'completada_pendiente_foto',
        photoDeadline: { lt: new Date() },
      },
      data: { status: 'completada_sin_foto' },
    });
    if (count > 0) console.log(`[cron] ${count} tarea(s) cerradas por deadline de foto vencido`);
  } catch (err) {
    console.error('[cron] expirePhotoDeadlines error:', err);
  }
}

// ── Cron expression evaluator ──────────────────────────────────────
// Supports: *, N, N-M, N/S, N,M,... (standard 5-field cron)
function matchesCronField(expr, value, min, max) {
  if (expr === '*') return true;
  if (expr.includes(',')) {
    return expr.split(',').some((p) => matchesCronField(p.trim(), value, min, max));
  }
  if (expr.includes('/')) {
    const [range, step] = expr.split('/');
    const s = parseInt(step, 10);
    const base = range === '*' ? min : parseInt(range, 10);
    return value >= base && value <= max && (value - base) % s === 0;
  }
  if (expr.includes('-')) {
    const [lo, hi] = expr.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  return parseInt(expr, 10) === value;
}

function matchesCron(cronExpr, date) {
  const [minute, hour, dom, month, dow] = cronExpr.trim().split(/\s+/);
  return (
    matchesCronField(minute, date.getMinutes(), 0, 59) &&
    matchesCronField(hour,   date.getHours(),   0, 23) &&
    matchesCronField(dom,    date.getDate(),     1, 31) &&
    matchesCronField(month,  date.getMonth() + 1, 1, 12) &&
    matchesCronField(dow,    date.getDay(),      0,  6)
  );
}

// ── Recurring task generation ──────────────────────────────────────
// Called every minute. For each active template whose cron matches the
// current minute, creates a Task if one doesn't already exist this minute
// (idempotent window = current minute).
async function generateRecurringTasks() {
  try {
    const now = new Date();
    const windowStart = new Date(now);
    windowStart.setSeconds(0, 0);
    const windowEnd = new Date(windowStart);
    windowEnd.setMinutes(windowEnd.getMinutes() + 1);

    const templates = await prisma.taskTemplate.findMany({
      where: { isActive: true },
      select: { id: true, warehouseId: true, title: true, description: true, cronExpr: true, defaultAssigneeId: true },
    });

    let created = 0;
    for (const tpl of templates) {
      if (!matchesCron(tpl.cronExpr, now)) continue;

      const exists = await prisma.task.findFirst({
        where: { templateId: tpl.id, scheduledFor: { gte: windowStart, lt: windowEnd } },
      });
      if (exists) continue;

      await prisma.task.create({
        data: {
          warehouseId: tpl.warehouseId,
          templateId: tpl.id,
          title: tpl.title,
          description: tpl.description,
          status: 'disponible',
          scheduledFor: windowStart,
          ...(tpl.defaultAssigneeId && { assignedTo: tpl.defaultAssigneeId }),
        },
      });
      created++;
    }

    if (created > 0) console.log(`[cron] ${created} tarea(s) recurrente(s) generadas`);
  } catch (err) {
    console.error('[cron] generateRecurringTasks error:', err);
  }
}

async function purgeExpiredPhotos() {
  try {
    const { deleted } = await deleteExpiredPhotos();
    if (deleted > 0) console.log(`[cron] ${deleted} foto(s) expiradas eliminadas de Storage y BD`);
  } catch (err) {
    console.error('[cron] purgeExpiredPhotos error:', err);
  }
}

function startCronJobs() {
  expirePhotoDeadlines();
  generateRecurringTasks();

  setInterval(expirePhotoDeadlines, 60 * 60 * 1000);  // cada hora
  setInterval(generateRecurringTasks, 60 * 1000);      // cada minuto

  // Limpieza de fotos expiradas: corre diariamente a las 03:00 UTC
  const msUntil3am = (() => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(3, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  })();
  setTimeout(() => {
    purgeExpiredPhotos();
    setInterval(purgeExpiredPhotos, 24 * 60 * 60 * 1000);
  }, msUntil3am);
}

module.exports = { startCronJobs };
