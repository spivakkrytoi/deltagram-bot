import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { randomInt, randomBytes } from "node:crypto";
import { buildPayload, catalog, findProduct, KINDS, localizeProduct, normalizeUsername, parsePayload, productsOfKind } from "./catalog.js";
import { stripCustomEmoji, stripMarkupEmoji } from "./emoji.js";
import { normalizeLanguage, translate, translateError } from "./i18n.js";
import { mainMenuKeyboard, mainMenuText } from "./menu.js";
import { isRandomMode, isRealMode, rejectRandomInRealMode } from "./real-number.js";
import { createProxyAgent, describeProxy } from "./proxy.js";
import {
  dueDateFor,
  formatZonedClock,
  isValidRecurringTimezone,
  nextGrantDate,
  normalizeRecurringSettings,
  parseRecurringTime,
  TIMEZONE_PRESETS,
} from "./recurring.js";

const spinPrizes = Object.freeze([
  { amount: 50, weight: 250 }, { amount: 100, weight: 130 }, { amount: 500, weight: 50 },
  { amount: 1000, weight: 30 }, { amount: 10000, weight: 10 }, { amount: 15, weight: 530 },
]);

function escapeHTML(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function catalogContext(db) {
  const [starsRate, prices] = await Promise.all([db.starsRate(), db.productPrices()]);
  return { starsRate, prices };
}

function initialLanguage(from, fallback) { return normalizeLanguage(from?.language_code, fallback); }
function isOwner(config, id) { return config.ownerIDs.has(id); }
function userName(from) { return from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" "); }
function positiveInteger(value, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= max ? number : 0;
}
// Non-admin product recipients may be Telegram IDs or bot-known usernames.
async function resolveTelegramTarget(db, value) {
  const raw = String(value ?? "").trim();
  const telegramID = positiveInteger(raw);
  if (telegramID) return telegramID;
  if (!raw) return 0;
  const user = await db.userByUsername(raw);
  return user?.telegram_id && Number.isSafeInteger(user.telegram_id) ? user.telegram_id : 0;
}
function parseDeltaGramID(value) {
  const raw = String(value ?? "");
  return /^[1-9]\d*$/.test(raw) ? positiveInteger(raw) : 0;
}
async function adminTelegramTarget(db, value) {
  const id = parseDeltaGramID(value);
  if (!id) throw new Error("invalid DeltaGram ID");
  const user = await db.userByServerUserID(id);
  if (!user || Number(user.server_user_id) !== id) throw new Error("DeltaGram ID is not linked to a bot user");
  return positiveInteger(user.telegram_id);
}
function parseModerationTarget(value) {
  const [idRaw, stateRaw, extra] = String(value ?? "").trim().split(/\s+/);
  const id = parseDeltaGramID(idRaw);
  if (!id || extra) throw new Error("invalid DeltaGram ID or state");
  if (stateRaw === undefined || /^(1|on|yes|true)$/i.test(stateRaw)) return { id, on: true };
  if (/^(0|off|no|false)$/i.test(stateRaw)) return { id, on: false };
  throw new Error("invalid state: use on or off");
}
function formatEpoch(epochSeconds) {
  if (!epochSeconds) return "";
  const date = new Date(Number(epochSeconds) * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getUTCDate()).padStart(2, "0")}.${String(date.getUTCMonth() + 1).padStart(2, "0")} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

const adminErrorCodes = Object.freeze({ USERNAME_OCCUPIED: "errorUsernameOccupied" });

// Surface gramsrv failures with their reason (a stable code or raw 400 text)
// instead of a generic crash. Unmapped codes still carry the visible reason.
// Gramsrv errors always carry a code; route those by code so the message-text
// fallback table (which keys on words like "username") cannot misread a route.
function adminErrorMessage(language, error) {
  const code = error?.code;
  if (code) {
    if (adminErrorCodes[code]) return translate(language, adminErrorCodes[code]);
    const detail = [code, error?.message].filter(Boolean).join(": ");
    return translate(language, "adminOperationFailed", { detail: escapeHTML(detail || String(error ?? "")) });
  }
  const translated = translateError(language, error);
  if (translated !== translate(language, "genericError")) return translated;
  return translate(language, "adminOperationFailed", { detail: escapeHTML(String(error?.message || error || "")) });
}

// gramsrv account actions (mints, verified, frozen, flags) take the gramsrv
// account id, not the Telegram id. Resolve the admin's Telegram target onto its
// linked gramsrv account; 0 means no account is linked (nothing to act on).
async function gramsrvUserIDOf(db, telegramID) {
  const user = await db.user(telegramID);
  if (!user) return 0;
  return Number.isSafeInteger(user.server_user_id) && user.server_user_id > 0 ? user.server_user_id : 0;
}
export function isStartCommand(text) { return /^\/start(?:@\w+)?(?:\s|$)/i.test(text ?? ""); }

export function fulfillmentForSale(sale, starsRate = 20, prices = {}) {
  if (sale?.fulfillment?.kind) return sale.fulfillment;
  if (!sale) throw new Error("sale not found");
  if (sale.product === "custom") return { kind: "custom" };
  let parsed = null;
  try { if (sale.invoice_payload) parsed = parsePayload(sale.invoice_payload); } catch {}
  const product = findProduct(sale.product, starsRate, prices);
  if (!product) throw new Error("could not identify the fulfilled product");
  if (product.kind === KINDS.stars) {
    const titleAmount = Number(String(sale.title).match(/^(\d+)(?:\s+\S+)?\s+Stars$/)?.[1] ?? 0);
    const amount = parsed?.starsAmount || titleAmount || product.starsAmount;
    return { kind: "stars", recipientID: sale.recipient_id, amount };
  }
  if (product.kind === KINDS.premium) return { kind: "premium", recipientID: sale.recipient_id, months: product.months, entitlementID: 0 };
  if (product.kind === KINDS.username) return { kind: "username", recipientID: sale.recipient_id, username: normalizeUsername(parsed?.extra), bid: product.bid };
  throw new Error("legacy number sale has no exact fulfillment data and requires manual review");
}

export async function reverseSaleFulfillment(sale, db, gramsrv, actor = "") {
  const { starsRate, prices } = await catalogContext(db);
  const item = fulfillmentForSale(sale, starsRate, prices);
  const key = `refund:${sale.charge_id}:${item.kind}`;
  if (item.kind === "custom") return item;
  if (item.kind === "stars") await gramsrv.debitStars(item.recipientID, item.amount, "Telegram bot refund", key, false, actor);
  else if (item.kind === "premium") {
    if (!positiveInteger(item.entitlementID)) throw new Error("legacy Premium sale has no entitlement ID; automatic reversal is unsafe");
    await gramsrv.revokePremium(item.recipientID, item.entitlementID, "Telegram bot refund", key, actor);
  } else if (item.kind === "username") {
    if (!item.username) throw new Error("sale has no stored @username");
    await gramsrv.revokeUsername(item.username, item.recipientID, key, false, actor);
  } else if (item.kind === "number") {
    if (!positiveInteger(item.numberID) || !item.phone) throw new Error("sale has no stored number data");
    await db.revokePurchasedNumber(item.ownerID, item.numberID, item.phone, (phone) => gramsrv.resolveUserByPhone(phone));
  } else throw new Error("unknown fulfillment kind");
  return item;
}

export async function executeCompensatedRefund({ sale, telegramID, db, gramsrv, refundStarPayment, actor = "" }) {
  const chargeID = sale.charge_id;
  const refund = await db.beginRefund(chargeID, telegramID);
  try {
    if (!refund.internal_reversed) {
      await reverseSaleFulfillment(sale, db, gramsrv, actor);
      await db.markRefundInternal(chargeID);
    }
    try { await refundStarPayment(telegramID, chargeID); }
    catch (error) {
      if (!/REFUND.*ALREADY|ALREADY.*REFUND/i.test(String(error?.description ?? error?.message ?? error))) throw error;
    }
    await db.markRefunded(chargeID, telegramID);
  } catch (error) {
    await db.failRefund(chargeID, error.message);
    throw error;
  }
}

// Enforces the "one active number per Telegram account" invariant in the bot
// DB. Any user that still owns extra non-retired numbers (left behind by earlier
// logic) gets them removed: free numbers go back to the pool, purchased +888
// numbers are retired forever. Exactly one retained number is kept. If an extra
// number is still bound to a server account ("signed up"), that account is
// rebound to the kept number first so the removal never strands the user's
// account phone. A failed lookup or rebind fails closed: the extra number is
// kept untouched so no OTP route is lost.
export async function runNumberRetention({ db, gramsrv, log = console }) {
  const owners = await db.duplicateNumberOwners();
  for (const ownerID of owners) {
    try {
      const owned = (await db.numbers(ownerID)) ?? [];
      const current = owned.find((number) => number.is_current);
      if (!current || owned.length <= 1) continue;
      let anyMovable = false;
      for (const number of owned) {
        if (number.id === current.id) continue;
        let accountID = 0;
        try { accountID = await gramsrv.resolveUserByPhone(number.phone); }
        catch (error) { log.error?.("Retention account lookup failed", ownerID, number.phone, error); continue; }
        if (accountID > 0) {
          try {
            await gramsrv.setPhone(accountID, current.phone, "Retention rebind to current number", `retention:${ownerID}:${number.phone}:${current.phone}`);
            log.log?.(`Rebound account ${accountID} from ${number.phone} to ${current.phone} (telegram ${ownerID})`);
          } catch (error) {
            log.error?.("Retention rebind failed", ownerID, number.phone, error);
            continue;
          }
        }
        anyMovable = true;
      }
      if (!anyMovable) continue;
      const result = await db.cleanupDuplicateNumbers(ownerID, current.id);
      if (result.removed + result.retired > 0) log.log?.(`Released ${result.removed} free and retired ${result.retired} number(s) for telegram ${ownerID}; kept ${result.keptPhone}`);
    } catch (error) {
      log.error?.("Number retention cleanup failed", ownerID, error);
    }
  }
  return owners.length;
}

export function mainKeyboard(language, admin = false, options = {}) {
  return mainMenuKeyboard(language, { admin, ...options });
}

export function backKeyboard(language, target = "menu:home") {
  return new InlineKeyboard().text(translate(language, "back"), target);
}

function countryKeyboard(language, backTarget = "menu:numbers") {
  return new InlineKeyboard()
    .text(translate(language, "countryRU"), "numbers:new:RU")
    .text(translate(language, "countryUA"), "numbers:new:UA")
    .row()
    .text(translate(language, "countryUS"), "numbers:new:US")
    .row()
    .text(translate(language, "back"), backTarget);
}

export function shopKeyboard(language) {
  return new InlineKeyboard()
    .text(translate(language, "buttonStars"), "shop:stars").row()
    .text(translate(language, "buttonNumber"), "request:number").text(translate(language, "buttonUsername"), "request:username").row()
    .text(translate(language, "back"), "menu:home");
}

export function settingsKeyboard(language, user, config) {
  const current = normalizeLanguage(user?.language, language);
  const russian = `${current === "ru" ? "✅ " : ""}${translate(language, "languageRussian")}`;
  const english = `${current === "en" ? "✅ " : ""}${translate(language, "languageEnglish")}`;
  const kb = new InlineKeyboard()
    .text(translate(language, "accountButton"), "settings:account").row()
    .text(russian, "settings:lang:ru").text(english, "settings:lang:en").row()
    .text(translate(language, user?.notifications ? "notificationsOn" : "notificationsOff"), "settings:notifications").row();
  if (config && isRealMode(config)) {
    kb.text(translate(language, "phoneTitle"), "settings:phone").row();
  }
  kb.text(translate(language, "back"), "menu:home");
  return kb;
}

export function accountKeyboard(language) {
  return new InlineKeyboard()
    .text(translate(language, "accountFetchButton"), "settings:account:fetch").row()
    .text(translate(language, "accountEnterButton"), "settings:account:enter").row()
    .text(translate(language, "back"), "menu:settings");
}

export function adminKeyboard(language) {
  return new InlineKeyboard()
    .text(translate(language, "adminStatsButton"), "admin:stats").text(translate(language, "adminBroadcastButton"), "admin:broadcast").text(translate(language, "adminLookupButton"), "admin:lookup").row()
    .text(translate(language, "adminGrantsButton"), "admin:grants").text(translate(language, "adminVerifiedButton"), "admin:verified").row()
    .text(translate(language, "adminFreezeButton"), "admin:freeze").text(translate(language, "adminScamButton"), "admin:scam").text(translate(language, "adminFakeButton"), "admin:fake").row()
    .text(translate(language, "adminInvoiceButton"), "admin:invoice").text(translate(language, "adminRefundButton"), "admin:refund").row()
    .text(translate(language, "adminReplyButton"), "admin:reply").text(translate(language, "adminPricesButton"), "admin:prices").row()
    .text(translate(language, "adminRecurringButton"), "admin:recurring").text(translate(language, "adminPromoButton"), "admin:promo").row()
    .text(translate(language, "adminAccessButton"), "admin:access").text(translate(language, "back"), "menu:home");
}

