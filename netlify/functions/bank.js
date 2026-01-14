
const { getStore } = require("@netlify/blobs");

function json(res, statusCode=200){
  return {
    statusCode,
    headers: {
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store"
    },
    body: JSON.stringify(res)
  };
}

function text(body, statusCode=200){
  return { statusCode, headers: {"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}, body };
}

function now(){ return Date.now(); }

function b64urlDecode(str){
  str = str.replace(/-/g,'+').replace(/_/g,'/');
  while(str.length % 4) str += '=';
  return Buffer.from(str,'base64').toString('utf8');
}

function parseJwtEmail(auth){
  if(!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if(!m) return null;
  const token = m[1];
  const parts = token.split('.');
  if(parts.length < 2) return null;
  try{
    const payload = JSON.parse(b64urlDecode(parts[1]));
    // Netlify Identity typically sets email in 'email'
    const email = payload.email || payload?.user_metadata?.email;
    const sub = payload.sub;
    return { email, sub, payload };
  }catch(e){
    return null;
  }
}

function normalizeAcct(no){
  return (no||'').replace(/\s/g,'');
}

function mkCustomerId(db){
  const n = (db.meta?.seqCustomer || 1000) + 1;
  db.meta.seqCustomer = n;
  return `C-${n}`;
}

function mkAccountNo(db){
  const a = (db.meta?.seqAccount || 100000) + 1;
  db.meta.seqAccount = a;
  // simple bank-like format
  const mid = String(a).padStart(6,'0');
  return `110-${mid.slice(0,3)}-${mid.slice(3)}`;
}

function findCustomerByWho(db, who){
  const q = (who||'').trim().toLowerCase();
  if(!q) return null;
  return db.customers.find(c =>
    (c.id||'').toLowerCase()===q ||
    (c.email||'').toLowerCase()===q ||
    (c.name||'').toLowerCase()===q
  ) || null;
}

async function loadDB(store){
  const raw = await store.get("db.json");
  if(raw){
    try{ return JSON.parse(raw) }catch(e){}
  }
  // init
  const db = {
    meta: { createdAt: now(), updatedAt: now(), seqCustomer: 1000, seqAccount: 100000 },
    customers: [],
    accounts: [],
    products: [],
    reports: [],
    transactions: []
  };
  await store.set("db.json", JSON.stringify(db));
  return db;
}

async function saveDB(store, db){
  db.meta.updatedAt = now();
  await store.set("db.json", JSON.stringify(db));
}

function requireTeller(event){
  const code = (event.headers["x-teller-code"] || event.headers["X-Teller-Code"] || "").trim();
  if(code !== "0612") return { ok:false, error:"텔러 코드(0612) 필요" };
  return { ok:true, code };
}

exports.handler = async (event, context) => {
  // ping
  if(event.httpMethod === "GET" && event.queryStringParameters && event.queryStringParameters.ping === "1"){
    return text("pong", 200);
  }

  if(event.httpMethod !== "POST"){
    return json({ error: "POST only" }, 405);
  }

  let body = {};
  try{ body = JSON.parse(event.body || "{}"); }catch(e){ return json({ error:"JSON 파싱 실패" }, 400); }
  const action = body.action || "";
  const payload = body.payload || {};

  const store = getStore("sunwoobank");
  const db = await loadDB(store);

  // Teller actions
  if(action.startsWith("teller")){
    const t = requireTeller(event);
    if(!t.ok) return json({ error: t.error }, 403);

    if(action === "tellerAuth"){
      return json({ ok:true, role:"teller" });
    }

    if(action === "tellerGetAll"){
      // return full db (trim some if huge)
      return json({ db });
    }

    if(action === "tellerCreateCustomer"){
      const name = (payload.name||"").trim();
      const email = (payload.email||"").trim().toLowerCase();
      if(!name) return json({ error:"이름이 필요" }, 400);

      // upsert by email if exists
      let customer = email ? db.customers.find(c => (c.email||"").toLowerCase() === email) : null;
      if(!customer){
        const id = mkCustomerId(db);
        customer = { id, name, email: email||"", createdAt: now(), primaryAccount:"" };
        db.customers.push(customer);
      }else{
        customer.name = name || customer.name;
        if(email) customer.email = email;
      }

      // create primary account if none
      let accountNo = customer.primaryAccount;
      if(!accountNo){
        accountNo = mkAccountNo(db);
        db.accounts.push({
          no: accountNo,
          customerId: customer.id,
          type: "입출금",
          balance: 0,
          status: "정상",
          openedAt: now()
        });
        customer.primaryAccount = accountNo;
      }

      db.transactions.push({
        ts: now(),
        kind: "TEL_CREATE",
        desc: `고객 생성: ${customer.id} (${customer.name})`,
        amount: 0,
        ref: { customerId: customer.id }
      });

      await saveDB(store, db);
      return json({ customerId: customer.id, accountNo });
    }

    if(action === "tellerCash"){
      const accountNo = normalizeAcct(payload.accountNo);
      const amount = Number(payload.amount);
      const kind = payload.kind;
      const memo = (payload.memo||"").trim();
      if(!accountNo) return json({ error:"계좌번호 필요" }, 400);
      if(!amount || amount<=0) return json({ error:"금액 오류" }, 400);
      if(!["deposit","withdraw"].includes(kind)) return json({ error:"업무 종류 오류" }, 400);

      const acct = db.accounts.find(a=>a.no===accountNo);
      if(!acct) return json({ error:"계좌를 찾을 수 없음" }, 404);
      if(acct.status!=="정상") return json({ error:"계좌 상태가 정상 아님" }, 400);

      if(kind==="withdraw" && acct.balance < amount) return json({ error:"잔액 부족" }, 400);

      acct.balance += (kind==="deposit" ? amount : -amount);

      db.transactions.push({
        ts: now(),
        kind: kind==="deposit" ? "TEL_DEPOSIT" : "TEL_WITHDRAW",
        desc: `${kind==="deposit"?"입금":"출금"} · ${accountNo}${memo?(" · "+memo):""}`,
        amount: kind==="deposit" ? amount : -amount,
        ref: { accountNo }
      });

      await saveDB(store, db);
      return json({ ok:true, balance: acct.balance });
    }

    if(action === "tellerTransfer"){
      const from = normalizeAcct(payload.from);
      const to = normalizeAcct(payload.to);
      const amount = Number(payload.amount);
      const memo = (payload.memo||"").trim();
      if(!from||!to) return json({ error:"계좌번호 필요" }, 400);
      if(from===to) return json({ error:"동일 계좌" }, 400);
      if(!amount||amount<=0) return json({ error:"금액 오류" }, 400);

      const aFrom = db.accounts.find(a=>a.no===from);
      const aTo = db.accounts.find(a=>a.no===to);
      if(!aFrom) return json({ error:"출금 계좌 없음" }, 404);
      if(!aTo) return json({ error:"입금 계좌 없음" }, 404);
      if(aFrom.status!=="정상" || aTo.status!=="정상") return json({ error:"계좌 상태 오류" }, 400);
      if(aFrom.balance < amount) return json({ error:"잔액 부족" }, 400);

      aFrom.balance -= amount;
      aTo.balance += amount;

      db.transactions.push({
        ts: now(),
        kind: "TEL_TRANSFER",
        desc: `이체 ${from} → ${to}${memo?(" · "+memo):""}`,
        amount: -amount,
        ref: { from, to }
      });
      db.transactions.push({
        ts: now(),
        kind: "TEL_TRANSFER_IN",
        desc: `입금 ${from} → ${to}${memo?(" · "+memo):""}`,
        amount: amount,
        ref: { from, to }
      });

      await saveDB(store, db);
      return json({ ok:true });
    }

    if(action === "tellerEnrollProduct"){
      const who = (payload.who||"").trim();
      const type = (payload.type||"").trim();
      const amount = Number(payload.amount);
      const months = Number(payload.months);
      const memo = (payload.memo||"").trim();

      const customer = findCustomerByWho(db, who);
      if(!customer) return json({ error:"고객을 찾을 수 없음" }, 404);
      if(!type) return json({ error:"상품 종류 필요" }, 400);
      if(!amount || amount<=0) return json({ error:"금액 오류" }, 400);
      if(!months || months<=0) return json({ error:"기간 오류" }, 400);

      const id = `P-${db.products.length+1}`;
      db.products.push({ id, customerId: customer.id, type, amount, months, memo, ts: now() });

      db.transactions.push({
        ts: now(),
        kind: "PRODUCT",
        desc: `상품가입(${type}) · ${customer.id}${memo?(" · "+memo):""}`,
        amount: 0,
        ref: { customerId: customer.id, productId: id }
      });

      await saveDB(store, db);
      return json({ ok:true, productId: id });
    }

    if(action === "tellerReport"){
      const who = (payload.who||"").trim();
      const text = (payload.text||"").trim();
      const customer = findCustomerByWho(db, who);
      if(!customer) return json({ error:"고객을 찾을 수 없음" }, 404);
      if(!text) return json({ error:"내용 필요" }, 400);

      const id = `R-${db.reports.length+1}`;
      db.reports.push({ id, customerId: customer.id, text, ts: now() });

      db.transactions.push({
        ts: now(),
        kind: "REPORT",
        desc: `제신고/정정 · ${customer.id}`,
        amount: 0,
        ref: { customerId: customer.id, reportId: id }
      });

      await saveDB(store, db);
      return json({ ok:true, reportId: id });
    }

    if(action === "tellerCreateIdentityUser"){
      // B 방식: admin/users 즉시 생성 (Invite-only에서도 가능)
      const name = (payload.name||"").trim();
      const email = (payload.email||"").trim().toLowerCase();
      const password = (payload.password||"");
      if(!name||!email||!password) return json({ error:"이름/이메일/비밀번호 필요" }, 400);

      // ensure customer exists / update email mapping
      let customer = db.customers.find(c => (c.email||"").toLowerCase() === email);
      if(!customer){
        const id = mkCustomerId(db);
        customer = { id, name, email, createdAt: now(), primaryAccount:"" };
        db.customers.push(customer);
      }else{
        customer.name = name || customer.name;
        customer.email = email;
      }
      if(!customer.primaryAccount){
        const accountNo = mkAccountNo(db);
        db.accounts.push({
          no: accountNo, customerId: customer.id, type:"입출금", balance:0, status:"정상", openedAt: now()
        });
        customer.primaryAccount = accountNo;
      }

      const adminToken = process.env.IDENTITY_ADMIN_TOKEN;
      if(!adminToken){
        await saveDB(store, db);
        return json({
          error: "IDENTITY_ADMIN_TOKEN 환경변수가 설정되지 않았습니다. (Netlify → Site settings → Environment variables)",
          hint: "고객/계좌는 DB에 생성되었지만, Identity 계정 생성은 실패했습니다.",
          email
        }, 500);
      }

      const apiUrl = (process.env.GOTRUE_API_URL || "").trim();
      // Netlify 환경에서는 보통 GOTRUE_API_URL이 제공됨. 없으면 사이트 기본 경로로 유추.
      const baseUrl = apiUrl || `https://${process.env.URL || ""}/.netlify/identity`;
      const endpoint = baseUrl.replace(/\/$/,'') + "/admin/users";

      // Create identity user
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + adminToken
        },
        body: JSON.stringify({
          email,
          password,
          user_metadata: {
            name,
            customer_id: customer.id
          }
        })
      });

      const txt = await resp.text();
      let out = null;
      try{ out = JSON.parse(txt); }catch(e){ out = { raw: txt }; }

      if(!resp.ok){
        await saveDB(store, db);
        return json({
          error: "Identity 계정 생성 실패",
          status: resp.status,
          detail: out
        }, 500);
      }

      db.transactions.push({
        ts: now(),
        kind: "IB_ENROLL",
        desc: `인터넷뱅킹 가입 · ${customer.id} · ${email}`,
        amount: 0,
        ref: { customerId: customer.id, email }
      });

      await saveDB(store, db);
      return json({ ok:true, email, customerId: customer.id });
    }

    return json({ error:"알 수 없는 teller action" }, 400);
  }

  // Customer actions (require netlify identity token)
  const user = parseJwtEmail(event.headers.authorization || event.headers.Authorization);
  if(!user || !user.email){
    return json({ error:"로그인이 필요합니다." }, 401);
  }
  const email = (user.email||"").toLowerCase();

  const customer = db.customers.find(c => (c.email||"").toLowerCase() === email);
  if(!customer){
    return json({ error:"등록된 고객 정보가 없습니다. 창구에서 인터넷뱅킹 가입/연동을 진행하세요." }, 403);
  }

  if(action === "customerGetMy"){
    const accounts = db.accounts.filter(a => a.customerId === customer.id);
    // transactions: include ones referencing their accounts or customerId
    const acctNos = new Set(accounts.map(a=>a.no));
    const tx = db.transactions
      .filter(x => (x.ref?.customerId === customer.id) ||
                  (x.ref?.accountNo && acctNos.has(x.ref.accountNo)) ||
                  (x.ref?.from && (acctNos.has(x.ref.from) || acctNos.has(x.ref.to))))
      .slice().reverse().slice(0, 30);
    return json({ customer: { id: customer.id, name: customer.name, email: customer.email }, accounts, transactions: tx });
  }

  if(action === "customerTransfer"){
    const from = normalizeAcct(payload.from);
    const to = normalizeAcct(payload.to);
    const amount = Number(payload.amount);
    const memo = (payload.memo||"").trim();
    if(!from||!to) return json({ error:"계좌번호 필요" }, 400);
    if(!amount||amount<=0) return json({ error:"금액 오류" }, 400);

    const aFrom = db.accounts.find(a=>a.no===from);
    const aTo = db.accounts.find(a=>a.no===to);
    if(!aFrom) return json({ error:"출금 계좌 없음" }, 404);
    if(!aTo) return json({ error:"입금 계좌 없음" }, 404);
    if(aFrom.customerId !== customer.id) return json({ error:"내 계좌만 출금 가능합니다." }, 403);
    if(aFrom.balance < amount) return json({ error:"잔액 부족" }, 400);
    if(aFrom.status!=="정상" || aTo.status!=="정상") return json({ error:"계좌 상태 오류" }, 400);

    aFrom.balance -= amount;
    aTo.balance += amount;

    db.transactions.push({
      ts: now(),
      kind: "CUST_TRANSFER",
      desc: `고객이체 ${from} → ${to}${memo?(" · "+memo):""}`,
      amount: -amount,
      ref: { from, to, customerId: customer.id }
    });
    db.transactions.push({
      ts: now(),
      kind: "CUST_TRANSFER_IN",
      desc: `입금 ${from} → ${to}${memo?(" · "+memo):""}`,
      amount: amount,
      ref: { from, to }
    });

    await saveDB(store, db);
    return json({ ok:true });
  }

  return json({ error:"알 수 없는 customer action" }, 400);
};
