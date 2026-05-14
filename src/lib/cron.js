const prisma = require('./prisma');

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

function startCronJobs() {
  expirePhotoDeadlines();
  setInterval(expirePhotoDeadlines, 60 * 60 * 1000); // cada hora
}

module.exports = { startCronJobs };
