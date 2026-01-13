/**
 * SunwooBank demo API
 * - Auth: Netlify Identity (JWT in Authorization: Bearer <token>)
 * - Storage: Netlify Blobs (per-user state)
 *
 * NOTE: 이 코드는 "데모" 용도이며 실제 금융 로직/보안 요건을 만족하지 않습니다.
 */
import { getStore } from "@netlify/blobs";

/** Common helpers */
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });

const bad = (message, status = 400) => json({ ok: false, error: message }, status);
const ok = (payload) => json({ ok: true, ...payload }, 200);

const uid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `id-${Math.random().toString(16).slice(2)}-${Date.now()}`);
const nowISO = () => new Date().toISOString();

function clampNumber(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function makeDefaultState(user) {
  const display = user?.user_metadata?.full_name || user?.email?.split("@")[0] || "고객";
  const acct1 = {
    id: uid(),
    name: "생활비 통장",
    bank: "선우뱅크",
    number: `110-${String(Math.floor(1000 + Math.random() * 9000))}-${String(Math.floor(100000 + Math.random() * 900000))}`,
    balance: 150000,
  };
  const acct2 = {
    id: uid(),
    name: "저축 통장",
    bank: "선우뱅크",
    number: `120-${String(Math.floor(1000 + Math.random() * 9000))}-${String(Math.floor(100000 + Math.random() * 900000))}`,
    balance: 50000,
  };
  const card = {
    id: uid(),
    name: "선우 체크카드",
    number: `4444${String(Math.floor(1000 + Math.random() * 9000))}${String(Math.floor(1000 + Math.random() * 9000))}${String(Math.floor(1000 + Math.random() * 9000))}`,
    locked: false,
    monthlyLimit: 500000,
  };
  return {
    version: 1,
    createdAt: nowISO(),
    profile: {
      name: display,
      email: user?.email || "",
      phone: "",
      address: "",
      notify: "ON",
    },
    security: { twoFA: true },
    accounts: [acct1, acct2],
    payees: [],
    savings: [],
    bills: [],
    cards: [card],
    tickets: [],
    tx: [
      {
        id: uid(),
        ts: nowISO(),
        accountId: acct1.id,
        amount: 150000,
        desc: "계좌 개설 입금",
        memo: "",
        balanceAfter: acct1.balance,
      },
      {
        id: uid(),
        ts: nowISO(),
        accountId: acct2.id,
        amount: 50000,
        desc: "계좌 개설 입금",
        memo: "",
        balanceAfter: acct2.balance,
      },
    ],
  };
}

function assertUser(context) {
  // Netlify가 Bearer 토큰 검증에 성공하면 context.clientContext.user에 claims를 넣어줌
  const user = context?.clientContext?.user;
  if (!user) return null;
  return user;
}

function userKey(user) {
  // JWT claim에서 식별자: sub(권장) -> id -> email
  const id = user?.sub || user?.id || user?.email || "anonymous";
  // key는 길이 제한이 있으니 안전하게 정리
  return `users/${String(id).replace(/[^a-zA-Z0-9._-]/g, "_")}/state.json`;
}

/** Simple ledger helpers */
function pushTx(state, accountId, amount, desc, memo = "") {
  const acct = state.accounts.find((a) => a.id === accountId);
  if (!acct) throw new Error("계좌를 찾을 수 없음");
  acct.balance = Number(acct.balance || 0) + Number(amount || 0);

  const t = {
    id: uid(),
    ts: nowISO(),
    accountId,
    amount: Number(amount || 0),
    desc: String(desc || ""),
    memo: String(memo || ""),
    balanceAfter: acct.balance,
  };
  state.tx.push(t);
  return t;
}

function ensureArrays(state) {
  state.accounts ||= [];
  state.payees ||= [];
  state.savings ||= [];
  state.bills ||= [];
  state.cards ||= [];
  state.tickets ||= [];
  state.tx ||= [];
  state.security ||= { twoFA: true };
  state.profile ||= {};
}

/** Main handler (Modern Functions) */
export default async (req, context) => {
  try {
    const url = new URL(req.url);

    // health/ping (no auth)
    if (url.searchParams.get("ping") === "1") {
      return new Response("pong", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const user = assertUser(context);
    if (!user) return bad("로그인이 필요해 (Authorization: Bearer 토큰 없음)", 401);

    const store = getStore({ name: "sunwoobank", consistency: "strong" });
    const key = userKey(user);

    const loadState = async () => {
      const existing = await store.get(key, { type: "json" });
      if (existing) return existing;
      const created = makeDefaultState(user);
      await store.setJSON(key, created, { metadata: { createdAt: created.createdAt } });
      return created;
    };

    const saveState = async (s) => {
      ensureArrays(s);
      await store.setJSON(key, s, { metadata: { savedAt: nowISO() } });
      return s;
    };

    // Read body (if any)
    let body = null;
    if (req.method !== "GET") {
      try {
        body = await req.json();
      } catch {
        body = {};
      }
    } else {
      body = {};
    }

    const action = body?.action || url.searchParams.get("action");
    const payload = body?.payload || {};

    // Actions
    if (action === "bootstrap") {
      const s = await loadState();
      return ok({ state: s });
    }

    if (action === "getState") {
      const s = await loadState();
      return ok({ state: s });
    }

    if (action === "updateProfile") {
      const s = await loadState();
      ensureArrays(s);
      const name = String(payload?.name || "").slice(0, 40);
      const phone = String(payload?.phone || "").slice(0, 30);
      const address = String(payload?.address || "").slice(0, 80);
      const notify = payload?.notify === "OFF" ? "OFF" : "ON";
      if (!name) return bad("이름이 비어있음");
      s.profile = { ...s.profile, name, phone, address, notify, email: s.profile?.email || user.email || "" };
      await saveState(s);
      return ok({ state: s });
    }

    if (action === "toggle2FA") {
      const s = await loadState();
      ensureArrays(s);
      s.security.twoFA = !s.security.twoFA;
      await saveState(s);
      return ok({ state: s });
    }

    if (action === "upsertPayee") {
      const s = await loadState();
      ensureArrays(s);
      const id = payload?.id ? String(payload.id) : null;
      const name = String(payload?.name || "").slice(0, 30);
      const bank = String(payload?.bank || "").slice(0, 30);
      const number = String(payload?.number || "").slice(0, 40);
      if (!name || !bank || !number) return bad("받는사람 정보가 부족함");

      if (id) {
        const idx = s.payees.findIndex((p) => p.id === id);
        if (idx < 0) return bad("수정 대상이 없음");
        s.payees[idx] = { ...s.payees[idx], name, bank, number };
      } else {
        s.payees.push({ id: uid(), name, bank, number, createdAt: nowISO() });
      }

      await saveState(s);
      return ok({ state: s });
    }

    if (action === "deletePayee") {
      const s = await loadState();
      ensureArrays(s);
      const id = String(payload?.id || "");
      if (!id) return bad("id 없음");
      s.payees = s.payees.filter((p) => p.id !== id);
      await saveState(s);
      return ok({ state: s });
    }

    if (action === "transfer") {
      const s = await loadState();
      ensureArrays(s);

      const fromAccountId = String(payload?.fromAccountId || "");
      const to = payload?.to || null;
      const amount = clampNumber(payload?.amount, 1, 1_000_000_000);
      const memo = String(payload?.memo || "").slice(0, 30);

      const from = s.accounts.find((a) => a.id === fromAccountId);
      if (!from) return bad("출금계좌를 찾을 수 없음");
      if (Number(from.balance || 0) < amount) return bad("잔액 부족");

      // 출금
      pushTx(s, from.id, -amount, "이체 출금", memo);

      // 입금: 내 계좌(internal)만 실제로 입금 처리. 외부 계좌는 기록만.
      if (to?.type === "internal" && to.accountId) {
        const toAcc = s.accounts.find((a) => a.id === String(to.accountId));
        if (!toAcc) return bad("입금계좌(내 계좌)를 찾을 수 없음");
        pushTx(s, toAcc.id, amount, "이체 입금", memo);
      } else {
        // 외부 이체 기록(가상): 출금 계좌에만 출금 거래가 남도록 하고,
        // 참고용으로 bills/tx에 별도 기록은 남기지 않음.
      }

      await saveState(s);
      return ok({ state: s });
    }

    if (action === "openSaving") {
      const s = await loadState();
      ensureArrays(s);
      const type = payload?.type === "예금" ? "예금" : "적금";
      const termMonths = clampNumber(payload?.termMonths, 1, 60);
      const amount = clampNumber(payload?.amount, 1, 1_000_000_000);
      const fromAccountId = String(payload?.fromAccountId || "");
      const from = s.accounts.find((a) => a.id === fromAccountId);
      if (!from) return bad("출금계좌 없음");

      // 데모 규칙: 예금은 한 번에 예치(출금), 적금은 첫 납입(출금)
      if (Number(from.balance || 0) < amount) return bad("잔액 부족");

      const apr = (() => {
        const base = type === "예금" ? 2.6 : 3.0;
        const bonus = Math.min(1.2, termMonths / 24);
        const jitter = (Math.random() * 0.6) - 0.2;
        return Math.round((base + bonus + jitter) * 10) / 10;
      })();

      // 출금
      pushTx(s, from.id, -amount, `${type} 가입 출금`, `${termMonths}개월`);

      s.savings.push({
        id: uid(),
        type,
        termMonths,
        amount,
        apr,
        status: "ACTIVE",
        openedAt: nowISO(),
        fromAccountId: from.id,
      });

      await saveState(s);
      return ok({ state: s });
    }

    if (action === "closeSaving") {
      const s = await loadState();
      ensureArrays(s);
      const id = String(payload?.id || "");
      const item = s.savings.find((x) => x.id === id);
      if (!item) return bad("상품을 찾을 수 없음");
      if (item.status !== "ACTIVE") return bad("이미 해지됨");

      // 데모: 원금만 원계좌로 입금 (이자 생략)
      const toAcc = s.accounts.find((a) => a.id === item.fromAccountId) || s.accounts[0];
      pushTx(s, toAcc.id, Number(item.amount || 0), `${item.type} 해지 입금`, `${item.termMonths}개월`);

      item.status = "CLOSED";
      item.closedAt = nowISO();

      await saveState(s);
      return ok({ state: s });
    }

    if (action === "payBill") {
      const s = await loadState();
      ensureArrays(s);
      const type = String(payload?.type || "").slice(0, 10);
      const customerNo = String(payload?.customerNo || "").slice(0, 40);
      const amount = clampNumber(payload?.amount, 1, 1_000_000_000);
      const fromAccountId = String(payload?.fromAccountId || "");
      if (!type || !customerNo) return bad("납부 정보가 부족함");

      const from = s.accounts.find((a) => a.id === fromAccountId);
      if (!from) return bad("출금계좌 없음");
      if (Number(from.balance || 0) < amount) return bad("잔액 부족");

      pushTx(s, from.id, -amount, `${type} 납부`, customerNo);
      s.bills.push({ id: uid(), ts: nowISO(), type, customerNo, amount, fromAccountId });

      await saveState(s);
      return ok({ state: s });
    }

    if (action === "toggleCardLock") {
      const s = await loadState();
      ensureArrays(s);
      const id = String(payload?.id || "");
      const c = s.cards.find((x) => x.id === id);
      if (!c) return bad("카드를 찾을 수 없음");
      c.locked = !c.locked;
      await saveState(s);
      return ok({ state: s });
    }

    if (action === "updateCard") {
      const s = await loadState();
      ensureArrays(s);
      const id = String(payload?.id || "");
      const c = s.cards.find((x) => x.id === id);
      if (!c) return bad("카드를 찾을 수 없음");
      const limit = clampNumber(payload?.monthlyLimit, 0, 10_000_000_000);
      c.monthlyLimit = limit;
      await saveState(s);
      return ok({ state: s });
    }

    if (action === "createTicket") {
      const s = await loadState();
      ensureArrays(s);
      const category = String(payload?.category || "기타").slice(0, 10);
      const title = String(payload?.title || "").slice(0, 60);
      const bodyText = String(payload?.body || "").slice(0, 800);
      if (!title || !bodyText) return bad("제목/내용이 비어있음");
      s.tickets.push({
        id: uid(),
        ts: nowISO(),
        category,
        title,
        body: bodyText,
        status: "OPEN",
      });
      await saveState(s);
      return ok({ state: s });
    }

    

    /** -------------------------
     * Teller Desk Online Storage
     * - 저장 키: teller/<userId>/desk.json
     * - 이 데이터는 teller.html 전용(창구 데스크) 상태를 저장합니다.
     * --------------------------*/
    const deskKey = () => {
      const id = user?.sub || user?.id || user?.email || "anonymous";
      const safe = String(id).replace(/[^a-zA-Z0-9._-]/g, "_");
      return `teller/${safe}/desk.json`;
    };

    const makeDefaultDesk = () => ({
      state: { user:{ name:"Teller", branch:"ONLINE", role:"TELLER", note:"" }, selectedCustomerId:null, selectedAccountId:null, alerts:0 },
      db: {
        customers:[
          { id:"C-1001", name:"선우", phone:"010-1234-5678", note:"우대 고객(데모)" },
          { id:"C-1002", name:"모락", phone:"010-2222-3333", note:"" },
          { id:"C-1003", name:"하늘", phone:"010-9999-0000", note:"" },
        ],
        accounts:[
          { id:"A-2001", no:"110-1234-5678", customerId:"C-1001", type:"입출금", status:"정상", balance:150000 },
          { id:"A-2002", no:"220-0000-8888", customerId:"C-1001", type:"정기예금", status:"정상", balance:500000 },
          { id:"A-2003", no:"110-9876-0001", customerId:"C-1002", type:"입출금", status:"정상", balance:89000 },
          { id:"A-2004", no:"330-0000-1111", customerId:"C-1003", type:"입출금", status:"정상", balance:540000 },
        ],
        transactions:[],
        products:[], autopays:[], bills:[], reports:[], security:[], cards:[], misc:[], legal:[], audit:[]
      }
    });

    if (action === "tellerDeskGet") {
      const k = deskKey();
      const desk = await store.get(k, { type: "json" });
      if (!desk) {
        const created = makeDefaultDesk();
        await store.setJSON(k, created, { metadata: { createdAt: nowISO() } });
        return ok({ desk: created });
      }
      return ok({ desk });
    }

    if (action === "tellerDeskSet") {
      const k = deskKey();
      const desk = payload?.desk;
      if (!desk || typeof desk !== "object") return bad("desk payload가 필요해");
      // 아주 큰 payload 방지(대충)
      const size = JSON.stringify(desk).length;
      if (size > 900_000) return bad("데이터가 너무 커서 저장 불가(900KB 제한 데모)");
      await store.setJSON(k, desk, { metadata: { savedAt: nowISO(), size } });
      return ok({ savedAt: nowISO() });
    }

    if (action === "tellerDeskReset") {
      const k = deskKey();
      const created = makeDefaultDesk();
      await store.setJSON(k, created, { metadata: { resetAt: nowISO() } });
      return ok({ desk: created });
    }


return bad("알 수 없는 action: " + String(action || "(none)"), 404);
  } catch (e) {
    return json({ ok: false, error: e?.message || "서버 오류" }, 500);
  }
};
