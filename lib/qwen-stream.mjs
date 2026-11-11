import { HttpError } from './core.mjs';

// Only these fixed transport codes may appear in a user-facing error. Never echo
// an upstream body, URL, exception message, prompt or API key.
const networkCodes = new Set(['ENOTFOUND','EAI_AGAIN','ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
const reconnectCodes = new Set(['UND_ERR_SOCKET','ECONNRESET','EPIPE']);
export function canReconnect(error) {
  return error instanceof IncompleteCompletionError || reconnectCodes.has(error?.code) || reconnectCodes.has(error?.cause?.code) || error?.cause?.name==='HTTPParserError';
}
export class IncompleteCompletionError extends HttpError {
  constructor(){super(502,'千问响应中途断开或未完整生成，本次未生成分析草稿，请重试。');}
}
export function transportError(error, signal, started, reconnected=false, phase='等待接口响应') {
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  const detail=`已等待 ${seconds} 秒，${phase}${reconnected?'，已自动重连1次':''}`;
  if (signal.aborted || error?.name === 'TimeoutError')
    return new HttpError(502, `千问本次调用超时（${detail}），请稍后重试；本次未生成分析草稿。`);
  const code = [error?.cause?.code, error?.code].find(value => networkCodes.has(value)) || (error?.cause?.name==='HTTPParserError'?'HTTP_PARSER_ERROR':null);
  return new HttpError(502, `服务器连接千问失败（${detail}${code ? '，网络错误 '+code : ''}），请稍后重试；本次未生成分析草稿。`);
}

// Consume SSE incrementally, preserving UTF-8 and JSON across arbitrary network
// chunk boundaries. Nothing is handed to validation until generation finishes.
export async function readCompletion(response) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json();
  if (!response.body) throw new HttpError(502, '千问返回了空的流式响应，请重试。');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', event = [], content = '', finished = false, done = false, size = 0;
  function dispatch() {
    if (!event.length) return;
    const text = event.join('\n'); event = [];
    if (text === '[DONE]') { done = true; return; }
    let data;
    try { data = JSON.parse(text); } catch { throw new HttpError(502, '千问流式响应格式无效，请重试。'); }
    if(!data||typeof data!=='object'||Array.isArray(data)||data.choices!==undefined&&(!Array.isArray(data.choices)||data.choices.some(item=>!item||typeof item!=='object')))
      throw new HttpError(502, '千问流式响应格式无效，请重试。');
    if (data.error) throw new HttpError(502, '千问在生成过程中返回错误，本次未生成分析草稿，请稍后重试。');
    const choice = data.choices?.find(item => item.index === 0 || item.index === undefined);
    if (choice?.finish_reason === 'length') throw new HttpError(502, '结果超过输出限制，请减少本次输入后重试。');
    if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new HttpError(502, '千问未完整生成结果，本次未生成分析草稿，请重试。');
    if (choice?.finish_reason === 'stop') finished = true;
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
  }
  function line(value) {
    value = value.replace(/\r$/, '');
    if (!value) dispatch();
    else if (value.startsWith('data:')) event.push(value.slice(5).replace(/^ /, ''));
  }
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) { pending += decoder.decode(); break; }
      size += chunk.value.byteLength;
      if (size > 4 * 1024 ** 2) throw new HttpError(502, '千问返回结果过大，请减少本次输入后重试。');
      pending += decoder.decode(chunk.value, { stream: true });
      let end;
      while (!done && (end = pending.indexOf('\n')) !== -1) {
        line(pending.slice(0, end)); pending = pending.slice(end + 1);
      }
    }
    if (!done) { if (pending) line(pending); dispatch(); }
    if (!finished) throw new IncompleteCompletionError();
    if (!content.trim()) throw new HttpError(502, '千问返回空的生成结果，本次未生成分析草稿，请重试。');
    return { choices: [{ finish_reason: 'stop', message: { content } }] };
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}
