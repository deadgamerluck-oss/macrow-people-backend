"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const payrollDays = import("../client/src/payroll-days.mjs");

test("payroll day deductions reduce paid days and support half days", async () => {
  const { calculatePayrollDays } = await payrollDays;
  assert.deepEqual(calculatePayrollDays("22", "2.5"), {
    valid: true,
    eligibleDays: 22,
    deductionDays: 2.5,
    paidDays: 19.5,
  });
  assert.equal(calculatePayrollDays("10", "10").paidDays, 0);
});

test("payroll day deductions reject missing, nonnumeric, negative, and excessive values", async () => {
  const { calculatePayrollDays } = await payrollDays;
  assert.equal(calculatePayrollDays("", "0").valid, false);
  assert.equal(calculatePayrollDays("20", "abc").valid, false);
  assert.equal(calculatePayrollDays("20", "-1").valid, false);
  assert.equal(calculatePayrollDays("20", "21").valid, false);
});
