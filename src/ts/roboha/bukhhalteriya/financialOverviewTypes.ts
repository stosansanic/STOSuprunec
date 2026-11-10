/** Compact, read-only financial aggregates. Money is UAH, rounded by PostgreSQL. */
export interface FinancialPeriodTotals {
  turnover: number;
  workRevenue: number;
  partsRevenue: number;
  partsCost: number;
  workPayroll: number;
  partsPayroll: number;
  payrollAccrued: number;
  grossEarnings: number;
  operatingExpenses: number;
  profit: number;
  settledReceipts: number;
  payrollPaid: number;
  suppliersPaid: number;
  expensesPaid: number;
  totalPaid: number;
  netKnownMovement: number;
  closedActs: number;
  avgCheck: number;
  excludedExpenses: number;
  excludedExpensesPaid: number;
}

export interface FinancialEmployee {
  id: number;
  name: string;
  role: string;
  accrued: number;
  paidInPeriod: number;
  due: number;
  overpaid: number;
}

export interface FinancialWarning {
  code: string;
  message: string;
  count: number;
  amount: number;
  severity: 'info' | 'warning';
}

export interface FinancialOverview {
  formatVersion: 1;
  complete: true;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  generatedAt: string;
  revision: string;
  current: FinancialPeriodTotals;
  previous: FinancialPeriodTotals;
  employees: FinancialEmployee[];
  employeeCount: number;
  expenseCategories: Array<{ category: string; accrued: number; paid: number; included: boolean; cashIncluded: boolean }>;
  paymentChannels: Array<{ method: string; incoming: number; outgoing: number }>;
  balances: {
    asOf: string;
    basis: 'reconstructed_current_records';
    receivables: number;
    suppliers: number;
    payroll: number;
    expenses: number;
    totalLiabilities: number;
    undatedAdvances: number;
    cashBalance: null;
    freeCash: null;
  };
  inventory: { value: number; count: number; asOf: 'current'; measuredAt: string };
  quality: { estimates: boolean; warnings: FinancialWarning[] };
}
