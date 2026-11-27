import test from "node:test";
import assert from "node:assert/strict";
import {
  RECURRING_DEFAULTS,
  RecurringStarsScheduler,
  addDays,
  dueDateFor,
  formatZonedClock,
  isValidRecurringTimezone,
  nextGrantDate,
  normalizeRecurringSettings,
  parseRecurringTime,
  zonedClock,
} from "../src/recurring.js";

test("recurring time parsing accepts HH:MM and rejects invalid values", () => {
  assert.equal(parseRecurringTime("9:05"), "09:05");
  assert.equal(parseRecurringTime("12:00"), "12:00");
  assert.equal(parseRecurringTime("23:59"), "23:59");
  assert.equal(parseRecurringTime("24:00"), "");
  assert.equal(parseRecurringTime("12:60"), "");
  assert.equal(parseRecurringTime(""), "");
});

test("recurring settings fall back safely to environment defaults", () => {
  assert.deepEqual(
    normalizeRecurringSettings({ enabled: "off", time: "9:5", timezone: "Bad/Zone" }, {
      enabled: true, time: "12:00", timezone: "Europe/Kyiv",
    }),
    { enabled: false, time: "12:00", timezone: "Europe/Kyiv" },
  );
  assert.deepEqual(
    normalizeRecurringSettings({}, RECURRING_DEFAULTS),
    { enabled: false, time: "12:00", timezone: "Europe/Kyiv" },
  );
  assert.equal(normalizeRecurringSettings({ enabled: "on" }).enabled, true);
  assert.equal(isValidRecurringTimezone("Europe/Kyiv"), true);
  assert.equal(isValidRecurringTimezone("Bad/Zone"), false);
});

test("recurring due slots use the configured timezone, not UTC", () => {
  // 09:00 UTC is 11:00 in Kyiv (UTC+2 in November), before 12:00.
  const before = new Date("2026-11-04T09:00:00Z");
  assert.deepEqual(zonedClock(before, "Europe/Kyiv"), {
    date: "2026-11-04", hour: 11, minute: 0, minutes: 660,
  });
  assert.equal(dueDateFor(before, "12:00", "Europe/Kyiv"), "2026-11-03");
  assert.equal(nextGrantDate(before, "12:00", "Europe/Kyiv"), "2026-11-04");

  // 13:00 Kyiv is after 12:00, so today's slot is already open.
  const after = new Date("2026-11-04T11:00:00Z");
  assert.equal(dueDateFor(after, "12:00", "Europe/Kyiv"), "2026-11-04");
  assert.equal(nextGrantDate(after, "12:00", "Europe/Kyiv"), "2026-11-05");
  assert.equal(formatZonedClock(after, "Europe/Kyiv"), "2026-11-04 13:00");
});

test("recurring date arithmetic crosses month and year boundaries", () => {
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("scheduler notifies the owner once per run with amounts and first-attempt failures", async () => {
  const rows = [
    { id: 1, server_user_id: 501, amount: 10, telegram_id: 9001, attempts: 0, last_granted_date: "1970-01-01", enabled: true },
    { id: 2, server_user_id: 502, amount: 5, telegram_id: 0, attempts: 0, last_granted_date: "1970-01-01", enabled: true },
  ];
  const db = {
    async recurringSettings() { return { enabled: "on", time: "00:00", timezone: "UTC" }; },
    async dueRecurringRecipients() { return rows.filter((row) => row.last_granted_date < "9999-12-31"); },
    async markRecurringGranted(id) { rows.find((row) => row.id === id).last_granted_date = "9999-12-31"; },
    async markRecurringFailed(id) { rows.find((row) => row.id === id).attempts += 1; },
  };
  const gramsrv = {
    async grantStars(accountID) {
      if (accountID === 502) {
        const error = new Error("BANK_UNAVAILABLE");
        error.httpStatus = 503;
        throw error;
      }
      return { status: "completed" };
    },
  };
  let summary = null;
  const scheduler = new RecurringStarsScheduler({
    config: { recurringStarsEnabled: true, recurringStarsTime: "00:00", recurringStarsTimezone: "UTC" },
    db, gramsrv,
    log: { log() {}, error() {} },
  });
  scheduler.setNotifier((value) => { summary = value; });
  const result = await scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual({ total: result.total, ok: result.ok, failed: result.failed }, { total: 2, ok: 1, failed: 1 });
  assert.equal(result.entries, undefined, "internal notification entries are not exposed to the panel");
  assert.equal(summary.ok, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.totalStars, 10);
  assert.deepEqual(summary.entries.map((entry) => [entry.accountID, entry.amount, entry.status]), [
    [501, 10, "ok"],
    [502, 5, "failed"],
  ]);
});