export function adminRecurringKeyboard(language, settings) {
  const kb = new InlineKeyboard()
    .text(translate(language, "adminRecurringAddButton"), "admin:recurring:add").row()
    .text(translate(language, "adminRecurringTimeButton", { time: settings.time }), "admin:recurring:time").row()
    .text(translate(language, "adminRecurringTimezoneButton", { timezone: settings.timezone }), "admin:recurring:tz").row()
    .text(translate(language, settings.enabled ? "adminRecurringDisableButton" : "adminRecurringEnableButton"), "admin:recurring:toggle").row()
    .text(translate(language, "adminRecurringRunButton"), "admin:recurring:run").row()
    .text(translate(language, "adminRecurringDeleteButton"), "admin:recurring:delete").text(translate(language, "adminRecurringClearButton"), "admin:recurring:clear").row()
    .text(translate(language, "back"), "admin:menu");
  return kb;
}

export function adminGrantsKeyboard(language) {
  return new InlineKeyboard()
    .text(translate(language, "adminStarsButton"), "admin:stars").row()
    .text(translate(language, "adminGrantNumberButton"), "admin:grantnumber").row()
    .text(translate(language, "adminGrantUsernameButton"), "admin:grantusername").text(translate(language, "adminBindPhoneButton"), "admin:bindphone").row()
    .text(translate(language, "adminRevokeNumberButton"), "admin:revokenumber").row()
    .text(translate(language, "back"), "admin:menu");
}

export function commandList(language) {
  return [
    { command: "start", description: translate(language, "commandStart") },
    { command: "promo_code", description: translate(language, "commandPromo") },
  ];
}

function isCustomEmojiError(error) {
  const text = String(error?.description ?? error?.message ?? error ?? "");
  return /custom emoji/i.test(text) || /CUSTOM_EMOJI/.test(text);
}

async function replyWithEmojiFallback(ctx, message, options) {
  try {
    return await ctx.reply(message, options);
  } catch (error) {
    if (!isCustomEmojiError(error)) throw error;
    // The bot cannot use custom emoji (no Fragment username and the owner has
    // no Premium): resend the same menu with plain emoji.
    return ctx.reply(stripCustomEmoji(message), { ...options, reply_markup: stripMarkupEmoji(options?.reply_markup) });
  }
}

async function editOrReply(ctx, message, keyboard = undefined) {
  const options = { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard };
  if (ctx.callbackQuery?.message) {
    try { return await ctx.editMessageText(message, options); }
    catch (error) {
      if (isCustomEmojiError(error)) return editOrReply(ctx, stripCustomEmoji(message), stripMarkupEmoji(keyboard));
      if (!String(error.description ?? error).includes("message is not modified")) throw error;
    }
    return;
  }
  return replyWithEmojiFallback(ctx, message, options);
}

async function subscribed(ctx, config) {
  if (!config.requiredChannel || isOwner(config, ctx.from.id)) return true;
  try {
    const member = await ctx.api.getChatMember(config.requiredChannel, ctx.from.id);
    return ["creator", "administrator", "member"].includes(member.status) || (member.status === "restricted" && member.is_member === true);
  } catch {
    return false;
  }
}

async function subscriptionGate(ctx, config, language) {
  const kb = new InlineKeyboard();
  if (config.requiredChannelURL) kb.url(translate(language, "openChannel"), config.requiredChannelURL).row();
  kb.text(translate(language, "checkSubscription"), "subscription:check");
  await editOrReply(ctx, translate(language, "subscriptionPrompt"), kb);
}

