// Daily recurring Stars grants.
//
// The admin stores one row per DeltaGram account plus a single global time and
// timezone. Every tick computes the latest elapsed civil date in that timezone
// and grants each account at most once for it. The Admin API idempotency key
// `recurring:<account_id>:<date>` makes retries and bot restarts safe.

export const RECURRING_DEFAULTS = Object.freeze({
  enabled: false,
  time: "12:00",
  timezone: "Europe/Kyiv",
});

export const TIMEZONE_PRESETS = Object.freeze([
  "Europe/Kyiv",
  "Europe/Moscow",
  "Europe/Warsaw",
  "Europe/Berlin",
  "UTC",
  "Asia/Almaty",
  "Asia/Tbilisi",
  "Asia/Yerevan",
  "America/New_York",
  "America/Los_Angeles",
]);

const RETRY_BASE_SECONDS = 300;
const RETRY_MAX_SECONDS = 3600;
const TICK_INTERVAL_MS = 30_000;

export function parseRecurringTime(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? "").trim());
  if (!match) return "";
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

export function isValidRecurringTimezone(value) {
  const timezone = String(value ?? "").trim();
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function normalizeRecurringSettings(raw = {}, defaults = RECURRING_DEFAULTS) {
  const fallback = defaults ?? RECURRING_DEFAULTS;
  const fallbackTime = parseRecurringTime(fallback.time) || RECURRING_DEFAULTS.time;
  const fallbackTimezone = isValidRecurringTimezone(fallback.timezone)
    ? String(fallback.timezone).trim()
    : RECURRING_DEFAULTS.timezone;

  const time = parseRecurringTime(raw?.time) || fallbackTime;
  const timezone = isValidRecurringTimezone(raw?.timezone)
    ? String(raw.timezone).trim()
    : fallbackTimezone;

  const enabledRaw = String(raw?.enabled ?? "").trim().toLowerCase();
  let enabled = Boolean(fallback.enabled);
  if (["on", "1", "true", "yes", "enabled"].includes(enabledRaw)) enabled = true;
  else if (["off", "0", "false", "no", "disabled"].includes(enabledRaw)) enabled = false;

  return { enabled, time, timezone };
}

// Civil clock in a timezone. Intl gives us the wall-clock date/time without
// pulling in a date library; `minutes` is minutes since local midnight.
export function zonedClock(now, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  for (const part of formatter.formatToParts(now)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute,
    minutes: hour * 60 + minute,
  };
}

export function addDays(date, delta) {
  const [year, month, day] = String(date).split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  return shifted.toISOString().slice(0, 10);
}

// Latest scheduled slot that has already started. Before today's time the
// previous day's slot is still the most recent one.
export function dueDateFor(now, time, timezone) {
  const clock = zonedClock(now, timezone);
  const [hour, minute] = String(time).split(":").map(Number);
  const scheduled = hour * 60 + minute;
  return clock.minutes >= scheduled ? clock.date : addDays(clock.date, -1);
}

export function nextGrantDate(now, time, timezone) {
  const clock = zonedClock(now, timezone);
  const [hour, minute] = String(time).split(":").map(Number);
  const scheduled = hour * 60 + minute;
  return clock.minutes < scheduled ? clock.date : addDays(clock.date, 1);
}

export function formatZonedClock(now, timezone) {
  const clock = zonedClock(now, timezone);
  return `${clock.date} ${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
}

export class RecurringStarsScheduler {
  constructor({ config, db, gramsrv, defaults, notify = null, intervalMs = TICK_INTERVAL_MS, log = console }) {
    this.config = config;
    this.db = db;
    this.gramsrv = gramsrv;
    this.notify = notify;
    this.defaults = {
      enabled: defaults?.enabled ?? Boolean(config?.recurringStarsEnabled),
      time: defaults?.time ?? config?.recurringStarsTime ?? RECURRING_DEFAULTS.time,
      timezone: defaults?.timezone ?? config?.recurringStarsTimezone ?? RECURRING_DEFAULTS.timezone,
    };
    this.intervalMs = intervalMs;
    this.log = log;
    this.timer = null;
    this.running = false;
  }

  async settings() {
    const raw = await this.db.recurringSettings();
    return normalizeRecurringSettings(raw, this.defaults);
  }

  async start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.log.error?.("Recurring Stars tick failed", error));
    }, this.intervalMs);
    this.timer.unref?.();
    // Do not delay bot polling on a slow Admin API; the first tick runs in the
    // background and any failure is recorded per recipient for the next retry.
    this.tick().catch((error) => this.log.error?.("Recurring Stars initial tick failed", error));
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Owner-facing notification hook. The bot attaches a Telegram sender after
  // createBot(); keeping it injectable lets the scheduler run in tests without
  // a Telegram connection.
  setNotifier(notify) {
    this.notify = typeof notify === "function" ? notify : null;
  }

  emitNotification(summary) {
    if (!this.notify || !summary?.entries?.length) return;
    Promise.resolve()
      .then(() => this.notify(summary))
      .catch((error) => this.log.error?.("Recurring Stars notification failed", error));
  }

  // Manual "run now" bypasses retry backoff and the global on/off switch, but
  // still never re-grants a date that already succeeded.
  async runNow() {
    return this.tick({ force: true, ignoreDisabled: true });
  }

  async tick({ force = false, ignoreDisabled = false } = {}) {
    if (this.running) return { busy: true, disabled: false, total: 0, ok: 0, failed: 0 };
    this.running = true;
    try {
      const settings = await this.settings();
      if (!settings.enabled && !ignoreDisabled) {
        return { busy: false, disabled: true, dueDate: "", total: 0, ok: 0, failed: 0 };
      }
      const dueDate = dueDateFor(new Date(), settings.time, settings.timezone);
      const nowUnix = Math.floor(Date.now() / 1000);
      const rows = await this.db.dueRecurringRecipients(dueDate, nowUnix, force);
      const result = { busy: false, disabled: false, dueDate, total: rows.length, ok: 0, failed: 0, entries: [] };
      for (const row of rows) {
        const accountID = Number(row.server_user_id);
        const amount = Number(row.amount);
        const attempts = Number(row.attempts) || 0;
        // The Admin API memoizes failed command ids too, so a definitive
        // failure must be retried under a new key. Uncertain failures (network
        // errors, timeouts, 5xx) keep the key so a grant that actually landed
        // is replayed instead of credited twice.
        const idempotencyKey = attempts > 0
          ? `recurring:${accountID}:${dueDate}:r${attempts}`
          : `recurring:${accountID}:${dueDate}`;
        try {
          const response = await this.gramsrv.grantStars(
            accountID,
            amount,
            `Recurring daily Stars grant ${dueDate}`,
            idempotencyKey,
            false,
            this.config?.recurringStarsActor || "recurring-stars"
          );
          // A replayed failed command is returned as HTTP 200 with status
          // "failed"; only "completed" means the balance was credited.
          if (response?.status && response.status !== "completed") {
            const error = new Error(response.error || response.message || `grant status ${response.status}`);
            error.definitive = true;
            throw error;
          }
          await this.db.markRecurringGranted(row.id, dueDate);
          result.ok++;
          result.entries.push({
            accountID, amount,
            telegramID: Number(row.telegram_id) || 0,
            status: "ok",
          });
        } catch (error) {
          const delay = Math.min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * 2 ** Math.min(attempts, 4));
          const detail = error?.code ? `${error.code}: ${error.message}` : String(error?.message ?? error);
          const httpStatus = Number(error?.httpStatus);
          const definitive = error?.definitive === true
            || (httpStatus >= 400 && httpStatus < 500 && error?.code !== "COMMAND_ID_CONFLICT");
          await this.db.markRecurringFailed(row.id, nowUnix + delay, detail, definitive).catch((bookkeepingError) => {
            this.log.error?.("Recurring Stars failure bookkeeping failed", bookkeepingError);
          });
          result.failed++;
          // Report the first failure of a day, but keep silent on the
          // automatic 5–60 minute retries so an invalid account cannot spam
          // the owner. A later success is still reported.
          if (attempts === 0) {
            result.entries.push({
              accountID, amount,
              telegramID: Number(row.telegram_id) || 0,
              status: "failed",
              error: detail,
            });
          }
          this.log.error?.(`Recurring Stars grant failed for account ${accountID} on ${dueDate}`, error);
        }
      }
      if (result.ok || result.failed) {
        this.log.log?.(`Recurring Stars ${dueDate}: ${result.ok} granted, ${result.failed} failed`);
      }
      if (result.entries.length) {
        this.emitNotification({
          dueDate,
          manual: ignoreDisabled,
          runAt: formatZonedClock(new Date(), settings.timezone),
          time: settings.time,
          timezone: settings.timezone,
          ok: result.ok,
          failed: result.failed,
          totalStars: result.entries
            .filter((entry) => entry.status === "ok")
            .reduce((sum, entry) => sum + entry.amount, 0),
          entries: result.entries,
        });
      }
      const { entries, ...publicResult } = result;
      return publicResult;
    } finally {
      this.running = false;
    }
  }
}
