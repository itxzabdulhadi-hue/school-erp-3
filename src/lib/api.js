export class ApiError extends Error {
  constructor(message, status, data = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export async function api(path, options = {}) {
  const { method = 'GET', body, headers = {}, ...rest } = options;
  const requestHeaders = new Headers(headers);
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    requestHeaders.set('Content-Type', 'application/json');
    payload = JSON.stringify(body);
  }
  requestHeaders.set('Accept', 'application/json');
  let response;
  try {
    response = await fetch(`/api${path.startsWith('/') ? path : `/${path}`}`, {
      method,
      headers: requestHeaders,
      body: payload,
      credentials: 'same-origin',
      ...rest,
    });
  } catch {
    throw new ApiError('We could not reach the server. Check your connection and try again.', 0);
  }
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json().catch(() => ({})) : null;
  if (!response.ok) throw new ApiError(data?.error || `Request failed (${response.status}).`, response.status, data || {});
  return data;
}

export async function download(path, fileName) {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(data.error || 'Unable to download this file.', response.status);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
