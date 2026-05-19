// Comprime un File/Blob de imagen a JPEG ≤200KB usando Canvas API.
// No requiere librerías externas. Funciona en Chrome/Safari/Firefox modernos.

const MAX_DIMENSION = 1280;  // px — legible para auditoría laboral
const JPEG_QUALITY  = 0.75;  // 75% — punto óptimo calidad/peso

export async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitDimensions(bitmap.width, bitmap.height);
  const blob = await drawToBlob(bitmap, width, height, JPEG_QUALITY);

  if (blob.size > 200_000) {
    const bitmap2 = await createImageBitmap(blob);
    return drawToBlob(bitmap2, width, height, JPEG_QUALITY * 0.8);
  }
  return blob;
}

// Dibuja bitmap en canvas y exporta como JPEG.
// Usa OffscreenCanvas si está disponible (Chrome/Firefox), si no usa <canvas> (iOS < 16.4).
function drawToBlob(bitmap, width, height, quality) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
  }

  // Fallback para iOS < 16.4
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width  = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error('Canvas toBlob failed')), 'image/jpeg', quality);
  });
}

function fitDimensions(w, h) {
  if (w <= MAX_DIMENSION && h <= MAX_DIMENSION) return { width: w, height: h };
  const ratio = Math.min(MAX_DIMENSION / w, MAX_DIMENSION / h);
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}
