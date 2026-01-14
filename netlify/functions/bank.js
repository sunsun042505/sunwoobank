import { getStore } from '@netlify/blobs';
export async function handler(event, context){
 if(event.queryStringParameters?.ping==='1') return {statusCode:200, body:'pong'};
 const body=JSON.parse(event.body||'{}');
 if(body.action?.startsWith('teller') && body.payload?.tellerCode!=='0612')
   return {statusCode:403, body:'forbidden'};
 const store=getStore('sunwoobank');
 await store.set('db.json', JSON.stringify({updated:Date.now()}));
 return {statusCode:200, body:'ok'};
}
