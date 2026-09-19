import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSSE, consumeConnection } from './sse.mjs';

async function* chunks(text, width = 1) {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += width) yield bytes.slice(i, i + width);
}
async function collect(body, options) {
  const results = []; for await (const e of decodeSSE(body, options)) results.push(e); return results;
}
test('chunked UTF-8, comments, CRLF, multiline fields and partial EOF', async () => {
  assert.deepEqual(await collect(chunks(': heartbeat\r\n\r\nid: 9\r\nevent: market\r\ndata: {"title":"goosé",\r\ndata: "v":1}\r\n\r\nid: unfinished\ndata: x')), [
    {id:'9',type:'market',data:'{"title":"goosé",\n"v":1}'}]);
});
test('bounds memory and rejects truncated UTF8', async () => {
  await assert.rejects(collect(chunks('data: '+ 'x'.repeat(100)), {maxBytes:32}), /size/);
  await assert.rejects(collect((async function*(){yield new Uint8Array([0xc3]);})()));
});
function response(text) { return new Response(text,{headers:{'content-type':'text/event-stream'}}); }
test('authorization, resume, duplicate receipt and checkpoint order', async () => {
  const seen=[];
  const cursor=await consumeConnection({url:'https://example.test/events',token:'secret',cursor:'4',
    fetchImpl:async (url,opts)=>{
      assert.equal(opts.headers.Authorization,'Bearer secret');
      assert.equal(opts.headers['Last-Event-ID'],'4'); assert.equal(opts.redirect,'error');
      return response('id: 4\ndata: {}\n\nid: 5\ndata: {"v":2}\n\n');
    }, onEvent:async e=>seen.push(['apply',e.id]), onCursor:async id=>seen.push(['save',id])});
  assert.equal(cursor,'5'); assert.deepEqual(seen,[['apply','5'],['save','5']]);
});
test('failed application does not acknowledge; malformed JSON fails closed', async () => {
  let saved=false;
  const base={url:'https://example.test/events',token:'secret',onCursor:async()=>{saved=true;}};
  await assert.rejects(consumeConnection({...base,fetchImpl:async()=>response('id: 1\ndata: {}\n\n'),
    onEvent:async()=>{throw new Error('sink failed');}}), /sink failed/);
  assert.equal(saved,false);
  await assert.rejects(consumeConnection({...base,fetchImpl:async()=>response('id: 1\ndata: bad\n\n'),onEvent:async()=>{}}));
  assert.equal(saved,false);
});
test('rejects HTTP auth failure and unsafe destination before sending', async () => {
  const base={token:'secret',onEvent:async()=>{},fetchImpl:async()=>new Response('',{status:401})};
  await assert.rejects(consumeConnection({...base,url:'https://example.test/events'}), /401/);
  await assert.rejects(consumeConnection({...base,url:'http://example.test/events'}), /HTTPS/);
  await assert.rejects(consumeConnection({...base,url:'https://example.test/events?token=x'}), /query/);
});
