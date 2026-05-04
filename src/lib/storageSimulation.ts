/**
 * @file storageSimulation.ts
 * @description
 * 工具方法：用于在前端模拟电网侧储能电站的全生命周期运行，
 * 包括：年循环次数、SOH 演化、电池更换逻辑以及年度/全周期放电量。
 */

export interface YearResult {
  /** 日历年份（从 1 开始计数） */
  year: number;
  /** 电池役龄：自最近一次更换后已运行的年数（从 1 开始计数） */
  batteryAge: number;
  /** 年初 SOH（0~1） */
  sohStart: number;
  /** 年末 SOH（0~1） */
  sohEnd: number;
  /** 本年末是否触发下一年初更换 */
  replaced: boolean;
  /** 本年总循环次数（次/年） */
  annualCycles: number;
  /** 本年放电量（MWh） */
  annualEnergyMWh: number;
  /** 当前这块电池自安装以来的累积循环次数 */
  cumulativeCyclesSinceReplacement: number;
}

export interface SimulationOptions {
  /** 项目总运营年限，例如 25 */
  operationYears: number;
  /** 装机容量（MWh） */
  nominalCapacity: number;
  /**
   * 系统效率（AC-to-AC），可输入 0.86 或 86
   * 会自动归一化为 [0, 1]
   */
  systemEfficiency: number;
  /**
   * 放电深度 DOD，可输入 0.95 或 95
   * 会自动归一化为 [0, 1]
   */
  dod: number;
  /**
   * 月度平均日循环次数（长度必须为 12，对应 1~12 月）
   * 元素单位：次/天
   */
  monthlyCycles: number[];
  /**
   * 首年综合衰减率，可输入 0.03 或 3（表示 3%）
   * 作为“相对 100% 容量”的累计衰减
   */
  firstYearDegradation: number;
  /**
   * 第 2 年及以后每年的线性衰减率，可输入 0.02 或 2（表示 2%）
   */
  annualDegradation: number;
  /**
   * 理论最大循环寿命（当前逻辑中仅作参考，不强制触发更换）
   */
  maxCyclesLimit: number;
  /**
   * SOH 更换阈值，可输入 0.8 或 80（表示 80%）
   * 当年末 SOH 低于阈值，则在下一年初进行更换
   */
  replaceThreshold?: number;
  /**
   * 是否按实际每月天数计算：
   * - true：按 31,28,31,30,... 计算
   * - false：每月固定 30.4 天
   */
  useActualMonthDays?: boolean;
}

export interface SimulationResult {
  /** 各年份的详细结果数组 */
  rows: YearResult[];
  /** 全周期总放电量（MWh） */
  totalEnergyMWh: number;
  /** 发生电池更换的具体年份列表（年末决策、下一年初更换） */
  replacementYears: number[];
}

/**
 * 归一化比例值，支持 [0,1] 或百分比 [0,100] 输入。
 * @param value 原始比例或百分比
 * @returns 归一化到 [0,1] 的数值
 */
function normalizeRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value > 1 ? value / 100 : value;
}

const ACTUAL_MONTH_DAYS: number[] = [
  31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
];

/**
 * 根据月度日均循环与月天数计算年总循环次数。
 * @param monthlyCycles 12 个月的平均日循环次数
 * @param useActualMonthDays 是否使用实际月天数
 * @returns 全年总循环次数
 */
function computeAnnualCycles(
  monthlyCycles: number[],
  useActualMonthDays: boolean,
): number {
  if (monthlyCycles.length !== 12) {
    throw new Error('monthlyCycles 必须包含 12 个元素（对应 1~12 月）。');
  }

  const daysPerMonth = useActualMonthDays
    ? ACTUAL_MONTH_DAYS
    : Array.from({ length: 12 }, () => 30.4);

  let annualCycles = 0;
  for (let i = 0; i < 12; i += 1) {
    annualCycles += monthlyCycles[i] * daysPerMonth[i];
  }
  return annualCycles;
}

/**
 * 模拟储能项目在给定运营年限内的 SOH、放电量与更换计划。
 *
 * 衰减模型（针对每一段“电池寿命周期”，从新电池或更换当年开始重新计算）：
 * - 设 i 为当前电池自安装以来的年份索引（i=1 表示全新电池的第一年）；
 * - 累计衰减（相对 100% 额定容量）：
 *   - 若 i=1，则年初衰减 deg_start(1)=0；
 *   - 年末衰减 deg_end(i) = first_year_degradation + annual_degradation * max(0, i-1)；
 * - SOH_start(i) = 1 - deg_start(i)；
 *   SOH_end(i)   = 1 - deg_end(i)；
 *   年平均 SOH_avg(i) = (SOH_start + SOH_end) / 2。
 *
 * 更换逻辑：
 * - 若某年年末 SOH_end < replace_threshold，则在“下一年初”完成更换；
 * - 更换后视为全新电池，SOH 恢复至 100%，役龄重新自 1 开始计数，并继续套用同样的衰减规律。
 *
 * @param options 仿真输入参数
 * @returns 仿真结果（逐年数据、全周期总放电量、更换年份列表）
 */
