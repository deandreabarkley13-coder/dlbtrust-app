'use strict';

/**
 * Bond Amortization Helpers — level-payment amortization for fixed-income bonds.
 *
 * Supports payment frequencies: daily, monthly, quarterly, semi-annual, annual.
 * Assumes each payment period is equal in length (30/360 convention for day counts
 * unless the bond specifies ACT/ACT or ACT/360).
 */

function freqMonths(freq) {
  switch ((freq || 'monthly').toLowerCase().replace(/_/g, '-')) {
    case 'daily': return 0;
    case 'monthly': return 1;
    case 'quarterly': return 3;
    case 'semi-annual':
    case 'semi-annual': return 6;
    case 'annual': return 12;
    default: return 1;
  }
}

function freqPerYear(freq) {
  switch ((freq || 'monthly').toLowerCase().replace(/_/g, '-')) {
    case 'daily': return 365;
    case 'monthly': return 12;
    case 'quarterly': return 4;
    case 'semi-annual':
    case 'semi-annual': return 2;
    case 'annual': return 1;
    default: return 12;
  }
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function addMonths(d, months) {
  const nd = new Date(d);
  nd.setMonth(nd.getMonth() + months);
  nd.setHours(0, 0, 0, 0);
  return nd;
}

function days30_360(d1, d2) {
  const y1 = d1.getFullYear(), m1 = d1.getMonth() + 1, day1 = Math.min(d1.getDate(), 30);
  const y2 = d2.getFullYear(), m2 = d2.getMonth() + 1, day2 = Math.min(d2.getDate(), 30);
  return Math.max(0, (y2 - y1) * 360 + (m2 - m1) * 30 + (day2 - day1));
}

function daysBetween(from, to, dayCount) {
  const d1 = new Date(from);
  const d2 = new Date(to);
  if (dayCount === '30/360') return days30_360(d1, d2);
  const msPerDay = 86400000;
  return Math.max(0, Math.round((d2.getTime() - d1.getTime()) / msPerDay));
}

function dailyRate(annualRate, dayCount, year) {
  if (dayCount === 'ACT/ACT') return annualRate / (isLeapYear(year) ? 366 : 365);
  if (dayCount === 'ACT/360') return annualRate / 360;
  return annualRate / 360; // 30/360 default
}

class BondAmortization {

  static paymentAmount(bond) {
    const face = parseFloat(bond.face_value || 0);
    const coupon = parseFloat(bond.coupon_rate || 0);
    const freq = freqPerYear(bond.payment_freq);
    const r = coupon / freq;
    const months = freqMonths(bond.payment_freq);
    const n = months > 0
      ? Math.round(((new Date(bond.maturity_date).getFullYear() - new Date(bond.issue_date).getFullYear()) * 12 +
          (new Date(bond.maturity_date).getMonth() - new Date(bond.issue_date).getMonth())) / months)
      : Math.round(daysBetween(bond.issue_date, bond.maturity_date, bond.day_count) / 1); // daily not fully supported
    if (n <= 0 || r === 0) return 0;
    return (face * r) / (1 - Math.pow(1 + r, -n));
  }

  static paymentDates(bond) {
    const issue = new Date(bond.issue_date);
    const maturity = new Date(bond.maturity_date);
    const months = freqMonths(bond.payment_freq);
    const dates = [];
    if (months === 0) return dates; // daily not supported
    let d = addMonths(issue, months);
    while (d <= maturity) {
      dates.push(new Date(d));
      d = addMonths(d, months);
    }
    return dates;
  }

  static amortizedState(bond, asOf) {
    const face = parseFloat(bond.face_value || 0);
    const coupon = parseFloat(bond.coupon_rate || 0);
    const freq = freqPerYear(bond.payment_freq);
    const r = coupon / freq;
    const pmt = this.paymentAmount(bond);
    const maturity = new Date(bond.maturity_date);
    const now = asOf ? new Date(asOf) : new Date();
    const evalDate = now > maturity ? maturity : now;

    let currentBalance = parseFloat(bond.principal_balance || 0);
    let totalPrincipalPaid = parseFloat(bond.total_principal_paid || 0);
    let totalInterestPaid = parseFloat(bond.total_interest_paid || 0);
    const lastPayment = bond.last_payment_date ? new Date(bond.last_payment_date) : new Date(bond.issue_date);
    let currentDate = new Date(lastPayment);

    const dates = this.paymentDates(bond).filter(d => d > lastPayment && d <= evalDate);
    const transactions = [];
    for (const pd of dates) {
      const interest = Math.round(currentBalance * r * 100) / 100;
      const principal = Math.round((pmt - interest) * 100) / 100;
      currentBalance = Math.round((currentBalance - principal) * 100) / 100;
      totalPrincipalPaid = Math.round((totalPrincipalPaid + principal) * 100) / 100;
      totalInterestPaid = Math.round((totalInterestPaid + interest) * 100) / 100;
      transactions.push({
        transaction_date: pd.toISOString().split('T')[0],
        interest,
        principal,
        balance: currentBalance,
      });
      currentDate = pd;
    }

    const days = daysBetween(currentDate, evalDate, bond.day_count);
    const accrued = Math.round(currentBalance * dailyRate(coupon, bond.day_count, evalDate.getFullYear()) * days * 100) / 100;

    return {
      face_value: face,
      payment_amount: Math.round(pmt * 100) / 100,
      principal_balance: Math.round(currentBalance * 100) / 100,
      total_principal_paid: Math.round(totalPrincipalPaid * 100) / 100,
      total_interest_paid: Math.round(totalInterestPaid * 100) / 100,
      accrued_interest: accrued,
      last_payment_date: currentDate.toISOString().split('T')[0],
      last_accrual_date: evalDate.toISOString().split('T')[0],
      next_payment_date: this.paymentDates(bond).find(d => d > evalDate)?.toISOString().split('T')[0] || null,
      transactions,
    };
  }
}

module.exports = { BondAmortization };
