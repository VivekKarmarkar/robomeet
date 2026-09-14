export async function request(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(path, {method, headers: body === undefined ? {} : {'Content-Type':'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), credentials:'same-origin'});
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = {error: text.slice(0,200)}; }
  if (!response.ok) throw new Error(data.error?.message || data.error || data.message || `Request failed (${response.status})`);
  return data;
}
export const command = (type, values = {}) => request('/api/command', {type,...values});
export function subscribe(onState, onConnection) {
  const source = new EventSource('/api/events');
  source.addEventListener('state', event => {try {onState(JSON.parse(event.data));} catch(error) {console.error('State event:', error);}});
  source.onopen = () => onConnection(true);
  source.onerror = () => onConnection(false);
  return source;
}