function parseStartRef(ctx) {
  const match = String(ctx.match ?? "").match(/^ref_(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function productText(product, language, note = "") {
  const extra = product.kind === KINDS.username
    ? `\n${translate(language, "productBid", { bid: product.bid })}`
    : product.kind === KINDS.stars ? `\n${translate(language, "productCredit", { amount: product.starsAmount })}` : "";
  return `<b>${escapeHTML(product.title)}</b>\n\n${escapeHTML(product.description)}\n\n${translate(language, "productPrice", { price: product.starsPrice })}${extra}${note}`;
}

function productKeyboard(product, db, buyerID, language) {
  const kb = new InlineKeyboard();
  if (product.kind === KINDS.number) {
    return kb.text(translate(language, "buyFor", { price: product.starsPrice }), `buy:${product.code}:0`).row().text(translate(language, "back"), `shop:${product.kind}`);
  }
  const selfID = db._cachedUser?.server_user_id ?? 0;
  if (selfID > 0) kb.text(translate(language, "buySelf"), `buy:${product.code}:${selfID}`).row();
  kb.text(translate(language, "giftOther"), `target:${product.code}`).row();
  return kb.row().text(translate(language, "back"), `shop:${product.kind}`);
}

async function hasActiveAnonymousNumber(db, ownerID) {
  const current = await db.currentNumber(ownerID);
  return Boolean(current && current.format !== "free");
}

async function freeDailyLimitReached(ctx, db, language) {
  const limit = await db.freeNumberDailyLimit();
  if (!(limit > 0)) return false;
  if (await db.freeNumberDailyCount(ctx.from.id) >= limit) {
    await editOrReply(ctx, translate(language, "errorFreeDailyLimit"), backKeyboard(language, "menu:numbers"));
    return true;
  }
  return false;
}

async function sendInvoice(ctx, product, targetUserID, language, extra = "") {
  const localized = localizeProduct(product, language);
  const starsAmount = product.kind === KINDS.stars ? product.starsAmount : 0;
  await ctx.api.sendInvoice(ctx.chat.id, localized.title, localized.description, buildPayload(product.code, targetUserID, extra, starsAmount), "XTR", [{ label: localized.title, amount: product.starsPrice }]);
}

function customPayload(request) {
  return `custom|${Buffer.from(JSON.stringify(request), "utf8").toString("base64url")}`;
}

function parseCustomPayload(payload) {
  if (!String(payload).startsWith("custom|")) return null;
  try {
    const value = JSON.parse(Buffer.from(String(payload).slice(7), "base64url").toString("utf8"));
    if (!value || (value.kind !== "number" && value.kind !== "username") || !Number.isSafeInteger(Number(value.serverUserID)) || Number(value.serverUserID) <= 0) return null;
    if (value.kind === "number" && !/^\+888[0-9]{3,12}$/.test(value.value)) return null;
    if (value.kind === "username" && !normalizeUsername(value.value)) return null;
    return { ...value, serverUserID: Number(value.serverUserID) };
  } catch { return null; }
}

function legacyCustomTitle(payload) {
  if (!String(payload).startsWith("custom|")) return "";
  try {
    const title = Buffer.from(String(payload).slice(7), "base64url").toString("utf8");
    return title && title.length <= 64 ? title : "";
  } catch { return ""; }
}

function rollPrize() {
  const total = spinPrizes.reduce((sum, value) => sum + value.weight, 0);
  let value = randomInt(total);
  for (const prize of spinPrizes) { value -= prize.weight; if (value < 0) return prize.amount; }
  return 15;
}

export function createBot({ config, db, gramsrv, recurring = null }) {
  const bot = config.telegramProxy
    ? new Bot(config.botToken, { client: { baseFetchConfig: { agent: createProxyAgent(config.telegramProxy) } } })
    : new Bot(config.botToken);
  const languageOf = (id) => normalizeLanguage(db._userCache?.get(id)?.language, config.defaultLanguage);
  const tr = (id, key, variables = {}) => translate(languageOf(id), key, { product: escapeHTML(config.productName), ...variables });
  const localized = (id, product) => localizeProduct(product, languageOf(id));
  const phoneShareMessages = new Map();
  const recurringDefaults = {
    enabled: config.recurringStarsEnabled,
    time: config.recurringStarsTime,
    timezone: config.recurringStarsTimezone,
  };

  async function recurringContext() {
    const [rawSettings, stats, recipients] = await Promise.all([
      db.recurringSettings(),
      db.recurringStats(),
      db.recurringRecipients(),
    ]);
    return { settings: normalizeRecurringSettings(rawSettings, recurringDefaults), stats, recipients };
  }

  async function recurringPanel(ownerID, language) {
    const { settings, stats, recipients } = await recurringContext();
    const lines = recipients.slice(0, 30).map((row) => {
      const account = Number(row.server_user_id);
      const amount = Number(row.amount);
      const mark = row.enabled ? "✅" : "⏸";
      const last = row.last_granted_date ? escapeHTML(String(row.last_granted_date)) : "—";
      const telegram = Number(row.telegram_id) > 0 ? ` · TG <code>${Number(row.telegram_id)}</code>` : "";
      const error = row.last_error ? ` · ❌ ${escapeHTML(String(row.last_error).slice(0, 60))}` : "";
      return `${mark} <code>${account}</code> · ${amount} ⭐ · ${last}${telegram}${error}`;
    });
    if (recipients.length > lines.length) {
      lines.push(tr(ownerID, "adminRecurringMore", { count: String(recipients.length - lines.length) }));
    }
    const list = lines.length ? lines.join("\n") : tr(ownerID, "adminRecurringEmpty");
    const text = tr(ownerID, "adminRecurringTitle", {
      status: tr(ownerID, settings.enabled ? "adminRecurringStatusOn" : "adminRecurringStatusOff"),
      time: settings.time,
      timezone: settings.timezone,
      local: formatZonedClock(new Date(), settings.timezone),
      count: String(stats.total),
      enabled: String(stats.enabled),
      dailyTotal: String(stats.daily_total ?? 0),
      next: `${nextGrantDate(new Date(), settings.time, settings.timezone)} ${settings.time}`,
      list,
    });
    return { text, keyboard: adminRecurringKeyboard(language, settings) };
  }

  // A repeat +888 buyer (already owns a paid anonymous number) gets a discount
  // configured by the admin. The effective price is applied to the shop list,
  // product page, invoice, pre-checkout validation and the sale snapshot.
  async function effectiveNumberPrice(buyerID, product) {
    if (product.kind !== KINDS.number) return product.starsPrice;
    const current = await db.currentNumber(buyerID);
    if (!current || current.format === "free") return product.starsPrice;
    const discount = await db.numberDiscountPercent();
    if (!discount) return product.starsPrice;
    return Math.max(1, Math.round((product.starsPrice * (100 - discount)) / 100));
  }

  async function effectiveProduct(buyerID, product) {
    const price = await effectiveNumberPrice(buyerID, product);
    return price === product.starsPrice ? product : { ...product, starsPrice: price };
  }

  function deleteAfter(chatID, messageID, delayMs = 30_000) {
    if (chatID > 0 && messageID) setTimeout(() => bot.api.deleteMessage(chatID, messageID).catch(() => {}), delayMs).unref?.();
  }

  // A ticket is assigned to the admin who answered it. The other admins still
  // receive the full conversation (question + answer) so the thread stays
  // visible to the whole team while ownership is tracked.
  async function notifyOtherAdmins(answeringAdmin, ticketID) {
    const ticket = await db.supportMessage(ticketID);
    if (!ticket) return;
    for (const owner of config.ownerIDs) {
      if (owner === answeringAdmin) continue;
      const answeredBy = Number(ticket.answered_by) || answeringAdmin;
      const message = `${tr(owner, "supportAnswerNotification", { ticket: ticketID, question: escapeHTML(ticket.text), answer: escapeHTML(ticket.answer || "") })}\n${tr(owner, "supportAnsweredBy", { admin: String(answeredBy) })}`;
      await bot.api.sendMessage(owner, message, { parse_mode: "HTML" }).catch(() => {});
    }
  }

  async function sendRatingPrompt(ticketID, telegramID) {
    const kb = new InlineKeyboard();
    for (let i = 1; i <= 5; i++) kb.text(`⭐${i}`, `rate:${ticketID}:${i}`);
    await bot.api.sendMessage(telegramID, tr(telegramID, "supportRatePrompt", { ticket: ticketID }), { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  }

  async function numbersMenu(ctx) {
    const currentNumber = await db.currentNumber(ctx.from.id);
    if (isRealMode(config)) {
      const bound = await db.verifiedPhone(ctx.from.id);
      const language = languageOf(ctx.from.id);
      if (!bound && !currentNumber) {
        const { phoneShareKeyboard } = await import("./real-number.js");
        const sent = await ctx.reply(`${tr(ctx.from.id, "phoneTitle")}\n\n${tr(ctx.from.id, "phoneIntro")}`, { parse_mode: "HTML", reply_markup: phoneShareKeyboard(language) });
        phoneShareMessages.set(ctx.chat.id, sent.message_id);
        return sent;
      }
      const lines = [tr(ctx.from.id, "numbersTitle")];
      if (bound) lines.push(tr(ctx.from.id, "phoneStatus", { phone: escapeHTML(bound.phone) }));
      if (currentNumber) lines.push(tr(ctx.from.id, "numberReserved", { phone: escapeHTML(currentNumber.display) }));
      const kb = new InlineKeyboard();
      if (bound) kb.text(tr(ctx.from.id, "phoneUnbindButton"), "phone:unbind").row();
      kb.text(tr(ctx.from.id, "back"), "menu:home");
      return editOrReply(ctx, lines.join("\n\n"), kb);
    }
    const numbers = await db.numbers(ctx.from.id);
    const list = numbers.slice(0, 10).map((number) => `${number.is_current ? "▶️" : "▫️"} <code>${escapeHTML(number.display)}</code>`).join("\n");
    const purchasedOwned = currentNumber && currentNumber.format !== "free";
    const kb = new InlineKeyboard();
    if (!currentNumber) kb.text(tr(ctx.from.id, "newFreeNumber"), "numbers:new").row();
    kb.text(tr(ctx.from.id, "back"), "menu:home");
    const note = currentNumber ? "\n\nНомер закреплён навсегда. Бесплатная замена недоступна." : "";
    return editOrReply(ctx, `${tr(ctx.from.id, "numbersTitle")}\n\n${list || "—"}${note}`, kb);
  }

  db._userCache = new Map();

  // L7 rate limiting: a per-user sliding window over all updates. Owners are
  // exempt. The first breach in a window triggers a single notice; all further
  // hits are dropped silently so a flood never reaches the database or the
  // gramsrv Admin API.
  const rateBuckets = new Map();
  bot.use(async (ctx, next) => {
    if (!ctx.from || isOwner(config, ctx.from.id)) return next();
    const max = (config.rateLimitMaxRequests ?? 120) || 120;
    const windowMs = (config.rateLimitWindowSeconds ?? 60) * 1000;
    const nowMs = Date.now();
    let bucket = rateBuckets.get(ctx.from.id);
    if (!bucket || nowMs - bucket.start >= windowMs) {
      bucket = { start: nowMs, count: 0, noticed: false };
      rateBuckets.set(ctx.from.id, bucket);
    }
    bucket.count++;
    if (bucket.count <= max) return next();
    if (!bucket.noticed) {
      bucket.noticed = true;
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: tr(ctx.from.id, "tooManyRequests"), show_alert: true }).catch(() => {});
      else await ctx.reply(tr(ctx.from.id, "tooManyRequests"), { parse_mode: "HTML" }).catch(() => {});
    }
  });
  setInterval(() => {
    const windowMs = (config.rateLimitWindowSeconds ?? 60) * 1000;
    const cutoff = Date.now() - windowMs;
    for (const [id, bucket] of rateBuckets) if (bucket.start < cutoff) rateBuckets.delete(id);
  }, 60_000).unref?.();

  bot.use(async (ctx, next) => {
    // Account/number flows and OTP routing are private-chat only.
    if (ctx.chat && ctx.chat.type !== "private") return;
    const isStart = isStartCommand(ctx.message?.text);
    if (ctx.from && ctx.chat && !isStart) {
      const user = await db.upsertUser(ctx.from, ctx.chat.id, initialLanguage(ctx.from, config.defaultLanguage));
      db._userCache.set(ctx.from.id, user);
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    const referrer = parseStartRef(ctx);
    const existed = await db.user(ctx.from.id);
    const user = await db.upsertUser(ctx.from, ctx.chat.id, initialLanguage(ctx.from, config.defaultLanguage), referrer, config.referralBonus);
    db._userCache.set(ctx.from.id, user);
    const language = languageOf(ctx.from.id);
    if (!(await subscribed(ctx, config))) return subscriptionGate(ctx, config, language);

    if (isRandomMode(config)) {
      const number = await db.currentNumber(ctx.from.id);
      const referralApplied = !existed && referrer > 0 && (await db.user(ctx.from.id))?.referred_by === referrer;
      const lines = [tr(ctx.from.id, "startHello")];
      if (number) lines.push(tr(ctx.from.id, "startPhone", { phone: escapeHTML(number.display) }));
      else lines.push(tr(ctx.from.id, "chooseInitialCountry"));
      if (referralApplied) lines.push(tr(ctx.from.id, "referralAccepted"));
      const replyMarkup = number ? mainKeyboard(language, isOwner(config, ctx.from.id), { downloadUrl: config.downloadUrl }) : countryKeyboard(language, "menu:home");
      await replyWithEmojiFallback(ctx, lines.join("\n\n"), { parse_mode: "HTML", reply_markup: replyMarkup });
    } else {
      const bound = await db.verifiedPhone(ctx.from.id);
      const lines = [tr(ctx.from.id, "startHello")];
      if (bound) {
        lines.push(tr(ctx.from.id, "phoneStatus", { phone: escapeHTML(bound.phone) }));
      }
      const referralApplied = !existed && referrer > 0 && (await db.user(ctx.from.id))?.referred_by === referrer;
      if (referralApplied) lines.push(tr(ctx.from.id, "referralAccepted"));
      await replyWithEmojiFallback(ctx, lines.join("\n\n"), { parse_mode: "HTML", reply_markup: mainKeyboard(language, isOwner(config, ctx.from.id), { downloadUrl: config.downloadUrl }) });
    }
  });

  bot.command("admin", async (ctx) => {
    if (!isOwner(config, ctx.from.id)) return;
    const language = languageOf(ctx.from.id);
    await editOrReply(ctx, tr(ctx.from.id, "adminTitle"), adminKeyboard(language));
  });

  bot.command("promo_code", async (ctx) => {
    const language = languageOf(ctx.from.id);
    const [code] = String(ctx.match ?? "").trim().split(/\s+/);
    const linked = await db.user(ctx.from.id);
    if (!code) return ctx.reply(tr(ctx.from.id, "promoUsage", { product: config.productName.toUpperCase() }));
    try {
      const promo = await db.claimPromo(code, ctx.from.id);
      const serverID = Number(linked?.server_user_id);
      if (!Number.isSafeInteger(serverID) || serverID <= 0) return ctx.reply(tr(ctx.from.id, "promoNoAccount"));
      try { await gramsrv.grantStars(serverID, promo.stars_amount, `Promo ${code}`, `promo:${code.toLowerCase()}:${ctx.from.id}`); }
      catch (error) { await db.releaseCampaignClaim("promo", code.toLowerCase(), ctx.from.id); throw error; }
      await ctx.reply(tr(ctx.from.id, "promoGranted", { amount: promo.stars_amount }));
    } catch (error) {
      console.error("Promo redemption failed", error);
      await ctx.reply(translateError(language, error));
    }
  });

  bot.on("pre_checkout_query", async (ctx) => {
    const language = languageOf(ctx.from.id);
    try {
      if (ctx.preCheckoutQuery.currency !== "XTR" || ctx.preCheckoutQuery.total_amount <= 0) throw new Error("unsupported currency or amount");
      if (ctx.preCheckoutQuery.invoice_payload.startsWith("custom|")) {
        if (!parseCustomPayload(ctx.preCheckoutQuery.invoice_payload) && !legacyCustomTitle(ctx.preCheckoutQuery.invoice_payload)) throw new Error("invalid invoice");
      } else {
        const parsed = parsePayload(ctx.preCheckoutQuery.invoice_payload);
        const { starsRate, prices } = await catalogContext(db);
        const product = findProduct(parsed.code, starsRate, prices);
        if (!product) throw new Error("unknown product");
        const expected = product.kind === KINDS.number
          ? await effectiveNumberPrice(ctx.from.id, product)
          : product.starsPrice;
        if (expected !== ctx.preCheckoutQuery.total_amount ||
          (product.kind === KINDS.stars && parsed.starsAmount <= 0)) throw new Error("number already owned");
      }
      await ctx.answerPreCheckoutQuery(true);
    } catch {
      await ctx.answerPreCheckoutQuery(false, { error_message: translate(language, "precheckoutInvalid") });
    }
  });

  async function fulfill(product, recipientID, buyer, chatID, chargeID, extra = "", providerChargeID = "") {
    if (product.kind !== KINDS.number && (!Number.isSafeInteger(recipientID) || recipientID <= 0)) throw new Error(`recipient ${config.productName} ID is invalid`);
    if (await db.saleByCharge(chargeID)) return;
    const key = `payment:${chargeID}:${product.code}`;
    let number = null;
    let fulfillment = null;
    if (product.kind === KINDS.premium) {
      const result = await gramsrv.grantPremium(recipientID, product.months, "Telegram bot purchase", key);
      fulfillment = { kind: "premium", recipientID, months: product.months, entitlementID: Number(result?.details?.entitlement_id ?? 0) };
    } else if (product.kind === KINDS.stars) {
      await gramsrv.grantStars(recipientID, product.starsAmount, "Telegram bot purchase", key);
      fulfillment = { kind: "stars", recipientID, amount: product.starsAmount };
    }
    else if (product.kind === KINDS.username) {
      const username = normalizeUsername(extra);
      if (!username) throw new Error("collectible username is invalid");
      await gramsrv.mintUsername(recipientID, username, product.bid, key);
      fulfillment = { kind: "username", recipientID, username, bid: product.bid };
    } else if (product.kind === KINDS.number) {
      recipientID = buyer.id;
      const view = localized(buyer.id, product);
      const account = await db.user(buyer.id);
      const previous = await db.currentNumber(buyer.id);
      let accountID = 0;
      if (account?.server_user_id > 0 && previous?.phone) {
        const resolved = await gramsrv.resolveUserByPhone(previous.phone).catch(() => 0);
        if (resolved === account.server_user_id) accountID = resolved;
      }
      number = await db.fulfillNumberPurchase({ product: product.code, title: view.title, starsPrice: product.starsPrice, recipientID, buyerID: buyer.id, buyerName: userName(buyer), chargeID, providerChargeID }, chatID, product.numberFormat);
      if (number && accountID > 0) {
        for (const [name, step] of [
          ["setPhone", () => gramsrv.setPhone(accountID, number.phone, "Telegram bot number purchase", key)],
          ["mintPhone", () => gramsrv.mintPhone(accountID, number.phone, `${key}:phone`, false)],
        ]) {
          try { await step(); }
          catch (error) {
            console.error(`Failed to ${name} for number purchase`, accountID, error);
            for (const owner of config.ownerIDs) {
              await bot.api.sendMessage(owner, tr(owner, "fulfillmentOwnerError", { charge: escapeHTML(chargeID), error: escapeHTML(`${name} ${accountID} -> ${number.phone}: ${error.message}`) }), { parse_mode: "HTML" }).catch(() => {});
            }
          }
        }
      } else if (number && account?.server_user_id > 0 && previous?.phone && accountID === 0) {
        await bot.api.sendMessage(chatID, tr(buyer.id, "numberManualChange"), { parse_mode: "HTML" }).catch(() => {});
      }
    } else throw new Error("unknown product kind");
    const productView = localized(buyer.id, product);
    if (!number) await db.addSale({ product: product.code, title: productView.title, starsPrice: product.starsPrice, recipientID, buyerID: buyer.id, buyerName: userName(buyer), chargeID, providerChargeID, fulfillment });
    const message = number
      ? tr(buyer.id, "numberReserved", { phone: escapeHTML(number.display) })
      : tr(buyer.id, "productGranted", { title: escapeHTML(productView.title), id: recipientID });
    const sent = await bot.api.sendMessage(chatID, message, { parse_mode: "HTML" }).catch(() => null);
    if (chatID > 0 && sent) deleteAfter(chatID, sent.message_id);
  }

  bot.on("message:successful_payment", async (ctx) => {
    const payment = ctx.message.successful_payment;
    if (!await db.beginPayment(payment.telegram_payment_charge_id, ctx.from.id, payment.invoice_payload, payment.total_amount, payment.provider_payment_charge_id)) return;
    try {
      if (payment.invoice_payload.startsWith("custom|")) {
        const request = parseCustomPayload(payment.invoice_payload);
        if (!request) {
          const title = legacyCustomTitle(payment.invoice_payload);
          if (!title) throw new Error("invalid custom purchase payload");
          await db.addSale({ product: "custom", title, starsPrice: payment.total_amount, recipientID: ctx.from.id, buyerID: ctx.from.id, buyerName: userName(ctx.from), chargeID: payment.telegram_payment_charge_id, providerChargeID: payment.provider_payment_charge_id, fulfillment: { kind: "custom" } });
          await ctx.reply(tr(ctx.from.id, "paymentReceived", { title: escapeHTML(title) }), { parse_mode: "HTML" });
          await db.finishPayment(payment.telegram_payment_charge_id);
          return;
        }
        if (request.kind === "deltament_topup") {
          const serverUserID = Number(request.serverUserID);
          const starsAmount = Number(request.starsAmount);
          if (!Number.isSafeInteger(serverUserID) || serverUserID <= 0 || !Number.isSafeInteger(starsAmount) || starsAmount !== payment.total_amount || !/^[0-9a-f-]{36}$/i.test(String(request.intentID ?? ""))) throw new Error("invalid Deltament top-up payload");
          // DeltaMent top-ups credit the marketplace wallet only. Do not also
          // grant the amount to the main DeltaGram account, otherwise one
          // Telegram payment would be credited twice.
          const settled = await fetch(`${config.deltamentURL}/api/internal/topup/settle`, {
            method: "POST",
            headers: { authorization: `Bearer ${config.deltamentAuthSecret}`, "content-type": "application/json" },
            body: JSON.stringify({ intent_id: request.intentID, charge_id: payment.telegram_payment_charge_id, currency: "XTR", server_user_id: serverUserID, amount: starsAmount, message_id: ctx.message.message_id }),
            signal: AbortSignal.timeout(10000),
          });
          if (!settled.ok) throw new Error(`Deltament top-up settlement failed: ${settled.status}`);
          await ctx.reply(tr(ctx.from.id, "paymentReceived", { title: escapeHTML(`${starsAmount} DeltaMent Stars`) }), { parse_mode: "HTML" });
          await db.addSale({ product: "deltament_topup", title: `${starsAmount} DeltaMent Stars`, starsPrice: payment.total_amount, recipientID: serverUserID, buyerID: ctx.from.id, buyerName: userName(ctx.from), chargeID: payment.telegram_payment_charge_id, providerChargeID: payment.provider_payment_charge_id, fulfillment: { kind: "deltament_topup", intentID: request.intentID, serverUserID, amount: starsAmount } });
          await db.finishPayment(payment.telegram_payment_charge_id);
          return;
        }
        const key = `payment:${payment.telegram_payment_charge_id}:custom:${request.kind}:${request.value}`;
        if (request.kind === "number") {
          if (await gramsrv.resolveUserByPhone(request.value) > 0) throw new Error("NUMBER_OCCUPIED");
          const number = await db.fulfillRequestedNumberPurchase({
            product: "custom_number", title: request.value, starsPrice: payment.total_amount,
            recipientID: request.serverUserID, buyerID: ctx.from.id, buyerName: userName(ctx.from),
            chargeID: payment.telegram_payment_charge_id, providerChargeID: payment.provider_payment_charge_id,
          }, ctx.chat.id, request.value);
          await gramsrv.setPhone(request.serverUserID, number.phone, "Telegram bot +888 purchase", key);
          await gramsrv.mintPhone(request.serverUserID, number.phone, `${key}:phone`);
          await ctx.reply(tr(ctx.from.id, "paymentReceived", { title: escapeHTML(`+888 ${number.display.slice(5)}`) }), { parse_mode: "HTML" });
        } else {
          await gramsrv.mintUsername(request.serverUserID, request.value, 0, key);
          await db.addSale({ product: "custom_username", title: `@${request.value}`, starsPrice: payment.total_amount, recipientID: request.serverUserID, buyerID: ctx.from.id, buyerName: userName(ctx.from), chargeID: payment.telegram_payment_charge_id, providerChargeID: payment.provider_payment_charge_id, fulfillment: { kind: "username", recipientID: request.serverUserID, username: request.value } });
          await ctx.reply(tr(ctx.from.id, "paymentReceived", { title: escapeHTML(`@${request.value}`) }), { parse_mode: "HTML" });
        }
      } else {
        const parsed = parsePayload(payment.invoice_payload);
        const { starsRate, prices } = await catalogContext(db);
        let product = findProduct(parsed.code, starsRate, prices);
        if (!product) throw new Error("product no longer exists");
        if (product.kind === KINDS.number) product = await effectiveProduct(ctx.from.id, product);
        if (payment.currency !== "XTR" || payment.total_amount !== product.starsPrice) throw new Error("paid amount does not match the product");
        if (product.kind === KINDS.stars) {
          if (parsed.starsAmount <= 0) throw new Error("invoice has no snapshotted server Stars amount");
          product = { ...product, starsAmount: parsed.starsAmount, title: `${parsed.starsAmount} Stars`, titleRu: `${parsed.starsAmount} Stars` };
        }
        const recipient = parsed.targetUserID || (await db.user(ctx.from.id))?.server_user_id || 0;
        await fulfill(product, recipient, ctx.from, ctx.chat.id, payment.telegram_payment_charge_id, parsed.extra, payment.provider_payment_charge_id);
      }
      await db.finishPayment(payment.telegram_payment_charge_id);
    } catch (error) {
      await db.failPayment(payment.telegram_payment_charge_id, error);
      console.error("Payment fulfillment failed", payment.telegram_payment_charge_id, error);
      await ctx.reply(tr(ctx.from.id, "paymentFailed", { charge: escapeHTML(payment.telegram_payment_charge_id) }), { parse_mode: "HTML" });
      for (const owner of config.ownerIDs) {
        await bot.api.sendMessage(owner, tr(owner, "fulfillmentOwnerError", { charge: escapeHTML(payment.telegram_payment_charge_id), error: escapeHTML(error.message) }), { parse_mode: "HTML" }).catch(() => {});
      }
    }
  });

  // Explicit recovery for a stored number payment after a database/process
  // failure. Never manufacture a payment or ask the customer to pay again.
  bot.command("retry_payment", async (ctx) => {
    if (!isOwner(config, ctx.from.id)) return;
    try {
      const payment = await db.paymentByCharge(String(ctx.match ?? "").trim());
      if (!payment) throw new Error("payment not found");
      const parsed = parsePayload(payment.invoice_payload);
      const { starsRate, prices } = await catalogContext(db);
      const product = findProduct(parsed.code, starsRate, prices);
      if (product?.kind !== KINDS.number) throw new Error("only stored number payments can be retried");
      const buyer = await db.user(payment.telegram_id);
      if (!buyer) throw new Error("user not found");
      await fulfill({ ...product, starsPrice: payment.amount }, buyer.telegram_id, { id: buyer.telegram_id, first_name: buyer.first_name, username: buyer.username }, buyer.telegram_id, payment.charge_id, "", payment.provider_charge_id);
      await ctx.reply(tr(ctx.from.id, "numberPaymentRecovered"));
    } catch (error) {
      await ctx.reply(translateError(languageOf(ctx.from.id), error));
    }
  });

  bot.callbackQuery(/^subscription:check$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const language = languageOf(ctx.from.id);
    if (await subscribed(ctx, config)) await editOrReply(ctx, mainMenuText(language), mainKeyboard(language, isOwner(config, ctx.from.id), { downloadUrl: config.downloadUrl }));
    else await subscriptionGate(ctx, config, language);
  });

  bot.callbackQuery(/^menu:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = ctx.match[1];
    const user = await db.user(ctx.from.id);
    db._userCache.set(ctx.from.id, user);
    const language = languageOf(ctx.from.id);
    if (page === "home") return editOrReply(ctx, mainMenuText(language), mainKeyboard(language, isOwner(config, ctx.from.id), { downloadUrl: config.downloadUrl }));
    if (page === "numbers") return numbersMenu(ctx);
    if (page === "shop") return editOrReply(ctx, tr(ctx.from.id, "shopTitle"), shopKeyboard(language));
    if (page === "referrals") {
      const username = config.publicUsername || bot.botInfo?.username || "bot";
      const link = `https://t.me/${username}?start=ref_${ctx.from.id}`;
      return editOrReply(ctx, `${tr(ctx.from.id, "referralsTitle")}\n\n${tr(ctx.from.id, "invited", { count: user.referral_count })}\n${tr(ctx.from.id, "referralBonus", { amount: config.referralBonus })}\n\n<code>${link}</code>`, backKeyboard(language));
    }
    if (page === "support") {
      await db.setPending(ctx.from.id, "support");
      return editOrReply(ctx, tr(ctx.from.id, "supportPrompt"), backKeyboard(language));
    }
    if (page === "profile") {
      const phone = await db.verifiedPhone(ctx.from.id);
      const serverID = Number(user?.server_user_id);
      const lines = [
        tr(ctx.from.id, "profileTitle"),
        "",
        Number.isSafeInteger(serverID) && serverID > 0
          ? tr(ctx.from.id, "profileID", { id: serverID })
          : tr(ctx.from.id, "profileNoID"),
        phone ? tr(ctx.from.id, "profilePhone", { phone: escapeHTML(phone.phone) }) : tr(ctx.from.id, "profileNoPhone"),
        user?.username ? tr(ctx.from.id, "profileUsername", { username: escapeHTML(user.username) }) : null,
        tr(ctx.from.id, "profileBalance", { balance: user?.bonus ?? 0 }),
        tr(ctx.from.id, "profileLanguage", { language: tr(ctx.from.id, user?.language === "en" ? "languageNameEn" : "languageNameRu") }),
      ].filter(Boolean);
      const kb = new InlineKeyboard()
        .text(tr(ctx.from.id, "buttonReferrals"), "menu:referrals").text(tr(ctx.from.id, "buttonSupport"), "menu:support").row()
        .text(tr(ctx.from.id, "buttonSettings"), "menu:settings").row()
        .text(tr(ctx.from.id, "back"), "menu:home");
      return editOrReply(ctx, lines.join("\n"), kb);
    }
    if (page === "daily") {
      const result = await db.claimDaily(ctx.from.id, config.dailyBonus);
      return editOrReply(
        ctx,
        result.claimed
          ? tr(ctx.from.id, "dailyClaimed", { amount: config.dailyBonus, balance: result.balance })
          : tr(ctx.from.id, "dailyAlreadyClaimed", { balance: result.balance }),
        backKeyboard(language),
      );
    }
    if (page === "download") {
      const kb = new InlineKeyboard()
        .url(tr(ctx.from.id, "downloadButton"), config.downloadUrl).row()
        .text(tr(ctx.from.id, "back"), "menu:home");
      return editOrReply(ctx, tr(ctx.from.id, "downloadText"), kb);
    }
    if (page === "about") {
      const support = config.publicUsername ? `@${config.publicUsername}` : config.publicBaseURL;
      const text = `${tr(ctx.from.id, "aboutTitle")}\n\n${tr(ctx.from.id, "aboutText", { support: escapeHTML(support) })}`;
      const kb = new InlineKeyboard()
        .text(tr(ctx.from.id, "buttonSupport"), "menu:support").row()
        .text(tr(ctx.from.id, "back"), "menu:home");
      return editOrReply(ctx, text, kb);
    }
    if (page === "settings") return editOrReply(ctx, tr(ctx.from.id, "settingsTitle"), settingsKeyboard(language, user, config));
  });

  bot.callbackQuery(/^numbers:new$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (rejectRandomInRealMode(ctx, config, languageOf(ctx.from.id))) return;
    const language = languageOf(ctx.from.id);
    if (await db.currentNumber(ctx.from.id)) return editOrReply(ctx, "Номер уже выдан и закреплён навсегда.", backKeyboard(language, "menu:numbers"));
    await editOrReply(ctx, tr(ctx.from.id, "chooseCountry"), countryKeyboard(language));
  });

  bot.callbackQuery(/^numbers:new:(RU|UA|US)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (rejectRandomInRealMode(ctx, config, languageOf(ctx.from.id))) return;
    const language = languageOf(ctx.from.id);
    if (await db.currentNumber(ctx.from.id)) return editOrReply(ctx, "Номер уже выдан и закреплён навсегда.", backKeyboard(language, "menu:numbers"));
    try {
      const number = await db.createNumber(ctx.from.id, ctx.chat.id, "free", ctx.match[1], true);
      await editOrReply(ctx, tr(ctx.from.id, "newNumber", { phone: escapeHTML(number.display) }), backKeyboard(language, "menu:numbers"));
    } catch (error) {
      await editOrReply(ctx, translateError(language, error), backKeyboard(language, "menu:numbers"));
    }
  });

  bot.callbackQuery(/^request:(number|username)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const kind = ctx.match[1];
    await db.setPending(ctx.from.id, kind === "number" ? "request_number" : "request_username");
    const prompt = kind === "number"
      ? "Напишите желаемый номер в формате +888 1234 5678. Заявка уйдёт администратору, цену сообщит администратор."
      : "Напишите желаемый NFT username без @. Заявка уйдёт администратору, цену сообщит администратор.";
    return editOrReply(ctx, prompt, backKeyboard(languageOf(ctx.from.id), "menu:shop"));
  });

  bot.callbackQuery(/^shop:(premium|stars|number|username)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const kind = ctx.match[1];
    const language = languageOf(ctx.from.id);
    const kb = new InlineKeyboard();
    const { starsRate, prices } = await catalogContext(db);
    for (const product of productsOfKind(kind, starsRate, prices)) {
      const view = localizeProduct(product, language);
      const price = product.kind === KINDS.number ? await effectiveNumberPrice(ctx.from.id, product) : product.starsPrice;
      kb.text(`${view.title} · ${price} ⭐`, `product:${product.code}`).row();
    }
    if (kind === KINDS.stars) kb.text(tr(ctx.from.id, "customAmountButton"), "stars:custom").row();
    kb.text(tr(ctx.from.id, "back"), "menu:shop");
    await editOrReply(ctx, tr(ctx.from.id, "selectProduct"), kb);
  });

  bot.callbackQuery(/^stars:custom$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await db.setPending(ctx.from.id, "stars_amount");
    await editOrReply(ctx, tr(ctx.from.id, "customAmountPrompt"), backKeyboard(languageOf(ctx.from.id), "shop:stars"));
  });

  bot.callbackQuery(/^product:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const { starsRate, prices } = await catalogContext(db);
    let product = findProduct(ctx.match[1], starsRate, prices);
    if (!product) return;
    const language = languageOf(ctx.from.id);
    if (product.kind === KINDS.premium) return editOrReply(ctx, "Telegram Premium purchases are disabled.", backKeyboard(language, "menu:shop"));
    if (product.kind === KINDS.number) return editOrReply(ctx, "For +888, submit a request instead.", backKeyboard(language, "menu:shop"));
    if (product.kind === KINDS.username) return editOrReply(ctx, "For NFT usernames, submit a request instead.", backKeyboard(language, "menu:shop"));
    let note = "";
    if (product.kind === KINDS.number) {
      const current = await db.currentNumber(ctx.from.id);
      const repeat = current && current.format !== "free";
      const effective = await effectiveProduct(ctx.from.id, product);
      const discounted = effective.starsPrice !== product.starsPrice;
      if (discounted) product = effective;
      if (repeat) {
        note = `\n${tr(ctx.from.id, "numberRepeatWarning")}`;
        if (discounted) note += `\n${tr(ctx.from.id, "numberRepeatDiscount", { percent: await db.numberDiscountPercent() })}`;
      }
    }
    const view = localizeProduct(product, language);
    await editOrReply(ctx, productText(view, language, note), productKeyboard(product, { _cachedUser: db._userCache.get(ctx.from.id) }, ctx.from.id, language));
  });

  bot.callbackQuery(/^target:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await db.setPending(ctx.from.id, "target", { productCode: ctx.match[1] });
    await editOrReply(ctx, tr(ctx.from.id, "targetPrompt"), backKeyboard(languageOf(ctx.from.id), `product:${ctx.match[1]}`));
  });

  bot.callbackQuery(/^buy:([^:]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const { starsRate, prices } = await catalogContext(db);
    let product = findProduct(ctx.match[1], starsRate, prices);
    const targetID = Number(ctx.match[2]);
    if (!product) return;
    const language = languageOf(ctx.from.id);
    if (product.kind === KINDS.number) product = await effectiveProduct(ctx.from.id, product);
    if (product.kind === KINDS.username) {
      await db.setPending(ctx.from.id, "username", { productCode: product.code, targetID });
      return editOrReply(ctx, tr(ctx.from.id, "enterUsername"), backKeyboard(language, `product:${product.code}`));
    }
    if (targetID > 0 && targetID !== (await db.user(ctx.from.id))?.server_user_id) await db.rememberRecipient(ctx.from.id, targetID);
    if (isOwner(config, ctx.from.id)) return fulfill(product, targetID, ctx.from, ctx.chat.id, `owner-${ctx.from.id}-${Date.now()}-${randomInt(1_000_000)}`);
    await sendInvoice(ctx, product, targetID, language);
  });

  bot.callbackQuery(/^settings:lang:(ru|en)$/, async (ctx) => {
    await db.setLanguage(ctx.from.id, ctx.match[1]);
    const user = await db.user(ctx.from.id);
    db._userCache.set(ctx.from.id, user);
    const language = languageOf(ctx.from.id);
    await ctx.answerCallbackQuery({ text: translate(language, "languageChanged") });
    await editOrReply(ctx, tr(ctx.from.id, "settingsTitle"), settingsKeyboard(language, user, config));
  });

  bot.callbackQuery(/^settings:notifications$/, async (ctx) => {
    const enabled = await db.toggleNotifications(ctx.from.id);
    const user = await db.user(ctx.from.id);
    db._userCache.set(ctx.from.id, user);
    const language = languageOf(ctx.from.id);
    await ctx.answerCallbackQuery({ text: tr(ctx.from.id, enabled ? "notificationsEnabled" : "notificationsDisabled") });
    await editOrReply(ctx, tr(ctx.from.id, "settingsTitle"), settingsKeyboard(language, user, config));
  });

  bot.callbackQuery(/^settings:account$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await db.user(ctx.from.id);
    const language = languageOf(ctx.from.id);
    const title = user?.server_user_id
      ? tr(ctx.from.id, "accountMenuID", { id: user.server_user_id })
      : tr(ctx.from.id, "accountMenuTitle");
    await editOrReply(ctx, title, accountKeyboard(language));
  });

  bot.callbackQuery(/^settings:account:enter$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await db.setPending(ctx.from.id, "account");
    await editOrReply(ctx, tr(ctx.from.id, "accountPrompt"), backKeyboard(languageOf(ctx.from.id), "settings:account"));
  });

  bot.callbackQuery(/^settings:account:fetch$/, async (ctx) => {
    const language = languageOf(ctx.from.id);
    try {
      let phone = null;
      if (isRealMode(config)) {
        const verified = await db.verifiedPhone(ctx.from.id);
        phone = verified?.phone ?? null;
      }
      if (!phone) {
        const number = await db.currentNumber(ctx.from.id);
        phone = number?.phone ?? null;
      }
      if (!phone) {
        return ctx.answerCallbackQuery({ text: tr(ctx.from.id, "accountFetchNoPhone"), show_alert: true });
      }
      const serverUserID = await gramsrv.resolveUserByPhone(phone);
      if (!serverUserID) {
        return ctx.answerCallbackQuery({ text: tr(ctx.from.id, "accountFetchNotFound"), show_alert: true });
      }
      await db.setServerUserID(ctx.from.id, serverUserID);
      await db.clearPending(ctx.from.id);
      db._userCache.set(ctx.from.id, await db.user(ctx.from.id));
      const message = tr(ctx.from.id, "accountSaved", { id: serverUserID });
      await ctx.answerCallbackQuery({ text: message });
      return editOrReply(ctx, mainMenuText(language), mainKeyboard(language, isOwner(config, ctx.from.id), { downloadUrl: config.downloadUrl }));
    } catch (error) {
      console.error("Account fetch failed", error);
      const text = String(error?.message ?? "").startsWith("gramsrv ")
        ? tr(ctx.from.id, "accountFetchFailed")
        : translateError(language, error);
      return ctx.answerCallbackQuery({ text, show_alert: true });
    }
  });

  bot.callbackQuery(/^settings:phone$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isRealMode(config)) return;
    const bound = await db.verifiedPhone(ctx.from.id);
    const language = languageOf(ctx.from.id);
    if (!bound) {
      const { phoneShareKeyboard } = await import("./real-number.js");
      const sent = await ctx.reply(`${tr(ctx.from.id, "phoneTitle")}\n\n${tr(ctx.from.id, "phoneIntro")}`, { parse_mode: "HTML", reply_markup: phoneShareKeyboard(language) });
      phoneShareMessages.set(ctx.chat.id, sent.message_id);
      return sent;
    }
    const kb = new InlineKeyboard().text(tr(ctx.from.id, "phoneUnbindButton"), "phone:unbind").row().text(tr(ctx.from.id, "back"), "menu:home");
    await editOrReply(ctx, `${tr(ctx.from.id, "phoneTitle")}\n\n${tr(ctx.from.id, "phoneStatus", { phone: escapeHTML(bound.phone) })}`, kb);
  });

  bot.callbackQuery(/^phone:unbind$/, async (ctx) => {
    if (!isRealMode(config)) return;
    await ctx.answerCallbackQuery({ text: translate(languageOf(ctx.from.id), "phoneUnbound") });
    await db.unbindVerifiedPhone(ctx.from.id);
    return numbersMenu(ctx);
  });

  bot.on("message:contact", async (ctx) => {
    if (!isRealMode(config)) return;
    const language = languageOf(ctx.from.id);
    const shareMsgID = phoneShareMessages.get(ctx.chat.id);
    if (shareMsgID) { phoneShareMessages.delete(ctx.chat.id); ctx.api.deleteMessage(ctx.chat.id, shareMsgID).catch(() => {}); }
    ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
    try {
      if (ctx.message.contact.user_id !== ctx.from.id) throw new Error("errorContactNotOwn");
      const bound = await db.bindVerifiedPhone(ctx.from.id, ctx.chat.id, ctx.message.contact.phone_number);
      const sent = await ctx.reply(tr(ctx.from.id, "phoneBound", { phone: escapeHTML(bound.phone) }), { parse_mode: "HTML" });
      deleteAfter(ctx.chat.id, sent.message_id);
      return replyWithEmojiFallback(ctx, mainMenuText(language), { parse_mode: "HTML", reply_markup: mainKeyboard(language, isOwner(config, ctx.from.id), { downloadUrl: config.downloadUrl }) });
    } catch (error) {
      await ctx.reply(translateError(language, error), { reply_markup: mainKeyboard(language, isOwner(config, ctx.from.id)) });
    }
  });

  bot.callbackQuery(/^giveaway:([a-f0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await db.user(ctx.from.id);
    const language = languageOf(ctx.from.id);
    if (!user.server_user_id) return ctx.reply(tr(ctx.from.id, "giveawayNeedAccount"));
    const id = ctx.match[1];
    try {
      const item = await db.claimGiveaway(id, ctx.from.id);
      try { await gramsrv.grantStars(user.server_user_id, item.stars_amount, `Giveaway ${id}`, `giveaway:${id}:${ctx.from.id}`); }
      catch (error) { await db.releaseCampaignClaim("giveaway", id, ctx.from.id); throw error; }
      await ctx.reply(tr(ctx.from.id, "giveawayGranted", { amount: item.stars_amount }));
    } catch (error) {
      console.error("Giveaway claim failed", error);
      await ctx.reply(translateError(language, error));
    }
  });

  bot.callbackQuery(/^rate:(\d+):([1-5])$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const ticketID = Number(ctx.match[1]);
    const rating = Number(ctx.match[2]);
    const ok = await db.rateSupportTicket(ticketID, rating, ctx.from.id);
    const language = languageOf(ctx.from.id);
    await editOrReply(ctx, ok ? tr(ctx.from.id, "supportRateThanks", { rating }) : tr(ctx.from.id, "supportRateAlready"), backKeyboard(language, "menu:home"));
  });

  bot.callbackQuery(/^admin:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isOwner(config, ctx.from.id)) return;
    const action = ctx.match[1];
    const language = languageOf(ctx.from.id);
    if (action === "menu") return editOrReply(ctx, tr(ctx.from.id, "adminTitle"), adminKeyboard(language));
    if (action === "prices") {
      const { starsRate, prices } = await catalogContext(db);
      const defaults = catalog(starsRate).filter((p) => p.kind !== KINDS.stars).map((p) => ({ code: p.code, title: localizeProduct(p, language).title, default: p.starsPrice }));
      const lines = defaults.map((p) => {
        const current = p.code in prices ? prices[p.code] : p.default;
        const override = p.code in prices ? ` (${p.default})` : "";
        return `<code>${p.code}</code> · ${escapeHTML(p.title)}: <b>${current} ⭐</b>${escapeHTML(override)}`;
      });
      lines.push(`<code>discount ${await db.numberDiscountPercent()}</code>`);
      lines.push(`<code>free ${await db.freeNumberDailyLimit()}</code>`);
      await db.setPending(ctx.from.id, "admin_prices");
      return editOrReply(ctx, `${tr(ctx.from.id, "adminPromptPrices", { rate: String(starsRate) })}\n\n${lines.join("\n")}`, backKeyboard(language, "admin:menu"));
    }
    if (action === "wheel") {
      const limits = await db.wheelLimits();
      await db.setPending(ctx.from.id, "admin_wheel");
      return editOrReply(ctx, tr(ctx.from.id, "adminPromptWheel", {
        daily: String(limits.daily),
        weekly: String(limits.weekly),
        enabled: limits.enabled ? tr(ctx.from.id, "wheelEnabledLabel") : tr(ctx.from.id, "wheelDisabledLabel"),
        max: limits.maxPrize > 0 ? String(limits.maxPrize) : tr(ctx.from.id, "wheelMaxUnlimited"),
      }), backKeyboard(language, "admin:menu"));
    }
    if (action === "grants") return editOrReply(ctx, tr(ctx.from.id, "adminGrantsTitle"), adminGrantsKeyboard(language));
    if (action === "stats") {
      const stats = await db.stats();
      const rows = await db.recentSales(10);
      const sales = rows.map((s) => {
        const name = String(s.buyer_name ?? s.buyer_id ?? "");
        const product = String(s.product ?? s.title ?? "");
        return `#${s.id} · <code>${escapeHTML(s.charge_id)}</code> · ${escapeHTML(product)} · ${s.stars_price} ⭐ · ${escapeHTML(name)}`;
      });
      return editOrReply(ctx, `${tr(ctx.from.id, "adminStats", stats)}\n\n${tr(ctx.from.id, "adminRecentSales")}\n${sales.join("\n") || tr(ctx.from.id, "noSales")}`, backKeyboard(language, "admin:menu"));
    }
    if (action === "lookup") {
      await db.setPending(ctx.from.id, "admin_lookup");
      return editOrReply(ctx, tr(ctx.from.id, "adminPromptLookup"), backKeyboard(language, "admin:menu"));
    }
    if (action === "audit") {
      const commands = typeof gramsrv.adminCommands === "function"
        ? await gramsrv.adminCommands(30).catch((error) => { console.error("Admin audit failed", error); return null; })
        : null;
      const lines = [];
      const ratings = await db.recentSupportRatings(10).catch((error) => { console.error("Support ratings failed", error); return []; });
      for (const cmd of commands ?? []) {
        const status = cmd.status === "failed" ? "❌" : cmd.status === "running" ? "⏳" : "✅";
        const code = cmd.actor ? `<code>${escapeHTML(cmd.actor)}</code>` : "—";
        const target = cmd.target_user_id ? ` · <code>${cmd.target_user_id}</code>` : "";
        const detail = cmd.error ? ` · ❌ <code>${escapeHTML(cmd.error)}</code>` : "";
        const reason = cmd.reason ? ` · ${escapeHTML(cmd.reason)}` : "";
        lines.push(`${status} <code>${escapeHTML(cmd.action)}</code>${target} · ${code} · ${formatEpoch(cmd.created_at ? Math.floor(new Date(cmd.created_at).getTime() / 1000) : 0)}${reason}${detail}`);
      }
      for (const rating of ratings) {
        const admin = rating.answered_by ? `<code>${escapeHTML(String(rating.answered_by))}</code>` : "—";
        lines.push(`⭐ ${tr(ctx.from.id, "adminAuditRating", { ticket: rating.id, stars: "⭐".repeat(rating.rating) })} · ${admin} · ${formatEpoch(rating.rated_at || rating.created_at)}`);
      }
      if (!lines.length) return editOrReply(ctx, tr(ctx.from.id, "adminAuditEmpty"), backKeyboard(language, "admin:menu"));
      return editOrReply(ctx, `${tr(ctx.from.id, "adminAuditTitle")}\n\n${lines.join("\n")}`, backKeyboard(language, "admin:menu"));
    }
    if (action === "recurring" || action.startsWith("recurring:")) {
      if (action === "recurring") {
        const panel = await recurringPanel(ctx.from.id, language);
        return editOrReply(ctx, panel.text, panel.keyboard);
      }
      if (action === "recurring:add") {
        await db.setPending(ctx.from.id, "admin_recurring_add");
        return editOrReply(ctx, tr(ctx.from.id, "adminPromptRecurringAdd"), backKeyboard(language, "admin:recurring"));
      }
      if (action === "recurring:time") {
        await db.setPending(ctx.from.id, "admin_recurring_time");
        return editOrReply(ctx, tr(ctx.from.id, "adminPromptRecurringTime"), backKeyboard(language, "admin:recurring"));
      }
      if (action === "recurring:tz") {
        const { settings } = await recurringContext();
        const index = TIMEZONE_PRESETS.indexOf(settings.timezone);
        const timezone = TIMEZONE_PRESETS[(index + 1) % TIMEZONE_PRESETS.length];
        await db.setSetting("recurring_stars_timezone", timezone);
        const panel = await recurringPanel(ctx.from.id, language);
        return editOrReply(ctx, `${tr(ctx.from.id, "adminRecurringTimezoneSaved", { timezone })}\n\n${panel.text}`, panel.keyboard);
      }
      if (action === "recurring:toggle") {
        const { settings } = await recurringContext();
        await db.setSetting("recurring_stars_enabled", settings.enabled ? "off" : "on");
        const panel = await recurringPanel(ctx.from.id, language);
        return editOrReply(ctx, panel.text, panel.keyboard);
      }
      if (action === "recurring:run") {
        if (!recurring) {
          return editOrReply(ctx, tr(ctx.from.id, "adminRecurringRunUnavailable"), backKeyboard(language, "admin:recurring"));
        }
        const result = await recurring.runNow();
        const text = result.busy
          ? tr(ctx.from.id, "adminRecurringRunBusy")
          : tr(ctx.from.id, "adminRecurringRunDone", {
            ok: String(result.ok), failed: String(result.failed),
            total: String(result.total), date: result.dueDate || "—",
          });
        const panel = await recurringPanel(ctx.from.id, language);
        return editOrReply(ctx, `${text}\n\n${panel.text}`, panel.keyboard);
      }
      if (action === "recurring:delete") {
        await db.setPending(ctx.from.id, "admin_recurring_delete");
        return editOrReply(ctx, tr(ctx.from.id, "adminPromptRecurringDelete"), backKeyboard(language, "admin:recurring"));
      }
      if (action === "recurring:clear") {
        return editOrReply(ctx, tr(ctx.from.id, "adminRecurringClearConfirm"), new InlineKeyboard()
          .text(tr(ctx.from.id, "adminRecurringClearConfirmButton"), "admin:recurring:clearconfirm").row()
          .text(tr(ctx.from.id, "back"), "admin:recurring"));
      }
      if (action === "recurring:clearconfirm") {
        const count = await db.clearRecurringRecipients();
        const panel = await recurringPanel(ctx.from.id, language);
        return editOrReply(ctx, `${tr(ctx.from.id, "adminRecurringCleared", { count: String(count) })}\n\n${panel.text}`, panel.keyboard);
      }
    }
    const promptKeys = {
      broadcast: "adminPromptBroadcast", stars: "adminPromptStars", premium: "adminPromptPremium", promo: "adminPromptPromo",
      giveaway: "adminPromptGiveaway", invoice: "adminPromptInvoice", access: "adminPromptAccess",
      refund: "adminPromptRefund", reply: "adminPromptReply", bindphone: "adminPromptBindPhone", grantnumber: "adminPromptGrantNumber", grantusername: "adminPromptGrantUsername", revokenumber: "adminPromptRevokeNumber",
      verified: "adminPromptVerified", freeze: "adminPromptFreeze", scam: "adminPromptScam", fake: "adminPromptFake",
    };
    if (promptKeys[action]) {
      await db.setPending(ctx.from.id, `admin_${action}`, { operationID: `admin:${ctx.from.id}:${Date.now()}:${randomInt(1_000_000)}` });
      return editOrReply(ctx, tr(ctx.from.id, promptKeys[action], { product: config.productName.toUpperCase() }), backKeyboard(language, "admin:menu"));
    }
  });

  bot.on("message:photo", async (ctx) => {
    if (!isOwner(config, ctx.from.id)) return;
    const pending = await db.pending(ctx.from.id);
    if (pending?.kind !== "admin_broadcast") return;
    await db.clearPending(ctx.from.id);
    let ok = 0, failed = 0;
    for (const user of await db.users()) {
      try { await ctx.api.copyMessage(user.chat_id, ctx.chat.id, ctx.message.message_id); ok++; } catch { failed++; }
    }
    return ctx.reply(tr(ctx.from.id, "broadcastDone", { ok, skipped: 0, failed }), { reply_markup: adminKeyboard(languageOf(ctx.from.id)) });
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const language = languageOf(ctx.from.id);
    const input = ctx.message.text.trim();

    if (input === translate(language, "phoneCancelButton")) {
      const shareMsgID = phoneShareMessages.get(ctx.chat.id);
      if (shareMsgID) { phoneShareMessages.delete(ctx.chat.id); ctx.api.deleteMessage(ctx.chat.id, shareMsgID).catch(() => {}); }
      return replyWithEmojiFallback(ctx, mainMenuText(language), { parse_mode: "HTML", reply_markup: mainKeyboard(language, isOwner(config, ctx.from.id), { downloadUrl: config.downloadUrl }) });
    }

    if (isOwner(config, ctx.from.id) && ctx.message.reply_to_message?.from?.id === (bot.botInfo?.id ?? 0)) {
      const ticketMatch = ctx.message.reply_to_message.text?.match(/#(\d+)/);
      if (ticketMatch) {
        const ticketID = Number(ticketMatch[1]);
        const ticket = await db.supportMessage(ticketID);
        if (!ticket) return ctx.reply(tr(ctx.from.id, "errorTicketMissing"));
        if (!input) return ctx.reply(tr(ctx.from.id, "errorEmptyReply"));
        const requestMatch = /^(Заявка на \+888|Заявка на NFT username):\s*(.+?)\s+\|\s+account=(\d+)$/i.exec(ticket.text || "");
        if (requestMatch) {
          const requestedPrice = Number(input.replace(/^(price|цена)\s*/i, "").trim());
          if (!Number.isSafeInteger(requestedPrice) || requestedPrice <= 0) return ctx.reply("Укажите только цену в Telegram Stars, например: 250");
        }
        const assignedTo = String(ctx.from.id);
        // Atomic claim: only the first admin wins the open -> answered
        // transition; a loser must not deliver a second answer over it.
        const claimed = await db.closeSupportMessage(ticketID, assignedTo, input);
        if (!claimed) {
          return ctx.reply(tr(ctx.from.id, "supportAlreadyAnswered", { ticket: ticketID }), { reply_markup: adminKeyboard(language) });
        }
        if (requestMatch) {
          const price = Number(input.replace(/^(price|цена)\s*/i, "").trim());
          if (!Number.isSafeInteger(price) || price <= 0) return ctx.reply("Укажите только цену в Telegram Stars, например: 250");
          const isNumber = requestMatch[1].includes("+888");
          const title = isNumber ? "+888 номер" : "NFT username";
          const payload = customPayload({ kind: isNumber ? "number" : "username", value: requestMatch[2], serverUserID: Number(requestMatch[3]) });
          await bot.api.sendInvoice(ticket.telegram_id, title, `Заявка: ${requestMatch[2]}`, payload, "XTR", [{ label: title, amount: price }]);
          await notifyOtherAdmins(ctx.from.id, ticketID);
          return ctx.reply(`✅ Инвойс на ${price} ⭐ отправлен пользователю по заявке #${ticketID}.`, { reply_markup: adminKeyboard(language) });
        }
        await bot.api.sendMessage(ticket.telegram_id, tr(ticket.telegram_id, "supportReply", { ticket: ticketID, answer: escapeHTML(input) }), { parse_mode: "HTML" });
        await notifyOtherAdmins(ctx.from.id, ticketID);
        await sendRatingPrompt(ticketID, ticket.telegram_id);
        return ctx.reply(tr(ctx.from.id, "supportReplySent", { ticket: ticketID }), { reply_markup: adminKeyboard(language) });
      }
    }

    const pending = await db.pending(ctx.from.id);
    if (!pending) return;
    const adminResult = async (text, extra = {}) => {
      const sent = await ctx.reply(text, { parse_mode: "HTML", reply_markup: adminKeyboard(language), ...extra });
      if (sent?.message_id) deleteAfter(ctx.chat.id, sent.message_id);
      return sent;
    };
    const toast = async (text, extra = {}) => {
      const sent = await ctx.reply(text, { parse_mode: "HTML", ...extra });
      if (sent?.message_id) deleteAfter(ctx.chat.id, sent.message_id);
      return sent;
    };
    try {
      if (pending.kind === "account") {
        const id = Number(input);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error("invalid ID");
        // A manual ID must match the account behind the user's own number when
        // it can be resolved; otherwise the entry is unattested and allowed,
        // but no server phone is ever mutated for an unresolved ID.
        if (isRealMode(config)) {
          const verified = await db.verifiedPhone(ctx.from.id);
          if (verified?.phone) {
            const resolved = await gramsrv.resolveUserByPhone(verified.phone).catch(() => 0);
            if (resolved > 0 && resolved !== id) throw new Error("account ID does not match your phone number");
          }
        } else {
          const currentNumber = await db.currentNumber(ctx.from.id);
          if (currentNumber?.phone) {
            const resolved = await gramsrv.resolveUserByPhone(currentNumber.phone).catch(() => 0);
            if (resolved > 0 && resolved !== id) throw new Error("account ID does not match your phone number");
          }
        }
        await db.setServerUserID(ctx.from.id, id); await db.clearPending(ctx.from.id);
        return ctx.reply(tr(ctx.from.id, "accountSaved", { id }), { parse_mode: "HTML", reply_markup: mainKeyboard(language, isOwner(config, ctx.from.id)) });
      }
      if (pending.kind === "stars_amount") {
        const stars = Number(input);
        if (!Number.isSafeInteger(stars) || stars < 1000 || stars > 10000000) throw new Error("amount must be from 1000 to 10000000");
        if (stars % 1000 !== 0) throw new Error("amount must be a multiple of 1000");
        const { starsRate, prices } = await catalogContext(db);
        const product = findProduct(`stars_${stars / 100}`, starsRate, prices); await db.clearPending(ctx.from.id);
        const view = localizeProduct(product, language);
        return ctx.reply(productText(view, language), { parse_mode: "HTML", reply_markup: productKeyboard(product, { _cachedUser: db._userCache.get(ctx.from.id) }, ctx.from.id, language) });
      }
      if (pending.kind === "request_number" || pending.kind === "request_username") {
        const requested = pending.kind === "request_number"
          ? input.replace(/[\s()-]/g, "")
          : input.replace(/^@/, "").trim().toLowerCase();
        if (pending.kind === "request_number" && !/^\+888[0-9]{3,12}$/.test(requested)) throw new Error("введите номер в формате +888...");
        if (pending.kind === "request_username" && !normalizeUsername(requested)) throw new Error("username должен содержать 5–32 латинских символа");
        const linkedID = Number((await db.user(ctx.from.id))?.server_user_id);
        if (!Number.isSafeInteger(linkedID) || linkedID <= 0) throw new Error("сначала привяжите DeltaGram аккаунт в настройках");
        if (pending.kind === "request_number") {
          const occupied = await gramsrv.resolveUserByPhone(requested);
          if (occupied > 0) throw new Error("этот номер уже является аккаунтом DeltaGram");
        } else {
          await gramsrv.mintUsername(linkedID, requested, 0, `check:username:${linkedID}:${requested}`, true);
        }
        const ticket = await db.addSupportMessage(ctx.from.id, ctx.chat.id, (pending.kind === "request_number" ? "Заявка на +888: " : "Заявка на NFT username: ") + requested + ` | account=${linkedID}`);
        await db.clearPending(ctx.from.id);
        for (const owner of config.ownerIDs) {
          await bot.api.sendMessage(owner, "🛒 Заявка #" + ticket + "\nОт: " + userName(ctx.from) + " (ID " + ctx.from.id + ")\n" + (pending.kind === "request_number" ? "+888" : "NFT username") + ": <code>" + escapeHTML(requested) + "</code>\nОтветьте реплаем только числом цены в Stars.", { parse_mode: "HTML" }).catch(() => {});
        }
        return toast("✅ Заявка #" + ticket + " отправлена администратору. Цена будет сообщена в этом чате.");
      }
      if (pending.kind === "target") {
        const id = await resolveTelegramTarget(db, input);
        if (!id) throw new Error("invalid ID or username");
        const { starsRate, prices } = await catalogContext(db);
        const product = findProduct(pending.payload.productCode, starsRate, prices);
        if (!product) throw new Error("product not found");
        await db.rememberRecipient(ctx.from.id, id); await db.clearPending(ctx.from.id);
        if (product.kind === KINDS.username) {
          await db.setPending(ctx.from.id, "username", { productCode: product.code, targetID: id });
          return ctx.reply(tr(ctx.from.id, "enterUsername"));
        }
        if (isOwner(config, ctx.from.id)) return fulfill(product, id, ctx.from, ctx.chat.id, `owner-${ctx.from.id}-${Date.now()}-${randomInt(1_000_000)}`);
        await sendInvoice(ctx, product, id, language); return;
      }
      if (pending.kind === "username") {
        const username = normalizeUsername(input);
        if (!username) throw new Error("username must be 5-32 latin characters and start with a letter");
        const { starsRate, prices } = await catalogContext(db);
        const product = findProduct(pending.payload.productCode, starsRate, prices);
        if (!product) throw new Error("product not found");
        await db.clearPending(ctx.from.id);
        if (isOwner(config, ctx.from.id)) return fulfill(product, pending.payload.targetID, ctx.from, ctx.chat.id, `owner-${ctx.from.id}-${Date.now()}-${randomInt(1_000_000)}`, username);
        await sendInvoice(ctx, product, pending.payload.targetID, language, username); return;
      }
      if (pending.kind === "support") {
        const ticket = await db.addSupportMessage(ctx.from.id, ctx.chat.id, input); await db.clearPending(ctx.from.id);
        for (const owner of config.ownerIDs) {
          const message = `${tr(owner, "supportOwnerTicket", { ticket })}\n${tr(owner, "supportOwnerFrom", { name: escapeHTML(userName(ctx.from)), id: ctx.from.id })}\n\n${escapeHTML(input)}`;
          await bot.api.sendMessage(owner, message, { parse_mode: "HTML" }).catch(() => {});
        }
        return toast(tr(ctx.from.id, "supportTicketSent", { ticket }));
      }
      if (!isOwner(config, ctx.from.id)) return;
      if (pending.kind === "admin_lookup") {
        await db.clearPending(ctx.from.id);
        if (!/^@?[a-zA-Z][a-zA-Z0-9_]{1,31}$/.test(input)) throw new Error("enter a DeltaGram @username");
        const id = await gramsrv.resolveUserByUsername(input.replace(/^@/, ""));
        if (!id) return adminResult(tr(ctx.from.id, "adminLookupNotFound"));
        return adminResult(tr(ctx.from.id, "adminLookupResult", { result: `@${escapeHTML(input.replace(/^@/, ""))} → DeltaGram ID: <code>${id}</code>` }));
      }
      if (pending.kind === "admin_broadcast") {
        await db.clearPending(ctx.from.id);
        let ok = 0, failed = 0;
        const allUsers = await db.users();
        for (const user of allUsers) {
          try { await bot.api.sendMessage(user.chat_id, input, { entities: ctx.message.entities ?? [] }); ok++; } catch { failed++; }
        }
        return adminResult(tr(ctx.from.id, "broadcastDone", { ok, skipped: 0, failed }));
      }
      if (pending.kind === "admin_stars") {
        const [idRaw, amountRaw, extra] = input.split(/\s+/);
        const id = parseDeltaGramID(idRaw), amount = Number(amountRaw);
        if (!id || extra || !Number.isSafeInteger(amount) || amount <= 0) throw new Error("invalid DeltaGram ID or amount");
        const actor = String(ctx.from.id);
        await gramsrv.grantStars(id, amount, "Telegram bot administrator grant", "", true, actor);
        await gramsrv.grantStars(id, amount, "Telegram bot administrator grant", pending.payload.operationID, false, actor);
        await db.clearPending(ctx.from.id);
        return adminResult(tr(ctx.from.id, "starsGranted", { id, amount }));
      }
      if (pending.kind === "admin_premium") {
        const [idRaw, monthsRaw, extra] = input.split(/\s+/);
        const id = parseDeltaGramID(idRaw), months = Number(monthsRaw);
        if (!id || extra || !Number.isSafeInteger(months) || months <= 0) throw new Error("invalid DeltaGram ID or months");
        const actor = String(ctx.from.id);
        await gramsrv.grantPremium(id, months, "Telegram bot administrator grant", "", true, actor);
        await gramsrv.grantPremium(id, months, "Telegram bot administrator grant", pending.payload.operationID, false, actor);
        await db.clearPending(ctx.from.id);
        return adminResult(tr(ctx.from.id, "premiumGranted", { id, months }));
      }
      if (pending.kind === "admin_promo") {
        const stars = Number(input);
        if (!Number.isSafeInteger(stars) || stars <= 0) throw new Error("введите положительное число Stars");
        await db.setPending(ctx.from.id, "admin_promo_limit", { stars });
        return adminResult(tr(ctx.from.id, "adminPromptPromoLimit"));
      }
      if (pending.kind === "admin_promo_limit") {
        const limit = Number(input);
        if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("максимум активаций должен быть положительным числом");
        const code = `DG-${randomBytes(12).toString("base64url").replace(/[-_]/g, "").slice(0, 16).toUpperCase()}`;
        const normalized = await db.createPromo(code, pending.payload.stars, limit); await db.clearPending(ctx.from.id);
        return adminResult(tr(ctx.from.id, "promoCreatedFull", { code: normalized, amount: pending.payload.stars, limit }));
      }
      if (pending.kind === "admin_giveaway") {
        const [starsRaw, limitRaw, ...words] = input.split(/\s+/);
        const item = await db.createGiveaway(words.join(" "), Number(starsRaw), Number(limitRaw)); await db.clearPending(ctx.from.id);
        return ctx.reply(`🎁 ${escapeHTML(item.text)}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(tr(ctx.from.id, "claimReward"), `giveaway:${item.id}`).row().text(tr(ctx.from.id, "back"), "admin:menu") });
      }
      if (pending.kind === "admin_invoice") {
        const [idRaw, starsRaw, ...words] = input.split(/\s+/);
        const id = await adminTelegramTarget(db, idRaw), stars = Number(starsRaw), title = words.join(" ").trim();
        if (!id || !Number.isSafeInteger(stars) || stars <= 0 || !title || title.length > 32) throw new Error("invalid invoice");
        const targetLanguage = languageOf(id);
        await bot.api.sendInvoice(id, title, translate(targetLanguage, "invoiceDescription", { title }), `custom|${Buffer.from(title).toString("base64url")}`, "XTR", [{ label: title, amount: stars }]);
        await db.clearPending(ctx.from.id); return adminResult(tr(ctx.from.id, "invoiceSent"));
      }
      if (pending.kind === "admin_access") {
        const [phone, telegramRaw] = input.split(/\s+/); const telegramID = await adminTelegramTarget(db, telegramRaw);
        if (!phone || !telegramID) throw new Error("invalid phone or Telegram ID or username");
        await db.grantCodeAccess(phone, telegramID); await db.clearPending(ctx.from.id);
        return adminResult(tr(ctx.from.id, "accessGranted", { phone: escapeHTML(phone), id: telegramID }));
      }
      if (pending.kind === "admin_bindphone") {
        const [idRaw, ...phoneParts] = input.split(/\s+/);
        const targetID = await adminTelegramTarget(db, idRaw); const phone = phoneParts.join("");
        if (!targetID || !phone) throw new Error("invalid Telegram ID, @username, or phone");
        const user = await db.user(targetID);
        if (!user) return adminResult(tr(ctx.from.id, "userNotFound"));
        const number = await db.adminBindNumber(targetID, user.chat_id, phone);
        if (number.format === "free") await db.bindVerifiedPhone(targetID, user.chat_id, number.phone);
        if (user.server_user_id > 0) {
          try {
            const actor = String(ctx.from.id);
            await gramsrv.setPhone(user.server_user_id, number.phone, "Admin number bind", "", true, actor);
            await gramsrv.setPhone(user.server_user_id, number.phone, "Admin number bind", `admin:bindphone:${targetID}:${Date.now()}`, false, actor);
          } catch (error) {
            console.error("Admin bind set-phone failed", targetID, error);
            return adminResult(adminErrorMessage(language, error));
          }
          try {
            const actor = String(ctx.from.id);
            await gramsrv.mintPhone(user.server_user_id, number.phone, "", true, actor);
            await gramsrv.mintPhone(user.server_user_id, number.phone, `admin:bindphone:mint:${targetID}:${number.phone}:${Date.now()}`, false, actor);
          } catch (error) {
            console.error("Admin bind mint-phone failed", targetID, error);
            return adminResult(tr(ctx.from.id, "bindPhonePartial", { phone: escapeHTML(number.display), id: idRaw }));
          }
        }
        await db.clearPending(ctx.from.id);
        return adminResult(tr(ctx.from.id, "bindPhoneDone", { phone: escapeHTML(number.display), id: idRaw }));
      }
      if (pending.kind === "admin_revokenumber") {
        const [idRaw, phoneRaw, extra] = input.split(/\s+/);
        const id = parseDeltaGramID(idRaw);
        const phone = String(phoneRaw ?? "").replace(/[()-]/g, "");
        if (!id || extra) throw new Error("format: DELTAGRAM_ID +888NUMBER");
        if (!/^\+888[0-9]{3,12}$/.test(phone)) throw new Error("формат: +888XXXXXXXX");
        if (await gramsrv.resolveUserByPhone(phone) !== id) throw new Error("number does not belong to DeltaGram ID");
        const actor = String(ctx.from.id);
        await gramsrv.revokePhone(phone, false, `admin:revokephone:${phone}`, true, actor);
        await gramsrv.revokePhone(phone, false, `admin:revokephone:${phone}`, false, actor);
        await db.adminRevokeNumber(phone);
        await db.clearPending(ctx.from.id);
        return adminResult(`✅ Номер <code>${escapeHTML(phone)}</code> вилучено з колекційного реєстру та локального магазину.`, { parse_mode: "HTML" });
      }
      if (pending.kind === "admin_grantnumber") {
        const [idRaw, formatRaw] = input.split(/\s+/);
        const targetID = await adminTelegramTarget(db, idRaw);
        const format = formatRaw || "long";
        if (!targetID || !["short", "long"].includes(format)) throw new Error("формат: TELEGRAM_ID [short|long]");
        const user = await db.user(targetID);
        if (!user) return adminResult(tr(ctx.from.id, "userNotFound"));
        const number = await db.adminCreateAnonymousNumber(targetID, user.chat_id, format);
        const serverUserID = await gramsrvUserIDOf(db, targetID);
        if (serverUserID) {
          try {
            const actor = String(ctx.from.id);
            await gramsrv.setPhone(serverUserID, number.phone, "Admin anonymous number grant", "", true, actor);
            await gramsrv.setPhone(serverUserID, number.phone, `admin:grantnumber:${targetID}:${number.phone}:${Date.now()}`, false, actor);
            await gramsrv.mintPhone(serverUserID, number.phone, "", true, actor);
            await gramsrv.mintPhone(serverUserID, number.phone, `admin:grantnumber:mint:${targetID}:${number.phone}:${Date.now()}`, false, actor);
          } catch (error) {
            console.error("Admin anonymous number grant failed", targetID, error);
            return adminResult(tr(ctx.from.id, "grantNumberPartial", { phone: escapeHTML(number.display), id: idRaw }));
          }
        }
        await db.clearPending(ctx.from.id);
        return adminResult(tr(ctx.from.id, "grantNumberDone", { phone: escapeHTML(number.display), id: idRaw }));
      }
      if (pending.kind === "admin_grantusername") {
        const [idRaw, ...words] = input.split(/\s+/);
        const serverUserID = parseDeltaGramID(idRaw);
        const username = normalizeUsername(words.join(""), 2);
        if (!serverUserID || !username) throw new Error("invalid DeltaGram ID or username");
        // A server-side dry run is the authoritative occupation check before a
        // zero-price grant (blind even for vault names). The real mint rechecks
        // inside its own command, so a gang between the two calls cannot win;
        // an occupied error on either attempt is surfaced to the moderator.
        const actor = String(ctx.from.id);
        const mint = async (dryRun, key) => gramsrv.mintUsername(serverUserID, username, 0, key, dryRun, actor).catch((error) => {
          if (error.code === "USERNAME_OCCUPIED" || /username occupied/i.test(String(error.message))) throw new Error("username occupied");
          throw error;
        });
        await mint(true, "");
        await mint(false, `admin:grantusername:${serverUserID}:${username}:${Date.now()}`);
        await db.clearPending(ctx.from.id);
        return adminResult(tr(ctx.from.id, "grantUsernameDone", { username: escapeHTML(username), id: idRaw }));
      }
      if (pending.kind === "admin_verified") {
        const { id, on } = parseModerationTarget(input);
        const serverUserID = id;
        const actor = String(ctx.from.id);
        await gramsrv.setVerified(serverUserID, on, "Telegram bot administrator moderation", "", true, actor);
        await gramsrv.setVerified(serverUserID, on, "Telegram bot administrator moderation", `admin:verified:${id}:${Date.now()}`, false, actor);
        await db.clearPending(ctx.from.id);
        return adminResult(tr(ctx.from.id, on ? "verifiedDone" : "verifiedRemoved", { id }));
      }
      if (pending.kind === "admin_freeze") {
        const { id, on } = parseModerationTarget(input);
        const serverUserID = id;
        const actor = String(ctx.from.id);
        await gramsrv.setFrozen(serverUserID, on, "Telegram bot administrator moderation", "", true, actor);
        await gramsrv.setFrozen(serverUserID, on, "Telegram bot administrator moderation", `admin:freeze:${id}:${Date.now()}`, false, actor);
        await db.clearPending(ctx.from.id);
        return adminResult(tr(ctx.from.id, on ? "frozenDone" : "unfrozenDone", { id }));
      }
      if (pending.kind === "admin_scam") {
        const { id, on } = parseModerationTarget(input);
        const serverUserID = id;
        const actor = String(ctx.from.id);
        await gramsrv.setFlags(serverUserID, on, false, "Telegram bot administrator moderation", "", true, actor);
        await gramsrv.setFlags(serverUserID, on, false, "Telegram bot administrator moderation", `admin:scam:${id}:${Date.now()}`, false, actor);
        await db.clearPending(ctx.from.id);
        return adminResult(tr(ctx.from.id, on ? "scamFlagDone" : "scamFlagRemoved", { id }));
      }
      if (pending.kind === "admin_fake") {
        const { id, on } = parseModerationTarget(input);
        const serverUserID = id;
        const actor = String(ctx.from.id);
        await gramsrv.setFlags(serverUserID, false, on, "Telegram bot administrator moderation", "", true, actor);
        await gramsrv.setFlags(serverUserID, false, on, "Telegram bot administrator moderation", `admin:fake:${id}:${Date.now()}`, false, actor);
        await db.clearPending(ctx.from.id);
        return adminResult(tr(ctx.from.id, on ? "fakeFlagDone" : "fakeFlagRemoved", { id }));
      }
      if (pending.kind === "admin_refund") {
        const parts = input.split(/\s+/);
        if (parts.length !== 2) throw new Error("format: DELTAGRAM_ID TRANSACTION_ID");
        const expectedBuyerID = await adminTelegramTarget(db, parts[0]);
        const chargeID = parts[1];
        if (!chargeID) throw new Error("sale not found for this transaction ID");
        const sale = await db.refundTargetByCharge(chargeID);
        if (!sale) throw new Error("sale not found for this transaction ID");
        if (expectedBuyerID && sale.buyer_id !== expectedBuyerID) throw new Error("sale buyer mismatch");
        if (await db.isRefunded(chargeID)) throw new Error("payment was already refunded");
        const telegramID = sale.buyer_id;
        await executeCompensatedRefund({ sale, telegramID, db, gramsrv, refundStarPayment: bot.api.refundStarPayment.bind(bot.api), actor: String(ctx.from.id) });
        await db.clearPending(ctx.from.id);
        await bot.api.sendMessage(telegramID, tr(telegramID, "paymentRefunded", { charge: escapeHTML(chargeID) }), { parse_mode: "HTML" }).catch(() => {});
        return adminResult(tr(ctx.from.id, "refundDone"));
      }
      if (pending.kind === "admin_reply") {
        const [ticketRaw, ...words] = input.split(/\s+/); const ticketID = Number(ticketRaw), answer = words.join(" ").trim();
        if (!Number.isSafeInteger(ticketID) || ticketID <= 0) throw new Error("invalid ticket ID");
        const ticket = await db.supportMessage(ticketID);
        if (!ticket || !answer) throw new Error("ticket not found or reply is empty");
        // Atomic claim: a concurrent admin who already answered keeps the
        // ticket; the loser is told instead of overwriting answered_by/answer.
        const claimed = await db.closeSupportMessage(ticketID, String(ctx.from.id), answer);
        if (!claimed) {
          await db.clearPending(ctx.from.id);
          return adminResult(tr(ctx.from.id, "supportAlreadyAnswered", { ticket: ticketID }));
        }
        await bot.api.sendMessage(ticket.telegram_id, tr(ticket.telegram_id, "supportReply", { ticket: ticketID, answer: escapeHTML(answer) }), { parse_mode: "HTML" });
        await db.clearPending(ctx.from.id);
        await notifyOtherAdmins(ctx.from.id, ticketID);
        await sendRatingPrompt(ticketID, ticket.telegram_id);
        return adminResult(tr(ctx.from.id, "supportReplySent", { ticket: ticketID }));
      }
      if (pending.kind === "admin_rate") {
        const rate = Number(input);
        if (!Number.isSafeInteger(rate) || rate <= 0) throw new Error("invalid rate");
        await db.setSetting("stars_rate", rate); await db.clearPending(ctx.from.id);
        return adminResult(tr(ctx.from.id, "rateSaved", { rate }));
      }
      if (pending.kind === "admin_prices") {
        const overridable = new Set(catalog(await db.starsRate()).filter((p) => p.kind !== KINDS.stars).map((p) => p.code));
        const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (!lines.length) throw new Error("no prices provided");
        let updated = 0;
        for (const line of lines) {
          const parts = line.split(/\s+/);
          if (parts.length !== 2) throw new Error("invalid price format");
          const [codeRaw, valueRaw] = parts;
          const value = Number(valueRaw);
          if (!Number.isSafeInteger(value) || value < 0 || value > 100000) throw new Error("invalid price");
          if (codeRaw === "all") {
            for (const code of overridable) await db.setProductPrice(code, value);
            updated += overridable.size;
          } else if (codeRaw === "rate") {
            if (value <= 0) throw new Error("invalid rate");
            await db.setSetting("stars_rate", value);
            updated++;
          } else if (codeRaw === "discount") {
            if (value > 100) throw new Error("invalid discount");
            await db.setSetting("number_discount_percent", value);
            updated++;
          } else if (codeRaw === "free") {
            await db.setSetting("free_number_daily_limit", value);
            updated++;
          } else {
            if (!overridable.has(codeRaw)) throw new Error("unknown product code");
            await db.setProductPrice(codeRaw, value);
            updated++;
          }
        }
        await db.clearPending(ctx.from.id);
        return adminResult(tr(ctx.from.id, "pricesSaved", { count: updated }));
      }
      if (pending.kind === "admin_wheel") {
        const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (!lines.length) throw new Error("invalid wheel limit");
        let updated = 0;
        for (const line of lines) {
          const parts = line.split(/\s+/);
          if (parts.length === 1 && (parts[0] === "on" || parts[0] === "off")) {
            await db.setSetting("wheel_enabled", parts[0]);
            updated++;
            continue;
          }
          if (parts.length !== 2) throw new Error("invalid wheel limit");
          const [key, valueRaw] = parts;
          const value = Number(valueRaw);
          if (!Number.isSafeInteger(value) || value < 0 || value > 1000) throw new Error("invalid wheel limit");
          if (key === "daily") { await db.setSetting("wheel_daily_limit", value); updated++; }
          else if (key === "weekly") { await db.setSetting("wheel_weekly_limit", value); updated++; }
          else if (key === "max") { await db.setSetting("wheel_max_prize", value); updated++; }
          else throw new Error("invalid wheel limit");
        }
        const limits = await db.wheelLimits();
        await db.clearPending(ctx.from.id);
        return adminResult(tr(ctx.from.id, "wheelSaved", {
          daily: String(limits.daily),
          weekly: String(limits.weekly),
          enabled: limits.enabled ? tr(ctx.from.id, "wheelEnabledLabel") : tr(ctx.from.id, "wheelDisabledLabel"),
          max: limits.maxPrize > 0 ? String(limits.maxPrize) : tr(ctx.from.id, "wheelMaxUnlimited"),
        }));
      }
      if (pending.kind === "admin_recurring_add") {
        const parsed = [];
        const invalid = [];
        for (const rawLine of input.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line) continue;
          const parts = line.split(/[\s,;]+/).filter(Boolean);
          const accountID = parseDeltaGramID(parts[0]);
          const amount = Number(parts[1]);
          if (parts.length !== 2 || !Number.isSafeInteger(accountID) || accountID <= 0
            || !Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000_000) {
            invalid.push(line);
            continue;
          }
          parsed.push({ serverUserID: accountID, amount });
        }
        if (invalid.length || !parsed.length) {
          return adminResult(tr(ctx.from.id, "adminRecurringAddInvalid", {
            lines: escapeHTML(invalid.slice(0, 8).join("; ")) || "—",
          }));
        }
        const rows = await Promise.all(parsed.map(async (row) => {
          const user = await db.userByServerUserID(row.serverUserID).catch(() => null);
          const telegramID = Number(user?.telegram_id);
          return { ...row, telegramID: Number.isSafeInteger(telegramID) && telegramID > 0 ? telegramID : 0 };
        }));
        const settings = normalizeRecurringSettings(await db.recurringSettings(), recurringDefaults);
        const seedDate = dueDateFor(new Date(), settings.time, settings.timezone);
        const result = await db.upsertRecurringRecipients(rows, seedDate);
        await db.clearPending(ctx.from.id);
        return adminResult(tr(ctx.from.id, "adminRecurringAddSaved", {
          added: String(result.added), updated: String(result.updated), date: seedDate,
        }));
      }
      if (pending.kind === "admin_recurring_time") {
        const parts = input.split(/\s+/).filter(Boolean);
        const time = parseRecurringTime(parts[0]);
        if (!parts.length || !time) return adminResult(tr(ctx.from.id, "adminRecurringTimeInvalid"));
        let timezone = "";
        if (parts[1]) {
          timezone = parts[1];
          if (!isValidRecurringTimezone(timezone)) {
            return adminResult(tr(ctx.from.id, "adminRecurringTimezoneInvalid", { timezone: escapeHTML(timezone) }));
          }
        }
        await db.setSetting("recurring_stars_time", time);
        if (timezone) await db.setSetting("recurring_stars_timezone", timezone);
        await db.clearPending(ctx.from.id);
        const current = normalizeRecurringSettings(await db.recurringSettings(), recurringDefaults);
        return adminResult(tr(ctx.from.id, "adminRecurringTimeSaved", {
          time: current.time, timezone: current.timezone,
        }));
      }
      if (pending.kind === "admin_recurring_delete") {
        const tokens = input.split(/[\s,;]+/).filter(Boolean);
        const ids = tokens.map(parseDeltaGramID);
        if (!tokens.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
          return adminResult(tr(ctx.from.id, "adminRecurringDeleteInvalid"));
        }
        const uniqueIDs = [...new Set(ids)];
        const deleted = await db.deleteRecurringRecipients(uniqueIDs);
        const missing = uniqueIDs.filter((id) => !deleted.includes(id));
        await db.clearPending(ctx.from.id);
        let text = tr(ctx.from.id, "adminRecurringDeleted", { count: String(deleted.length) });
        if (missing.length) {
          text += `\n${tr(ctx.from.id, "adminRecurringMissing", { ids: missing.slice(0, 30).join(", ") })}`;
        }
        return adminResult(text);
      }
    } catch (error) {
      console.error("Bot input action failed", pending.kind, error);
      if (pending.kind.startsWith("admin_")) await db.clearPending(ctx.from.id);
      await ctx.reply(adminErrorMessage(language, error), { parse_mode: "HTML" });
    }
  });

  bot.catch(async ({ error, ctx }) => {
    if (error instanceof GrammyError) console.error("Telegram API error", error.description);
    else if (error instanceof HttpError) console.error("Telegram network error", error);
    else console.error(`Bot update ${ctx.update.update_id} failed`, error);
    if (ctx.from && ctx.chat) await ctx.reply(tr(ctx.from.id, "genericError")).catch(() => {});
  });
  return bot;
}

// Owner notification for an executed recurring-Stars run. The scheduler calls
// this once per tick that actually processed recipients, so the owner sees the
// date/time, every account and the exact amount, plus any first-attempt error.
export async function notifyRecurringGrants({ bot, config, db }, summary) {
  if (!summary?.entries?.length) return;
  const userCache = new Map();
  const userFor = async (entry) => {
    const key = entry.telegramID > 0 ? `tg:${entry.telegramID}` : `account:${entry.accountID}`;
    if (!userCache.has(key)) {
      userCache.set(key, await (entry.telegramID > 0
        ? db.user(entry.telegramID)
        : db.userByServerUserID(entry.accountID)
      ).catch(() => null));
    }
    return userCache.get(key);
  };

  for (const ownerID of config.ownerIDs ?? []) {
    try {
      const owner = await db.user(ownerID).catch(() => null);
      const language = normalizeLanguage(owner?.language, config.defaultLanguage);
      const lines = [translate(language, "recurringNotifyTitle")];
      lines.push(translate(language, summary.manual ? "recurringNotifyManual" : "recurringNotifyScheduled", {
        date: summary.dueDate,
        time: summary.time,
        timezone: summary.timezone,
        local: summary.runAt,
      }));
      for (const entry of summary.entries) {
        const user = await userFor(entry);
        const username = String(user?.username ?? "").trim();
        const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
        const identity = username ? `@${username}` : name;
        const telegramID = Number(entry.telegramID) || Number(user?.telegram_id) || 0;
        const who = identity || (telegramID > 0 ? `TG ${telegramID}` : "");
        if (entry.status === "ok") {
          lines.push(translate(language, "recurringNotifyGranted", {
            account: String(entry.accountID),
            amount: String(entry.amount),
            who: who ? ` · ${escapeHTML(who)}` : "",
          }));
        } else {
          lines.push(translate(language, "recurringNotifyFailed", {
            account: String(entry.accountID),
            amount: String(entry.amount),
            error: escapeHTML(String(entry.error ?? "").slice(0, 180)) || "—",
          }));
        }
      }
      lines.push(translate(language, "recurringNotifySummary", {
        ok: String(summary.ok),
        failed: String(summary.failed),
        total: String(summary.totalStars ?? 0),
      }));
      await bot.api.sendMessage(ownerID, lines.join("\n"), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      console.error(`Recurring Stars notification to owner ${ownerID} failed`, error);
    }
  }
}
