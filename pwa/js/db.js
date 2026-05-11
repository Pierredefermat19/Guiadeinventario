// Almacenamiento local para fotos pendientes de subir.
// Las fotos entran aquí cuando el auxiliar está offline.

const DB_NAME    = 'bodega-offline';
const DB_VERSION = 1;
const STORE      = 'pending-photos';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function savePendingPhoto({ taskId, type, blob, uploadUrl }) {
  const db    = await open();
  const tx    = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = store.add({ taskId, type, blob, uploadUrl, savedAt: Date.now() });
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function getPendingPhotos() {
  const db    = await open();
  const tx    = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function deletePendingPhoto(id) {
  const db    = await open();
  const tx    = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

export async function countPending() {
  const photos = await getPendingPhotos();
  return photos.length;
}
