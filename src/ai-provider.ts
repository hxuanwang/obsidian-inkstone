import { readVisionResponse, visionRequest } from './markdown';

/** Provider operations shared by settings and page conversion. Never return raw network errors. */
export function validateEndpoint(raw: string): string {
  let url: URL;
  try {url=new URL(raw.trim());} catch {throw new Error('Enter a valid Chat Completions endpoint.');}
  if(url.username||url.password||url.hash)throw new Error('Use an endpoint without embedded credentials or a fragment.');
  if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('Use HTTPS, or HTTP for a local provider.');
  return url.href;
}
export function modelsEndpoint(endpoint: string): string {
  const url=new URL(validateEndpoint(endpoint));
  if(!/\/chat\/completions\/?$/.test(url.pathname))throw new Error('Model discovery needs an endpoint ending in /chat/completions. You can also enter a model ID manually.');
  url.pathname=url.pathname.replace(/\/chat\/completions\/?$/,'/models');
  return url.href;
}
export interface ProviderConfig {aiEndpoint:string;aiModel:string;aiKey:string}
export interface ProviderRequest {url:string;method:string;headers:Record<string,string>;body?:string;throw:false}
export type ProviderTransport=(request:ProviderRequest)=>Promise<{status:number;json:unknown}>;
class ProviderError extends Error {}
async function providerRequest(request:ProviderRequest,transport:ProviderTransport,signal?:AbortSignal,timeoutMs=30_000):Promise<unknown> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  let abort: (()=>void)|undefined;
  try {
    if(signal?.aborted)throw new ProviderError('Provider request closed.');
    const stopped=new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new ProviderError('The provider timed out. Try again or check the endpoint. It may still be processing the request.')),timeoutMs);
      abort=()=>reject(new ProviderError('Provider request closed.'));
      signal?.addEventListener('abort',abort,{once:true});
    });
    const response=await Promise.race([
      transport(request),
      stopped,
    ]);
    if(!Number.isInteger(response.status)||response.status<100||response.status>599)throw new ProviderError('The provider returned an invalid HTTP response. Check the endpoint.');
    if(response.status<200||response.status>=300)throw new ProviderError(`Provider returned HTTP ${response.status}. Check the endpoint, API key, and model.`);
    return response.json;
  } catch(error) {
    if(error instanceof ProviderError)throw error;
    throw new Error('Could not reach the provider or read its response. Check your connection and endpoint.');
  } finally {clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);}
}
function headers(config:ProviderConfig):Record<string,string> {
  return {'Content-Type':'application/json',...(config.aiKey.trim()?{Authorization:`Bearer ${config.aiKey.trim()}`}:{})};
}
export function readModels(value:unknown):string[] {
  const data=(value as {data?:unknown})?.data;
  if(!Array.isArray(data))throw new Error('The provider did not return a compatible model list. Enter a model ID manually.');
  const models=[...new Set(data.flatMap(item=>typeof item?.id==='string' && item.id.trim() && item.id.length<=256 ? [item.id.trim()]:[]))].sort();
  if(!models.length)throw new Error('No models were returned. Enter a model ID manually.');
  return models;
}
export async function fetchModels(config:ProviderConfig,transport:ProviderTransport,signal?:AbortSignal):Promise<string[]> {
  const url=modelsEndpoint(config.aiEndpoint);
  return readModels(await providerRequest({url,method:'GET',headers:headers(config),throw:false},transport,signal));
}
// A 64×64 grayscale PNG of “OK” exercises the same image_url format as transcription.
const TEST_IMAGE='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAAAAACPAi4CAAAAUElEQVR4nO3SMQ4AIAhDUe5/aZ1MiIKJURf6O0J5E9YuYwAAAACfAHPxs7lTFciKO0wNWI+1gPhYC4j2ikCM1AJGYX6cDK4KnAcAAADgGdABQuwSs30Tm+UAAAAASUVORK5CYII=';
export async function testProvider(config:ProviderConfig,transport:ProviderTransport,signal?:AbortSignal):Promise<void> {
  const url=validateEndpoint(config.aiEndpoint);
  if(!config.aiModel.trim())throw new Error('Choose or enter a vision model first.');
  const body=JSON.stringify({model:config.aiModel.trim(),messages:[{role:'user',content:[{type:'text',text:'This is a connection test. Briefly describe the sample image.'},{type:'image_url',image_url:{url:TEST_IMAGE}}]}]});
  const result=await providerRequest({url,method:'POST',headers:headers(config),body,throw:false},transport,signal);
  try {readVisionResponse(result);} catch {throw new Error('The provider responded, but did not return compatible text for the image test. Check the vision model.');}
}
export async function transcribeImage(config:ProviderConfig,image:string,instructions:string,transport:ProviderTransport,signal?:AbortSignal):Promise<string> {
  const url=validateEndpoint(config.aiEndpoint);
  if(!config.aiModel.trim())throw new Error('Choose or enter a vision model first.');
  const body=JSON.stringify(visionRequest(config.aiModel.trim(),image,instructions));
  return readVisionResponse(await providerRequest({url,method:'POST',headers:headers(config),body,throw:false},transport,signal,120_000));
}
