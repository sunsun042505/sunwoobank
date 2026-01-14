const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(obj),
  };
}
function ok(obj) { return json(200, { ok: true, ...obj }); }
function bad(statusCode, error, extra = {}) { return json(statusCode, { ok: false, error, ...extra }); }

function getHeader(event, name) {
  const h = event.headers || {};
  const key = Object.keys(h).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
}

function nowISO() { return new Date().toISOString(); }

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function pbkdf2Hash(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const iter = 150000;
  const dk = crypto.pbkdf2Sync(pin, salt, iter, 32, "sha256").toString("hex");
  return `pbkdf2$sha256$${iter}$${salt}$${dk}`;
}

function pbkdf2Verify(pin, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6) return false;
  const iter = parseInt(parts[3], 10);
  const salt = parts[4];
  const dk = parts[5];
  const test = crypto.pbkdf2Sync(pin, salt, iter, 32, "sha256").toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(test, "hex"), Buffer.from(dk, "hex"));
  } catch {
    return false;
  }
}

function randAccountNo() {
  const a = Math.floor(1000 + Math.random() * 9000);
  const b = Math.floor(1000 + Math.random() * 9000);
  return `110-${a}-${b}`;
}
function nextCustomerNo(count) {
  return `C-${1001 + (count || 0)}`;
}

async function requireSupabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const srv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !srv) throw new Error("missing_supabase_env");
  return { url, anon, srv };
}

async function adminClient() {
  const { url, srv } = await requireSupabaseEnv();
  return createClient(url, srv, { auth: { persistSession: false } });
}

function isTellerAllowed(event) {
  const code = (getHeader(event, "x-teller-code") || "").toString().trim();
  const expect = (process.env.TELLER_CODE || "0612").toString().trim();
  return code === expect;
}

async function requireCustomer(event, admin) {
  const auth = (getHeader(event, "authorization") || "").toString();
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const jwt = m[1];
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data || !data.user) return null;
  return { jwt, user: data.user };
}

