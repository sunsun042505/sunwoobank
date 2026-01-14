const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");
const https = require("https");

function jsonRes(statusCode, obj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    },
    body: JSON.stringify(obj),
  };
}

function nowISO() {
  return new Date().toISOString();
}

function safeParseJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

async function readDB(store) {
  const raw = await store.get("db.json");
  if (!raw) return { meta: { createdAt: nowISO(), updatedAt: nowISO(), version: 5 }, customers: {}, accounts: {}, txs: [], jeSingo: [], identity: { emailToCustomerId: {} } };
  return safeParseJson(raw, { meta: { createdAt: nowISO(), updatedAt: nowISO(), version: 5 }, customers: {}, accounts: {}, txs: [], jeSingo: [], identity: { emailToCustomerId: {} } });
}

async function writeDB(store, db) {
  db.meta = db.meta || {};
  db.meta.updatedAt = nowISO();
  db.meta.version = 5;
  await store.set("db.json", JSON.stringify(db));
}

function genId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

function requireTeller(event) {
  const code = (event.headers["x-teller-code"] || event.headers["X-Teller-Code"] || "").toString().trim();
  if (code !== "0612") return false;
  return true;
}

function getNetlifyUser(context) {
  // Netlify passes user info here when Identity JWT is provided.
  // Prefer official context.user.
  const u = context?.clientContext?.user;
  if (u && (u.sub || u.email)) return u;

  // Some deployments provide base64 JSON here.
  const custom = context?.clientContext?.custom?.netlify;
  if (custom) {
    try {
      const decoded = JSON.parse(Buffer.from(custom, "base64").toString("utf8"));
      if (decoded && decoded.user) return decoded.user;
    } catch {}
  }
  return null;
}

