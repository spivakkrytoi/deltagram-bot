import http from "node:http";
import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config.js";
import { BotDatabase } from "./db.js";
import { GramsrvClient } from "./gramsrv.js";
import { commandList, createBot, notifyRecurringGrants } from "./bot.js";
import { normalizeLanguage, translate } from "./i18n.js";
import { parseTelesrvDelivery, verifyTelesrvSignature } from "./otp.js";
import { isRealMode } from "./real-number.js";
import { describeProxy } from "./proxy.js";
import { deliverWithRetry } from "./delivery-retry.js";
import { RecurringStarsScheduler } from "./recurring.js";

const config = loadConfig();
const db = new BotDatabase(config.dbUrl, { authSecret: config.deltamentAuthSecret });
// Fail before opening the webhook or polling Telegram if the required schema
// migration has not been applied. Runtime startup never repairs persisted data.
await db.pool.query("SELECT retired FROM numbers LIMIT 0");
const gramsrv = new GramsrvClient(config);
const recurring = new RecurringStarsScheduler({ config, db, gramsrv });
const bot = createBot({ config, db, gramsrv, recurring });
recurring.setNotifier((summary) => notifyRecurringGrants({ bot, config, db }, summary));

function authJSON(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
function authOK(request) {
  const actual = Buffer.from(String(request.headers.authorization ?? ""));
  const expected = Buffer.from(`Bearer ${config.deltamentAuthSecret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function authBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    request.on("data", (chunk) => { size += chunk.length; if (size > 8192) reject(new Error("REQUEST_TOO_LARGE")); else chunks.push(chunk); });
    request.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("JSON_INVALID")); } });
    request.on("error", reject);
  });
}
function normalizeAuthPhone(value) {
  const phone = String(value ?? "").replace(/[\s()\-]/g, "");
  return phone && !phone.startsWith("+") ? `+${phone}` : phone;
}

const authServer = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") return authJSON(response, 200, { ok: true });
  if (!authOK(request)) return authJSON(response, 401, { error: "UNAUTHORIZED" });
  if (request.method !== "POST" || !["/v1/deltament/auth/request", "/v1/deltament/auth/verify", "/v1/deltament/topup/invoice", "/v1/deltament/topup/direct", "/v1/deltament/withdraw/direct"].includes(request.url)) return authJSON(response, 404, { error: "NOT_FOUND" });
  try {
    const body = await authBody(request);
    if (request.url === "/v1/deltament/topup/direct") {
      const serverUserID = Number(body.server_user_id);
      const amount = Number(body.amount);
      const currency = String(body.currency ?? "").toUpperCase();
      const key = String(body.idempotency_key ?? "");
      if (!Number.isSafeInteger(serverUserID) || serverUserID <= 0 || !Number.isSafeInteger(amount) || amount < 1 || amount > 1000000 || currency !== "XTR" || !key) return authJSON(response, 400, { error: "INVALID_DIRECT_TOPUP" });
      const result = await gramsrv.debitStars(serverUserID, amount, "DeltaMent balance top-up", key, false, "deltament");
      return authJSON(response, 200, { ok: true, currency, amount, debit: result });
    }
    if (request.url === "/v1/deltament/withdraw/direct") {
      const serverUserID = Number(body.server_user_id);
      const starsAmount = Number(body.stars_amount);
      const key = String(body.idempotency_key ?? "");
      if (!Number.isSafeInteger(serverUserID) || serverUserID <= 0 || !Number.isSafeInteger(starsAmount) || starsAmount < 1 || starsAmount > 1000000 || !key || key.length > 128) return authJSON(response, 400, { error: "INVALID_DIRECT_WITHDRAWAL" });
      const result = await gramsrv.grantStars(serverUserID, starsAmount, "DeltaMent TON withdrawal", key, false, "deltament");
      return authJSON(response, 200, { ok: true, currency: "XTR", stars: starsAmount, grant: result });
    }
    if (request.url === "/v1/deltament/topup/invoice") {
      const serverUserID = Number(body.server_user_id);
      const amount = Number(body.amount);
      const intentID = String(body.intent_id ?? "");
      if (!Number.isSafeInteger(serverUserID) || serverUserID <= 0 || !Number.isSafeInteger(amount) || amount < 1 || amount > 1000000 || !/^[0-9a-f-]{36}$/i.test(intentID)) return authJSON(response, 400, { error: "INVALID_TOPUP" });
      const user = await db.userByServerUserID(serverUserID);
      if (!user?.chat_id) return authJSON(response, 404, { error: "ACCOUNT_NOT_LINKED" });
      const payload = `custom|${Buffer.from(JSON.stringify({ kind: "deltament_topup", intentID, serverUserID, starsAmount: amount }), "utf8").toString("base64url")}`;
      const sent = await bot.api.sendInvoice(user.chat_id, `Пополнение DeltaMent: ${amount} Stars`, `Официальное пополнение баланса DeltaMent`, payload, "XTR", [{ label: `${amount} DeltaMent Stars`, amount }]);
      return authJSON(response, 200, { ok: true, message_id: sent?.message_id ?? 0 });
    }
    if (request.url === "/v1/deltament/auth/request") {
      const phone = normalizeAuthPhone(body.phone);
      if (!/^\+[1-9]\d{6,14}$/.test(phone)) return authJSON(response, 400, { error: "PHONE_INVALID" });
      await db.claimDeltamentAuthRequest(phone);
      let serverUserID;
      try {
        serverUserID = await gramsrv.resolveUserByPhone(phone);
      } catch (error) {
        console.error("Deltament phone lookup failed", error?.code || error?.name || "UNKNOWN");
        throw new Error("AUTH_UPSTREAM_UNAVAILABLE");
      }
      // Virtual +888 numbers are bound to the bot account first. The bot user
      // may not have server_user_id populated yet, so resolve ownership by the
      // bound number instead of requiring a pre-existing secondary link.
      const user = await db.userByBoundPhone(phone) ?? await db.userByServerUserID(serverUserID);
      if (!user?.chat_id) return authJSON(response, 404, { error: "ACCOUNT_NOT_LINKED" });
      if (serverUserID > 0 && Number(user.server_user_id) !== serverUserID) {
        await db.setServerUserID(user.telegram_id, serverUserID);
      }
      const requestID = `dga_${randomUUID()}`;
      const code = String(randomInt(10000, 100000));
      const expiresAt = Math.floor(Date.now() / 1000) + 300;
      await db.createDeltamentChallenge(requestID, phone, serverUserID, code, expiresAt);
      const sent = await bot.api.sendMessage(user.chat_id, loginCodeMessage(user.language, phone, code), { parse_mode: "HTML" });
      if (!sent?.message_id) throw new Error("DELIVERY_FAILED");
      setTimeout(() => bot.api.deleteMessage(user.chat_id, sent.message_id).catch(() => {}), 120_000).unref?.();
      return authJSON(response, 200, { request_id: requestID, expires_in: 300, phone: phone.slice(0, 4) + "••••" + phone.slice(-2) });
    }
    const requestID = String(body.request_id ?? "");
    const code = String(body.code ?? "").trim();
    if (!/^dga_[0-9a-f-]{36}$/.test(requestID) || !/^\d{5}$/.test(code)) return authJSON(response, 400, { error: "CODE_INVALID" });
    const result = await db.verifyDeltamentChallenge(requestID, code);
    return authJSON(response, 200, { user_id: result.serverUserID });
  } catch (error) {
    const errorCode = String(error?.message ?? "AUTH_FAILED");
    const status = ["AUTH_CODE_INVALID", "AUTH_CHALLENGE_EXPIRED", "AUTH_TOO_MANY_ATTEMPTS"].includes(errorCode) ? 401 : errorCode === "ACCOUNT_NOT_LINKED" ? 404 : errorCode === "AUTH_RATE_LIMITED" ? 429 : errorCode === "AUTH_UPSTREAM_UNAVAILABLE" ? 503 : 400;
    return authJSON(response, status, { error: errorCode });
  }
});
authServer.listen(config.deltamentAuthPort, config.deltamentAuthHost, () => console.log(`Deltament auth listening on http://${config.deltamentAuthHost}:${config.deltamentAuthPort}`));

function escapeHTML(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function json(response, status, body) { response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(body)); }

function loginCodeMessage(language, recipient, code) {
  const variables = {
    product: escapeHTML(config.productName),
    phone: escapeHTML(recipient),
    code: escapeHTML(code),
  };
  const lines = [
    translate(language, "otpTitle", variables),
    "",
    translate(language, "otpPhone", variables),
    translate(language, "otpCode", variables),
    "",
    translate(language, "otpWarning", variables),
  ];
  return lines.join("\n");
}

async function deliverLoginCode(recipient, code, chatIDs, expiresAt) {
  let delivered = 0;
  for (const chatID of chatIDs) {
    try {
      const language = normalizeLanguage((await db.userByChatID(chatID))?.language, config.defaultLanguage);
      const sent = await deliverWithRetry(
        () => bot.api.sendMessage(chatID, loginCodeMessage(language, recipient, code), { parse_mode: "HTML" }),
        expiresAt,
        { onRetry: attempt => console.warn("OTP Telegram transport retry", attempt) }
      );
      if (!sent) continue;
      if (sent?.message_id) setTimeout(() => bot.api.deleteMessage(chatID, sent.message_id).catch(() => {}), 120_000).unref?.();
      delivered++;
    }
    catch (error) { console.error("OTP delivery failed", error?.error_code ?? error?.name ?? "UNKNOWN"); }
  }
  if (!delivered) console.error("OTP delivery failed for all bound chats");
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") return json(response, 200, { ok: true });
  if (request.method !== "POST" || !["/code", "/v1/otp/deliveries"].includes(request.url)) return json(response, 404, { error: "not found" });
  const chunks = []; let size = 0, tooLarge = false;
  request.on("data", (chunk) => { size += chunk.length; if (size > 16_384) tooLarge = true; else chunks.push(chunk); });
  request.on("end", () => {
    try {
      if (tooLarge) return json(response, 413, { accepted: false, error_code: "REQUEST_TOO_LARGE", retryable: false });
      const raw = Buffer.concat(chunks);
      if (!verifyTelesrvSignature(config.codeWebhookSecret, request.headers, raw)) return json(response, 401, { accepted: false, error_code: "SIGNATURE_INVALID", retryable: false });
      const { recipient, code, deliveryID, expiresAt, fingerprint } = parseTelesrvDelivery(raw, request.headers);
      db.acceptLoginCodeDelivery(deliveryID, fingerprint, recipient, code, expiresAt).then((delivery) => {
        json(response, 202, { accepted: true, message_id: `grammy:${deliveryID}` });
        if (!delivery.duplicate) void deliverLoginCode(recipient, code, delivery.chatIDs, expiresAt).catch((error) => console.error("OTP dispatch failed", error));
      }).catch((error) => {
        const conflict = error.message === "IDEMPOTENCY_CONFLICT";
        const retired = error.message === "NUMBER_RETIRED";
        const unbound = error.message === "RECIPIENT_UNAVAILABLE";
        if (!conflict && !retired && !unbound) console.error("OTP webhook failed", error);
        json(response, conflict ? 409 : unbound ? 422 : 400, { accepted: false, error_code: conflict ? "IDEMPOTENCY_CONFLICT" : retired ? "RECIPIENT_INVALID" : unbound ? "RECIPIENT_UNAVAILABLE" : "JSON_INVALID", retryable: false });
      });
    } catch (error) {
      console.error("OTP webhook failed", error);
      json(response, 400, { accepted: false, error_code: "JSON_INVALID", retryable: false });
    }
  });
});

server.listen(config.codePort, config.codeHost, () => console.log(`OTP webhook listening on http://${config.codeHost}:${config.codePort}`));

const me = await bot.api.getMe();
bot.botInfo = me;
console.log(`Starting @${me.username}`);
console.log(`Bot mode: ${config.botMode}`);
if (config.telegramProxy) console.log(`Proxy: ${describeProxy(config.telegramProxy)}`);
await bot.api.setMyCommands(commandList(config.defaultLanguage));
await bot.api.setMyCommands(commandList("ru"), { language_code: "ru" });
await bot.api.setMyCommands(commandList("en"), { language_code: "en" });

await recurring.start();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return; stopping = true; console.log(`Stopping on ${signal}`);
  recurring.stop(); bot.stop(); server.close(); await db.close();
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

await bot.start({ allowed_updates: ["message", "callback_query", "pre_checkout_query"], onStart: () => console.log("Bot polling started") });