async function getProfileByUserId(admin, userId) {
  const { data, error } = await admin
    .from("profiles")
    .select("user_id,customer_id,role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getAccountByNo(admin, accountNo) {
  const { data, error } = await admin
    .from("accounts")
    .select("*")
    .eq("account_no", accountNo)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function updateAccount(admin, id, patch) {
  patch.updated_at = nowISO();
  const { data, error } = await admin
    .from("accounts")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function insertTx(admin, accountId, kind, amount, memo = "") {
  const { data, error } = await admin
    .from("transactions")
    .insert({
      account_id: accountId,
      kind,
      amount: Number(amount),
      memo: memo || "",
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function sumTodayOutflow(admin, accountId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const iso = start.toISOString();
  const { data, error } = await admin
    .from("transactions")
    .select("amount")
    .eq("account_id", accountId)
    .eq("kind", "이체출금")
    .gte("created_at", iso);
  if (error) throw error;
  return (data || []).reduce((s, r) => s + Number(r.amount || 0), 0);
}

async function findAuthUserIdByEmail(admin, email) {
  let page = 1;
  const perPage = 200;
  while (page <= 10) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data.users || [];
    const u = users.find(x => (x.email || "").toLowerCase() === email.toLowerCase());
    if (u) return u.id;
    if (users.length < perPage) break;
    page += 1;
  }
  return null;
}

async function ensureCustomerForEmail(admin, email, nameGuess = "", phoneGuess = "") {
  const { data: existing, error: e1 } = await admin
    .from("customers")
    .select("*")
    .eq("email", email)
    .maybeSingle();
  if (e1) throw e1;
  if (existing) {
    const patch = { updated_at: nowISO() };
    if (nameGuess) patch.name = nameGuess;
    if (phoneGuess) patch.phone = phoneGuess;
    await admin.from("customers").update(patch).eq("id", existing.id);
    return existing;
  }

  const { count, error: eCount } = await admin
    .from("customers")
    .select("*", { count: "exact", head: true });
  if (eCount) throw eCount;
  const customer_no = nextCustomerNo(count);

  const salt = process.env.RRN_SALT || "demo_salt_change_me";
  const synthetic = "000000" + String(Math.floor(1000000 + Math.random() * 9000000));
  const rrn_hash = sha256Hex(`${salt}:${synthetic}`);
  const rrn_birth6 = "000000";

  const { data, error } = await admin
    .from("customers")
    .insert({
      customer_no,
      name: nameGuess || email.split("@")[0],
      rrn_hash,
      rrn_birth6,
      phone: phoneGuess || "",
      email,
      address: "",
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function ensureProfile(admin, userId, customerId) {
  const p = await getProfileByUserId(admin, userId);
  if (p) return p;
  const { data, error } = await admin
    .from("profiles")
    .insert({ user_id: userId, customer_id: customerId, role: "customer" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

exports.handler = async function handler(event) {
  try {
    if (event.httpMethod === "GET") {
      const q = event.queryStringParameters || {};
      if (q.ping === "1") return { statusCode: 200, headers: { "cache-control": "no-store" }, body: "pong" };
      if (q.config === "1") {
        const { url, anon } = await requireSupabaseEnv();
        return json(200, { ok: true, supabaseUrl: url, supabaseAnonKey: anon });
      }
      return bad(404, "not_found");
    }

    if (event.httpMethod !== "POST") return bad(405, "method_not_allowed");

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { return bad(400, "bad_json"); }
    const action = String(body.action || "");
    const payload = body.payload || {};
    if (!action) return bad(400, "missing_action");

    const admin = await adminClient();

    const isTeller = action.startsWith("teller.") || action.startsWith("jesingo.") || action.startsWith("restrict.") || action.startsWith("admin.");
    const isCustomer = action.startsWith("customer.");

    if (isTeller && !isTellerAllowed(event)) return bad(403, "teller_forbidden");

    let customerCtx = null;
    if (isCustomer) {
      customerCtx = await requireCustomer(event, admin);
      if (!customerCtx) return bad(401, "unauthorized");
    }

    // ---------------- CUSTOMER ----------------
    if (action === "customer.bootstrap") {
      const userId = customerCtx.user.id;
      const prof = await getProfileByUserId(admin, userId);
      if (!prof) return bad(404, "no_profile");

      const { data: cust, error: ec } = await admin.from("customers").select("*").eq("id", prof.customer_id).single();
      if (ec) throw ec;

      const { data: accounts, error: ea } = await admin.from("accounts").select("*").eq("customer_id", prof.customer_id).order("created_at", { ascending: true });
      if (ea) throw ea;

      const accIds = (accounts || []).map(a => a.id);
      let txs = [];
      if (accIds.length) {
        const { data: txData, error: et } = await admin.from("transactions").select("*").in("account_id", accIds).order("created_at", { ascending: false }).limit(30);
        if (et) throw et;
        txs = txData || [];
      }

      return ok({
        customer: { customer_no: cust.customer_no, name: cust.name, email: cust.email, phone: cust.phone, address: cust.address },
        accounts: (accounts || []).map(a => ({ account_no: a.account_no, type: a.type, status: a.status, balance: a.balance, flags: a.flags, holds: a.holds })),
        txs
      });
    }

    if (action === "customer.transfer") {
      const { fromAccountNo, toAccountNo, amount, memo } = payload;
      const amt = Number(amount);
      if (!fromAccountNo || !toAccountNo || !Number.isFinite(amt) || amt <= 0) return bad(400, "bad_request");

      const userId = customerCtx.user.id;
      const prof = await getProfileByUserId(admin, userId);
      if (!prof) return bad(404, "no_profile");

      const fromAcc = await getAccountByNo(admin, String(fromAccountNo));
      const toAcc = await getAccountByNo(admin, String(toAccountNo));
      if (!fromAcc || !toAcc) return bad(404, "account_not_found");
      if (fromAcc.customer_id !== prof.customer_id) return bad(403, "not_owner");

      const flags = fromAcc.flags || {};
      if (fromAcc.status !== "정상") return bad(409, "account_blocked");
      if (flags.paymentStop) return bad(409, "payment_stopped");
      if (Number(fromAcc.balance) < amt) return bad(409, "insufficient");

      if (flags.limitAccount) {
        if (amt > 300000) return bad(409, "limit_account_txn_limit", { limit: 300000 });
        const out = await sumTodayOutflow(admin, fromAcc.id);
        if (out + amt > 1000000) return bad(409, "limit_account_daily_limit", { limit: 1000000, today: out });
      }

      await updateAccount(admin, fromAcc.id, { balance: Number(fromAcc.balance) - amt });
      await updateAccount(admin, toAcc.id, { balance: Number(toAcc.balance) + amt });

      const txOut = await insertTx(admin, fromAcc.id, "이체출금", amt, memo || `to ${toAcc.account_no}`);
      const txIn = await insertTx(admin, toAcc.id, "이체입금", amt, memo || `from ${fromAcc.account_no}`);

      return ok({ txOut, txIn });
    }

    // ---------------- TELLER ----------------
    if (action === "teller.searchCustomers") {
      const { name, phone, email } = payload;
      let q = admin.from("customers").select("id,customer_no,name,rrn_birth6,phone,email,address,created_at").order("created_at", { ascending: false }).limit(30);
      if (name) q = q.ilike("name", `%${name}%`);
      if (phone) q = q.ilike("phone", `%${phone}%`);
      if (email) q = q.ilike("email", `%${email}%`);

      const { data, error } = await q;
      if (error) throw error;
      return ok({ customers: data || [] });
    }

    if (action === "teller.createCustomer") {
      const { name, rrn, phone, email, address } = payload;
      if (!name || !rrn) return bad(400, "name_rrn_required");

      const rrnStr = String(rrn).replace(/[^0-9]/g, "");
      if (rrnStr.length !== 13) return bad(400, "rrn_format_13_digits");

      const salt = process.env.RRN_SALT || "demo_salt_change_me";
      const rrn_hash = sha256Hex(`${salt}:${rrnStr}`);
      const rrn_birth6 = rrnStr.slice(0, 6);

      const { count, error: eCount } = await admin.from("customers").select("*", { count: "exact", head: true });
      if (eCount) throw eCount;
      const customer_no = nextCustomerNo(count);

      const { data, error } = await admin.from("customers").insert({
        customer_no,
        name,
        rrn_hash,
        rrn_birth6,
        phone: phone || "",
        email: email || null,
        address: address || ""
      }).select("id,customer_no,name,rrn_birth6,phone,email,address,created_at").single();

      if (error) return bad(409, "duplicate_customer", { detail: error.message });
      return ok({ customer: data });
    }

    if (action === "teller.createAccount") {
      const { customerId, type, initialBalance, accountNo, accountPin } = payload;
      if (!customerId) return bad(400, "customer_required");
      const pin = String(accountPin || "").trim();
      if (pin.length < 4) return bad(400, "account_pin_required_4+");

      const acctNo = accountNo ? String(accountNo).trim() : randAccountNo();
      const flags = { limitAccount: true, paymentStop: false, seizure: false, provisionalSeizure: false };

      const { data, error } = await admin.from("accounts").insert({
        customer_id: customerId,
        account_no: acctNo,
        type: type || "입출금",
        status: "정상",
        balance: Number(initialBalance || 0),
        flags,
        holds: [],
        account_pin_hash: pbkdf2Hash(pin)
      }).select("*").single();

      if (error) return bad(409, "account_create_failed", { detail: error.message });
      return ok({ account: data });
    }

    if (action === "teller.cashInOut") {
      const { accountNo, kind, amount, memo } = payload;
      const amt = Number(amount);
      if (!accountNo || !Number.isFinite(amt) || amt <= 0) return bad(400, "bad_request");

      const acc = await getAccountByNo(admin, String(accountNo));
      if (!acc) return bad(404, "account_not_found");

      const flags = acc.flags || {};
      if (acc.status !== "정상") return bad(409, "account_blocked");
      if (flags.paymentStop && kind === "출금") return bad(409, "payment_stopped");

      if (kind === "입금") {
        const updated = await updateAccount(admin, acc.id, { balance: Number(acc.balance) + amt });
        const tx = await insertTx(admin, acc.id, "입금", amt, memo || "");
        return ok({ tx, balance: updated.balance });
      }
      if (kind === "출금") {
        if (Number(acc.balance) < amt) return bad(409, "insufficient");
        const updated = await updateAccount(admin, acc.id, { balance: Number(acc.balance) - amt });
        const tx = await insertTx(admin, acc.id, "출금", amt, memo || "");
        return ok({ tx, balance: updated.balance });
      }
      return bad(400, "bad_kind");
    }

    if (action === "teller.transfer") {
      const { fromAccountNo, toAccountNo, amount, memo } = payload;
      const amt = Number(amount);
      if (!fromAccountNo || !toAccountNo || !Number.isFinite(amt) || amt <= 0) return bad(400, "bad_request");

      const fromAcc = await getAccountByNo(admin, String(fromAccountNo));
      const toAcc = await getAccountByNo(admin, String(toAccountNo));
      if (!fromAcc || !toAcc) return bad(404, "account_not_found");

      const flags = fromAcc.flags || {};
      if (fromAcc.status !== "정상") return bad(409, "account_blocked");
      if (flags.paymentStop) return bad(409, "payment_stopped");
      if (Number(fromAcc.balance) < amt) return bad(409, "insufficient");

      await updateAccount(admin, fromAcc.id, { balance: Number(fromAcc.balance) - amt });
      await updateAccount(admin, toAcc.id, { balance: Number(toAcc.balance) + amt });

      const txOut = await insertTx(admin, fromAcc.id, "이체출금", amt, memo || `to ${toAcc.account_no}`);
      const txIn = await insertTx(admin, toAcc.id, "이체입금", amt, memo || `from ${fromAcc.account_no}`);
      return ok({ txOut, txIn });
    }

    if (action === "teller.getCustomerDetail") {
      const { customerId } = payload;
      if (!customerId) return bad(400, "customer_required");
      const { data: cust, error: ec } = await admin.from("customers").select("*").eq("id", customerId).single();
      if (ec) throw ec;
      const { data: accts, error: ea } = await admin.from("accounts").select("*").eq("customer_id", customerId).order("created_at", { ascending: true });
      if (ea) throw ea;
      const { data: js, error: ej } = await admin.from("jesingo").select("*").eq("customer_id", customerId).order("created_at", { ascending: false }).limit(200);
      if (ej) throw ej;
      return ok({ customer: cust, accounts: accts || [], jesingo: js || [] });
    }

    // ----- JeSingo -----
    if (action === "jesingo.create") {
      const { customerId, accountNo, category, item, field, oldValue, newValue, detail, accountPinOld, accountPinNew } = payload;
      if (!customerId || !category) return bad(400, "customer_category_required");

      let accountId = null;
      let acc = null;
      if (accountNo) {
        acc = await getAccountByNo(admin, String(accountNo));
        if (!acc) return bad(404, "account_not_found");
        accountId = acc.id;
      }

      if (category === "비밀번호변경") {
        if (!acc) return bad(400, "account_required");
        const newPin = String(accountPinNew || "").trim();
        if (newPin.length < 4) return bad(400, "new_pin_required_4+");

        const oldPin = String(accountPinOld || "").trim();
        if (oldPin) {
          if (!pbkdf2Verify(oldPin, acc.account_pin_hash)) return bad(409, "old_pin_mismatch");
        }
        await updateAccount(admin, acc.id, { account_pin_hash: pbkdf2Hash(newPin) });
      }

      if (category === "정보변경") {
        if (!field || !newValue) return bad(400, "field_newvalue_required");
        const allowed = new Set(["주소", "연락처", "이메일", "이름"]);
        if (!allowed.has(field)) return bad(400, "unsupported_field");

        const patch = { updated_at: nowISO() };
        if (field === "주소") patch.address = String(newValue);
        if (field === "연락처") patch.phone = String(newValue);
        if (field === "이메일") patch.email = String(newValue);
        if (field === "이름") patch.name = String(newValue);

        const { error: eu } = await admin.from("customers").update(patch).eq("id", customerId);
        if (eu) throw eu;
      }

      const { data, error } = await admin.from("jesingo").insert({
        customer_id: customerId,
        account_id: accountId,
        category,
        item: item || null,
        field: field || null,
        old_value: oldValue || null,
        new_value: newValue || null,
        detail: detail || null,
        status: "접수"
      }).select("*").single();

      if (error) throw error;
      return ok({ jesingo: data });
    }

    if (action === "jesingo.process") {
      const { id, status } = payload;
      if (!id) return bad(400, "id_required");
      const { data, error } = await admin.from("jesingo")
        .update({ status: status || "처리완료", processed_at: nowISO() })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      return ok({ jesingo: data });
    }

    // ----- Restrictions -----
    if (action === "restrict.set") {
      const { accountNo, paymentStop, seizure, provisionalSeizure, holdAmount, limitAccount } = payload;
      if (!accountNo) return bad(400, "account_required");
      const acc = await getAccountByNo(admin, String(accountNo));
      if (!acc) return bad(404, "account_not_found");

      const flags = acc.flags || {};
      const newFlags = {
        ...flags,
        paymentStop: typeof paymentStop === "boolean" ? paymentStop : flags.paymentStop,
        seizure: typeof seizure === "boolean" ? seizure : flags.seizure,
        provisionalSeizure: typeof provisionalSeizure === "boolean" ? provisionalSeizure : flags.provisionalSeizure,
        limitAccount: typeof limitAccount === "boolean" ? limitAccount : flags.limitAccount
      };

      let holds = Array.isArray(acc.holds) ? acc.holds : (acc.holds || []);
      const amt = Number(holdAmount || 0);
      if (amt > 0) {
        if (seizure) holds = [{ kind: "압류", amount: amt, at: nowISO() }, ...holds];
        if (provisionalSeizure) holds = [{ kind: "가압류", amount: amt, at: nowISO() }, ...holds];
      }

      const updated = await updateAccount(admin, acc.id, { flags: newFlags, holds });
      return ok({ account: updated });
    }

    if (action === "restrict.releaseLimit") {
      const { accountNo } = payload;
      if (!accountNo) return bad(400, "account_required");
      const acc = await getAccountByNo(admin, String(accountNo));
      if (!acc) return bad(404, "account_not_found");
      const flags = acc.flags || {};
      const updated = await updateAccount(admin, acc.id, { flags: { ...flags, limitAccount: false } });
      return ok({ account: updated });
    }

    // ----- Internet banking enrollment -----
    if (action === "admin.enrollInternetBanking") {
      const { name, email, tempPassword, phone } = payload;
      if (!name || !email || !tempPassword) return bad(400, "name_email_password_required");

      let userId = null;
      try {
        const { data, error } = await admin.auth.admin.createUser({
          email,
          password: tempPassword,
          email_confirm: true,
          user_metadata: { name }
        });
        if (error) throw error;
        userId = data.user.id;
      } catch (e) {
        userId = await findAuthUserIdByEmail(admin, email);
        if (!userId) return bad(409, "auth_user_create_failed", { detail: String(e?.message || e) });
      }

      const cust = await ensureCustomerForEmail(admin, email, name, phone || "");
      await ensureProfile(admin, userId, cust.id);

      const { data: accts, error: ea } = await admin.from("accounts").select("*").eq("customer_id", cust.id).order("created_at", { ascending: true });
      if (ea) throw ea;
      if (!accts || accts.length === 0) {
        await admin.from("accounts").insert({
          customer_id: cust.id,
          account_no: randAccountNo(),
          type: "입출금",
          status: "정상",
          balance: 0,
          flags: { limitAccount: true, paymentStop: false, seizure: false, provisionalSeizure: false },
          holds: [],
          account_pin_hash: pbkdf2Hash("0000")
        });
      }

      return ok({ customer_no: cust.customer_no, customer_id: cust.id });
    }

    return bad(400, "unknown_action", { action });
  } catch (err) {
    return bad(500, "server_error", { message: String(err?.message || err) });
  }
};