function httpsRequestJson({ hostname, path, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        resolve({ status: res.statusCode || 0, body: data });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function createIdentityUser({ siteUrl, adminToken, email, password, fullName }) {
  // Netlify Identity admin endpoint (GoTrue admin/users)
  // Uses admin token from env: IDENTITY_ADMIN_TOKEN
  const url = new URL(siteUrl);
  const hostname = url.hostname;
  const payload = JSON.stringify({
    email,
    password,
    user_metadata: { full_name: fullName }
  });

  const res = await httpsRequestJson({
    hostname,
    path: "/.netlify/identity/admin/users",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      "authorization": `Bearer ${adminToken}`,
      "content-length": Buffer.byteLength(payload)
    },
    body: payload
  });

  return res;
}

exports.handler = async function handler(event, context) {
  try {
    // ping
    if (event.httpMethod === "GET" && event.queryStringParameters && event.queryStringParameters.ping === "1") {
      return { statusCode: 200, headers: { "cache-control": "no-store" }, body: "pong" };
    }

    const store = getStore("sunwoobank");
    const body = safeParseJson(event.body || "{}", {});
    const action = (body.action || "").toString();
    const payload = body.payload || {};

    // Basic routing: customer actions require Identity JWT; teller actions require x-teller-code 0612.
    const isTellerAction = action.startsWith("teller.") || action.startsWith("jeSingo.") || action.startsWith("admin.");
    const isCustomerAction = action.startsWith("customer.");

    if (!action) return jsonRes(400, { ok: false, error: "missing_action" });

    // Auth checks
    if (isTellerAction && !requireTeller(event)) {
      return jsonRes(403, { ok: false, error: "teller_forbidden" });
    }

    let user = null;
    if (isCustomerAction) {
      user = getNetlifyUser(context);
      if (!user || !user.email) return jsonRes(401, { ok: false, error: "unauthorized" });
    }

    // Load DB
    const db = await readDB(store);

    // Helpers
    function ensureCustomerForEmail(email) {
      const map = db.identity?.emailToCustomerId || (db.identity = { emailToCustomerId: {} }).emailToCustomerId;
      if (map[email]) return map[email];

      const cid = `C-${String(Object.keys(db.customers).length + 1001)}`;
      db.customers[cid] = {
        id: cid,
        name: email.split("@")[0],
        email,
        phone: "",
        createdAt: nowISO(),
        updatedAt: nowISO()
      };
      // Auto account
      const accId = genId("A");
      const acctNo = `110-${Math.floor(1000 + Math.random()*9000)}-${Math.floor(1000 + Math.random()*9000)}`;
      db.accounts[accId] = {
        id: accId,
        customerId: cid,
        accountNo: acctNo,
        type: "입출금",
        status: "정상",
        balance: 150000,
        flags: { paymentStop: false, seizure: false, provisionalSeizure: false },
        holds: [],
        createdAt: nowISO(),
        updatedAt: nowISO()
      };
      map[email] = cid;
      return cid;
    }

    function findAccountByNo(accountNo) {
      const acc = Object.values(db.accounts).find(a => a.accountNo === accountNo);
      return acc || null;
    }

    function addTx({ kind, amount, fromAccId, toAccId, memo }) {
      const tx = {
        id: genId("T"),
        kind, // 입금/출금/이체
        amount,
        fromAccId: fromAccId || null,
        toAccId: toAccId || null,
        memo: memo || "",
        at: nowISO()
      };
      db.txs.unshift(tx);
      return tx;
    }

    // -------- Customer actions --------
    if (action === "customer.bootstrap") {
      const cid = ensureCustomerForEmail(user.email);
      const accounts = Object.values(db.accounts).filter(a => a.customerId === cid).map(a => ({
        id: a.id, accountNo: a.accountNo, type: a.type, status: a.status, balance: a.balance, flags: a.flags
      }));
      const txs = db.txs.filter(tx => {
        const ids = new Set(accounts.map(a => a.id));
        return ids.has(tx.fromAccId) || ids.has(tx.toAccId);
      }).slice(0, 30);
      await writeDB(store, db);
      return jsonRes(200, { ok: true, customerId: cid, accounts, txs });
    }

    if (action === "customer.transfer") {
      const { fromAccountNo, toAccountNo, amount, memo } = payload;
      const amt = Number(amount);
      if (!fromAccountNo || !toAccountNo || !Number.isFinite(amt) || amt <= 0) return jsonRes(400, { ok:false, error:"bad_request" });

      const cid = ensureCustomerForEmail(user.email);
      const from = findAccountByNo(fromAccountNo);
      const to = findAccountByNo(toAccountNo);
      if (!from || !to) return jsonRes(404, { ok:false, error:"account_not_found" });
      if (from.customerId !== cid) return jsonRes(403, { ok:false, error:"not_owner" });

      // blocks
      if (from.flags?.paymentStop) return jsonRes(409, { ok:false, error:"payment_stopped" });
      if (from.status !== "정상") return jsonRes(409, { ok:false, error:"account_blocked" });

      if (from.balance < amt) return jsonRes(409, { ok:false, error:"insufficient" });

      from.balance -= amt;
      to.balance += amt;
      from.updatedAt = nowISO();
      to.updatedAt = nowISO();
      const tx = addTx({ kind: "이체", amount: amt, fromAccId: from.id, toAccId: to.id, memo });
      await writeDB(store, db);
      return jsonRes(200, { ok:true, tx });
    }

    // -------- Teller actions --------
    if (action === "teller.ping") {
      return jsonRes(200, { ok:true, pong:true, at: nowISO() });
    }

    if (action === "teller.list") {
      const customers = Object.values(db.customers).slice(0, 200);
      const accounts = Object.values(db.accounts).slice(0, 500);
      const jeSingo = db.jeSingo.slice(0, 200);
      await writeDB(store, db);
      return jsonRes(200, { ok:true, customers, accounts, jeSingo, txs: db.txs.slice(0, 50) });
    }

    if (action === "teller.createCustomer") {
      const { name, phone, email } = payload;
      if (!name) return jsonRes(400, { ok:false, error:"name_required" });
      const cid = `C-${String(Object.keys(db.customers).length + 1001)}`;
      db.customers[cid] = { id: cid, name, phone: phone||"", email: email||"", createdAt: nowISO(), updatedAt: nowISO() };
      if (email) (db.identity?.emailToCustomerId || (db.identity = { emailToCustomerId: {} }).emailToCustomerId)[email] = cid;
      await writeDB(store, db);
      return jsonRes(200, { ok:true, customer: db.customers[cid] });
    }

    if (action === "teller.createAccount") {
      const { customerId, type, initialBalance, accountNo } = payload;
      if (!customerId || !db.customers[customerId]) return jsonRes(404, { ok:false, error:"customer_not_found" });
      const accId = genId("A");
      const acctNo = accountNo || `110-${Math.floor(1000 + Math.random()*9000)}-${Math.floor(1000 + Math.random()*9000)}`;
      db.accounts[accId] = {
        id: accId,
        customerId,
        accountNo: acctNo,
        type: type || "입출금",
        status: "정상",
        balance: Number(initialBalance)||0,
        flags: { paymentStop: false, seizure: false, provisionalSeizure: false },
        holds: [],
        createdAt: nowISO(),
        updatedAt: nowISO()
      };
      await writeDB(store, db);
      return jsonRes(200, { ok:true, account: db.accounts[accId] });
    }

    if (action === "teller.cashInOut") {
      const { accountNo, kind, amount, memo } = payload;
      const acc = findAccountByNo(accountNo);
      const amt = Number(amount);
      if (!acc || !Number.isFinite(amt) || amt <= 0) return jsonRes(400, { ok:false, error:"bad_request" });
      if (acc.flags?.paymentStop && (kind === "출금" || kind === "이체")) return jsonRes(409, { ok:false, error:"payment_stopped" });
      if (acc.status !== "정상") return jsonRes(409, { ok:false, error:"account_blocked" });

      if (kind === "입금") acc.balance += amt;
      else if (kind === "출금") {
        if (acc.balance < amt) return jsonRes(409, { ok:false, error:"insufficient" });
        acc.balance -= amt;
      } else return jsonRes(400, { ok:false, error:"bad_kind" });

      acc.updatedAt = nowISO();
      const tx = addTx({ kind, amount: amt, toAccId: kind==="입금"?acc.id:null, fromAccId: kind==="출금"?acc.id:null, memo });
      await writeDB(store, db);
      return jsonRes(200, { ok:true, tx, balance: acc.balance });
    }

    if (action === "teller.transfer") {
      const { fromAccountNo, toAccountNo, amount, memo } = payload;
      const amt = Number(amount);
      const from = findAccountByNo(fromAccountNo);
      const to = findAccountByNo(toAccountNo);
      if (!from || !to || !Number.isFinite(amt) || amt <= 0) return jsonRes(400, { ok:false, error:"bad_request" });

      if (from.flags?.paymentStop) return jsonRes(409, { ok:false, error:"payment_stopped" });
      if (from.status !== "정상") return jsonRes(409, { ok:false, error:"account_blocked" });
      if (from.balance < amt) return jsonRes(409, { ok:false, error:"insufficient" });

      from.balance -= amt;
      to.balance += amt;
      from.updatedAt = nowISO(); to.updatedAt = nowISO();
      const tx = addTx({ kind:"이체", amount: amt, fromAccId: from.id, toAccId: to.id, memo });
      await writeDB(store, db);
      return jsonRes(200, { ok:true, tx });
    }

    // ---------- JeSingo (제신고/사고/변경 + 압류/가압류/지급정지) ----------
    if (action === "jeSingo.create") {
      const { customerId, accountNo, type, detail, memo, holdAmount } = payload;
      if (!type) return jsonRes(400, { ok:false, error:"type_required" });
      const acc = accountNo ? findAccountByNo(accountNo) : null;
      const js = {
        id: genId("JS"),
        customerId: customerId || (acc ? acc.customerId : null),
        accountNo: accountNo || null,
        type, // 주소변경/연락처변경/분실/압류/가압류/지급정지/해제 등
        detail: detail || "",
        memo: memo || "",
        holdAmount: holdAmount ? Number(holdAmount) : null,
        status: "접수",
        createdAt: nowISO(),
        processedAt: null
      };
      db.jeSingo.unshift(js);

      // Apply immediate effects for special types
      if (acc) {
        if (type === "지급정지") {
          acc.flags.paymentStop = true;
        }
        if (type === "압류") {
          acc.flags.seizure = true;
          if (js.holdAmount && js.holdAmount > 0) acc.holds.push({ kind:"압류", amount: js.holdAmount, at: nowISO(), ref: js.id });
        }
        if (type === "가압류") {
          acc.flags.provisionalSeizure = true;
          if (js.holdAmount && js.holdAmount > 0) acc.holds.push({ kind:"가압류", amount: js.holdAmount, at: nowISO(), ref: js.id });
        }
        acc.updatedAt = nowISO();
      }

      await writeDB(store, db);
      return jsonRes(200, { ok:true, jeSingo: js, account: acc ? { accountNo: acc.accountNo, flags: acc.flags, holds: acc.holds } : null });
    }

    if (action === "jeSingo.process") {
      const { id, status, memo } = payload;
      const js = db.jeSingo.find(x => x.id === id);
      if (!js) return jsonRes(404, { ok:false, error:"not_found" });
      js.status = status || "처리";
      js.memo = memo || js.memo;
      js.processedAt = nowISO();

      const acc = js.accountNo ? findAccountByNo(js.accountNo) : null;
      if (acc && (js.type === "지급정지해제" || js.type === "압류해제" || js.type === "가압류해제")) {
        if (js.type === "지급정지해제") acc.flags.paymentStop = false;
        if (js.type === "압류해제") { acc.flags.seizure = false; acc.holds = acc.holds.filter(h => h.kind !== "압류"); }
        if (js.type === "가압류해제") { acc.flags.provisionalSeizure = false; acc.holds = acc.holds.filter(h => h.kind !== "가압류"); }
        acc.updatedAt = nowISO();
      }

      await writeDB(store, db);
      return jsonRes(200, { ok:true, jeSingo: js });
    }

    // -------- Internet banking enrollment (B) --------
    if (action === "admin.enrollIdentity") {
      const { name, email, tempPassword } = payload;
      if (!name || !email || !tempPassword) return jsonRes(400, { ok:false, error:"name_email_password_required" });

      const adminToken = process.env.IDENTITY_ADMIN_TOKEN || "";
      if (!adminToken) {
        // Don't crash; return guidance.
        return jsonRes(409, { ok:false, error:"missing_identity_admin_token", hint:"Netlify Site settings > Environment variables 에 IDENTITY_ADMIN_TOKEN 추가 필요" });
      }

      const siteUrl = process.env.URL || "https://example.netlify.app";
      const res = await createIdentityUser({ siteUrl, adminToken, email, password: tempPassword, fullName: name });

      if (res.status < 200 || res.status >= 300) {
        return jsonRes(500, { ok:false, error:"identity_create_failed", status: res.status, body: res.body.slice(0, 500) });
      }

      // Create/attach customer + account in DB
      const cid = ensureCustomerForEmail(email);
      db.customers[cid].name = name;
      db.customers[cid].updatedAt = nowISO();
      await writeDB(store, db);

      return jsonRes(200, { ok:true, customerId: cid, identity: safeParseJson(res.body, { raw: res.body }) });
    }

    // fallback
    return jsonRes(400, { ok:false, error:"unknown_action", action });
  } catch (err) {
    // Prevent 502 by always returning a JSON error.
    return jsonRes(500, { ok:false, error:"server_error", message: String(err && err.message ? err.message : err), at: new Date().toISOString() });
  }
};
