
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if (q.ping) return { statusCode: 200, body: JSON.stringify({ ok:true, pong:true }) };
  if (q.config) return { statusCode: 200, body: JSON.stringify({ app:"SunwooBank", auth:true }) };
  if (q.pin) {
    if (q.pin === (process.env.TELLER_CODE || "0612")) {
      return { statusCode: 200, body: JSON.stringify({ ok:true, role:"teller" }) };
    }
    return { statusCode: 401, body: JSON.stringify({ ok:false }) };
  }
  return { statusCode: 200, body: JSON.stringify({ ok:true }) };
};
