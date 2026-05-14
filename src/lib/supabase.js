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
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list('tasks', { limit: 1000 });

  if (error) throw error;
  return data;
}

module.exports = { supabase, generateUploadUrl, generateViewUrl, deleteExpiredPhotos, BUCKET };