export function simulateStoragePlant(options: SimulationOptions): SimulationResult {
  const {
    operationYears,
    nominalCapacity,
    systemEfficiency,
    dod,
    monthlyCycles,
    firstYearDegradation,
    annualDegradation,
    maxCyclesLimit, // 当前逻辑中未硬性使用，仅保留以便后续扩展
    replaceThreshold = 0.8,
    useActualMonthDays = false,
  } = options;

  const eff = normalizeRatio(systemEfficiency);
  const dodNorm = normalizeRatio(dod);
  const replaceTh = normalizeRatio(replaceThreshold);
  const firstDeg = normalizeRatio(firstYearDegradation);
  const annualDeg = normalizeRatio(annualDegradation);

  const annualCyclesTemplate = computeAnnualCycles(
    monthlyCycles,
    useActualMonthDays,
  );

  let batteryAgeCompletedYears = 0;
  let cyclesSinceReplacement = 0;
  let replacementNextYear = false;

  const rows: YearResult[] = [];
  const replacementYears: number[] = [];
  let totalEnergyMWh = 0;

  for (let year = 1; year <= operationYears; year += 1) {
    // 如果上一年末已经决定更换，则在本年初完成更换并重置状态
    if (replacementNextYear) {
      batteryAgeCompletedYears = 0;
      cyclesSinceReplacement = 0;
      replacementNextYear = false;
    }

    // 自最近一次更换以来的年索引：1 代表全新电池第一年
    const yearIndex = batteryAgeCompletedYears + 1;

    // 计算本年的年初和年末累计衰减
    let degStart: number;
    if (yearIndex === 1) {
      degStart = 0;
    } else {
      degStart = firstDeg + annualDeg * Math.max(0, yearIndex - 2);
    }

    let degEnd = firstDeg + annualDeg * Math.max(0, yearIndex - 1);

    // 为稳健性，将衰减限制在 [0,1]
    degStart = Math.min(Math.max(degStart, 0), 1);
    degEnd = Math.min(Math.max(degEnd, 0), 1);

    const sohStart = 1 - degStart;
    const sohEnd = 1 - degEnd;
    const sohAvg = 0.5 * (sohStart + sohEnd);

    // 年循环次数（这里按“每年循环模式不变”的假设，直接复用模板）
    const annualCycles = annualCyclesTemplate;
    cyclesSinceReplacement += annualCycles;

    // 有效容量与放电量计算
    const effectiveCapacity = nominalCapacity * sohAvg;
    const annualEnergyMWh =
      effectiveCapacity * dodNorm * eff * annualCycles;
    totalEnergyMWh += annualEnergyMWh;

    // 根据年末 SOH 判断是否在下一年初更换
    const willReplace = sohEnd < replaceTh;
    if (willReplace && year < operationYears) {
      replacementNextYear = true;
      replacementYears.push(year);
    }

    // 若本年不触发更换，则役龄累积 +1 年
    if (!willReplace) {
      batteryAgeCompletedYears += 1;
    }

    rows.push({
      year,
      batteryAge: yearIndex,
      sohStart,
      sohEnd,
      replaced: willReplace,
      annualCycles,
      annualEnergyMWh,
      cumulativeCyclesSinceReplacement: cyclesSinceReplacement,
    });

    // 如需基于 maxCyclesLimit 触发提示，可在此处添加逻辑
    void maxCyclesLimit;
  }

  return {
    rows,
    totalEnergyMWh,
    replacementYears,
  };
}

/**
 * 查询指定年份的放电量（MWh）。
 * @param rows simulateStoragePlant 返回结果中的 rows
 * @param year 需要查询的年份（1 为首年）
 * @returns 对应年份的放电量（MWh）；若不存在该年，返回 0
 */
export function getYearEnergy(rows: YearResult[], year: number): number {
  const match = rows.filter((row) => row.year === year);
  if (match.length === 0) {
    return 0;
  }
  return match.reduce((sum, row) => sum + row.annualEnergyMWh, 0);
}
