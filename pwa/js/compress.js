// Comprime un File/Blob de imagen a JPEG ≤200KB usando Canvas API.
// No requiere librerías externas. Funciona en Chrome/Safari/Firefox modernos.

const MAX_DIMENSION = 1280;  // px — legible para auditoría laboral
const JPEG_QUALITY  = 0.75;  // 75% — punto óptimo calidad/peso

export async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitDimensions(bitmap.width, bitmap.height);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });

  if (blob.size > 200_000) {
    return compressBlob(blob, JPEG_QUALITY * 0.8);
  }
  return blob;
}

async function compressBlob(blob, quality) {
  const bitmap = await createImageBitmap(blob);
  const { width, height } = fitDimensions(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality });
}

function fitDimensions(w, h) {
  if (w <= MAX_DIMENSION && h <= MAX_DIMENSION) return { width: w, height: h };
  const ratio = Math.min(MAX_DIMENSION / w, MAX_DIMENSION / h);
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}
