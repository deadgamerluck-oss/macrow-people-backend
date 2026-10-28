export function calculatePayrollDays(eligibleValue, deductionValue) {
  const numericValue = (value) => {
    if (value == null || String(value).trim() === "") return Number.NaN;
    return Number(value);
  };
  const eligibleDays = numericValue(eligibleValue);
  const deductionDays = numericValue(deductionValue);

  if (!Number.isFinite(eligibleDays) || eligibleDays < 0) {
    return { valid: false, error: "Eligible days must be a non-negative number." };
  }
  if (!Number.isFinite(deductionDays) || deductionDays < 0) {
    return { valid: false, error: "Deduction days must be a non-negative number." };
  }
  if (deductionDays > eligibleDays) {
    return { valid: false, error: "Deduction days cannot exceed eligible days." };
  }

  return {
    valid: true,
    eligibleDays,
    deductionDays,
    paidDays: Math.round((eligibleDays - deductionDays) * 100) / 100,
  };
}
