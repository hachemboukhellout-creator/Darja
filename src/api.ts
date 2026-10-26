let csrfToken = '';
export function setCsrf(value:string) {csrfToken=value;}
export async function api<T>(url:string,options:RequestInit={}):Promise<T> {
  const response = await fetch(`/api${url}`,{...options,credentials:'same-origin',headers:{'Content-Type':'application/json',...(csrfToken?{'X-CSRF-Token':csrfToken}:{}),...options.headers}});
  const result = await response.json().catch(()=>({error:'The server returned an unexpected response.'}));
  if(!response.ok) throw new Error(result.error || 'Something went wrong. Please try again.');
  return result as T;
}
