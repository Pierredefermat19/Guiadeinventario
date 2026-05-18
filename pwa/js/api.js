const BASE = '';  // mismo origen que el servidor Express

function token() { return localStorage.getItem('shift_token'); }

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token() && { Authorization: `Bearer ${token()}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw Object.assign(new Error(err.error ?? 'Error de red'), { status: res.status, data: err });
  }
  return res.json();
}

export const api = {
  getWarehouseInfo: (wh)   => request('GET', `/api/warehouses/${wh}/info`),
  getStaff:      (wh)      => request('GET', `/api/warehouses/${wh}/staff`),
  pinLogin:      (body)    => request('POST', '/api/auth/pin', body),
  endShift:      ()        => request('POST', '/api/auth/pin/end'),
  changePin:     (body)    => request('POST', '/api/auth/change-pin', body),
  getTasks:      ()        => request('GET', '/api/tasks/today'),
  startTask:     (id)      => request('PATCH', `/api/tasks/${id}/start`),
  completeTask:  (id, body) => request('PATCH', `/api/tasks/${id}/complete`, body),
  getUploadUrl:  (id, type) => request('POST', `/api/tasks/${id}/photos/upload-url`, { type }),
  confirmPhoto:  (id, type, path) => request('POST', `/api/tasks/${id}/photos/confirm`, { type, path }),
  getMyHistory:  (limit = 30) => request('GET', `/api/tasks/my-history?limit=${limit}`),
  getTaskPhotos: (id)         => request('GET', `/api/tasks/${id}/photos`),

  uploadPhoto: async (signedUrl, blob) => {
    const res = await fetch(signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  },
};
