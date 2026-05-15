const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'task-photos';
const RETENTION_DAYS = 180;

async function generateUploadUrl(taskId, type) {
  const path = `tasks/${taskId}/${type}-${Date.now()}.jpg`;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(path, { expiresIn: 300 });

  if (error) throw error;
  return { signedUrl: data.signedUrl, path };
}

async function generateViewUrl(path, expiresIn = 3600) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

async function deleteExpiredPhotos(olderThanDays = RETENTION_DAYS) {
  const prisma = require('./prisma');

  const cutoff = new Date();
  try {
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    // Fotos confirmadas cuya tarea fue completada antes del cutoff
    const expired = await prisma.taskPhoto.findMany({
      where: {
        task: { completedAt: { lt: cutoff } },
        url: { not: { startsWith: 'pending:' } },
      },
      select: { id: true, url: true },
    });

    // Registros pending: sin confirmar hace más de 7 días (upload nunca llegó)
    const pendingCutoff = new Date();
    pendingCutoff.setDate(pendingCutoff.getDate() - 7);
    const stalePending = await prisma.taskPhoto.findMany({
      where: {
        url: { startsWith: 'pending:' },
        task: { completedAt: { lt: pendingCutoff } },
      },
      select: { id: true, url: true },
    });

    const allRecords = [...expired, ...stalePending];
    if (allRecords.length === 0) return { deleted: 0 };

    // Eliminar de Supabase Storage (solo los que no son pending)
    const storagePaths = expired.map((p) => p.url);
    if (storagePaths.length > 0) {
      const CHUNK = 100;
      for (let i = 0; i < storagePaths.length; i += CHUNK) {
        await supabase.storage.from(BUCKET).remove(storagePaths.slice(i, i + CHUNK));
      }
    }

    // Eliminar registros de BD
    const ids = allRecords.map((p) => p.id);
    await prisma.taskPhoto.deleteMany({ where: { id: { in: ids } } });

    return { deleted: allRecords.length };
  } catch (err) {
    throw err;
  }
}

module.exports = { supabase, generateUploadUrl, generateViewUrl, deleteExpiredPhotos, BUCKET };
