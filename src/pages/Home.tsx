
import React, { useState, useMemo, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer,
  LineChart, Line, ComposedChart, Area, PieChart, Pie, Cell
} from 'recharts';
import { 
  TrendingUp, DollarSign, Activity, Settings, Info, 
  AlertTriangle, Save, RefreshCw, FileText, CheckCircle, FolderOpen, Trash2,
  LayoutDashboard, Zap, Gauge, Battery, BatteryWarning, Building2, BookOpen, ScrollText, Database,
  Download, Image as ImageIcon, FileSpreadsheet, ChevronDown
} from 'lucide-react';

type SectionKey =
  | 'overview'
  | 'spot'
  | 'frequency'
  | 'peakshaving'
  | 'capacity'
  | 'lease'
  | 'retirement'
  | 'basics';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import * as XLSX from 'xlsx';
import {
  simulateStoragePlant,
  type SimulationResult,
  type YearResult,
} from '../lib/storageSimulation';

/**
 * 财务工具函数：计算IRR (内部收益率)
 * 使用牛顿迭代法
 */
function calculateIRR(cashFlows: number[], guess = 0.1): number {
  const maxIter = 1000;
  const precision = 1e-7;
  let rate = guess;

  for (let i = 0; i < maxIter; i++) {
    let npv = 0;
    let d_npv = 0;
    
    for (let t = 0; t < cashFlows.length; t++) {
      npv += cashFlows[t] / Math.pow(1 + rate, t);
      d_npv -= (t * cashFlows[t]) / Math.pow(1 + rate, t + 1);
    }

    if (Math.abs(npv) < precision) return rate;
    
    const newRate = rate - npv / d_npv;
    if (Math.abs(newRate - rate) < precision) return newRate;
    rate = newRate;
  }
  return rate;
}

/**
 * 财务工具函数：计算NPV (净现值)
 */
function calculateNPV(rate: number, cashFlows: number[]): number {
  return cashFlows.reduce((acc, val, t) => acc + val / Math.pow(1 + rate, t), 0);
}

// ----------------------------------------------------------------------
// 组件定义
// ----------------------------------------------------------------------

export default function ShandongStorageCalculator() {
  // --- 1. 输入参数状态 (默认值基于PDF报告基准情景) ---
  
  const [params, setParams] = useState({
    // 项目基础
    capacityMW: 200,       // MW
    systemDuration: 4,     // 系统时长 (小时) - 独立参数
    capacityMWh: 800,      // MWh = capacityMW * systemDuration
    lifeSpan: 15,          // 年
    runDays: 350,          // 天/年
    efficiency: 0.85,      // 综合效率
    dodDepth: 0.90,        // DOD充放深度
    degradation: 0.02,     // 年衰减率
    firstYearDeg: 0.00,    // 首年衰减率（0~1）
    replaceThreshold: 0.80,// 更换阈值 SOH（0~1）
    enableReplacement: true, // 是否启用衰减达阈后更换电池逻辑

    // 投资与融资
    epcPrice: 1.60,        // 元/Wh (PDF基准: 1.6, 调整后建议: 0.98~1.5)
    otherCostRatio: 0.05,  // 其他费用占比 (5%)
    debtRatio: 0.70,       // 贷款比例
    interestRate: 0.042,   // 贷款利率 (4.2%)
    loanTerm: 12,          // 贷款期限 (年)
    residualValue: 0.05,   // 残值率

    // 功率分配（现货 vs 调频 vs 调峰）
    spotRatio: 0.7,        // 参与现货比例（0~1）
    frRatio: 0.3,          // 参与调频比例（0~1）
    peakRatio: 0.0,        // 参与调峰比例（0~1）

    // 收益 - 调峰（江苏：迎峰期 1/6/7/12 月，享受顶峰补贴与 0 充电电费）
    pkCyclesSummer: 1.4,             // 迎峰期日均周转次数（1、6、7、12 月）
    pkCyclesNonSummer: 1.5,          // 非迎峰期日均周转次数
    pkPriceDischargeSummer: 0.391,   // 迎峰期放电电价 元/kWh
    pkPriceDischargeNonSummer: 0.391,// 非迎峰期放电电价 元/kWh
    pkPriceSubsidySummer: 0.3,       // 迎峰期顶峰补贴 元/kWh
    pkPriceChargeNonSummer: 0.2346,  // 非迎峰期充电电价 元/kWh
    pkMonthlyChargeOverrides: {} as Record<number, number>, // 按月覆盖充电电价

    // 收益 - 现货套利
    cyclesPerDay: 2,       // 次/天
    spotSpread: 0.4509,    // 元/kWh (净价差)
    spotSpreadGrowth: 0.0, // 年增长率 (保守0)
    spotMarketUncertainty: 0.90, // 市场不确定性系数
    tradingLossFactor: 0.95,     // 交易损耗系数

    // 收益 - 容量补偿（青海发电侧容量电价机制）
    compStandard: 520000,  // [兼容遗留] 元/MW/年
    kFactor: 2.0,          // [兼容遗留] 旧版可用容量系数（小时）
    compPolicyCoeff: 0.65, // [兼容遗留] 政策调整系数

    // 青海容量电价新模型参数
    capSrcType: 'storage' as 'storage' | 'coal' | 'gas' | 'csp', // 电源类型
    capPriceKW: 165,       // 容量补偿标准 元/(kW·年)（2月稿165 / 4月稿185）
    capKRatio: 1.04,       // 容量供需系数 K
    capPeakHours: 4,       // 系统净负荷高峰持续时长 T (h)
    capAuxRate: 10.39,     // 厂用电率 %（储能10.39 / 燃煤6.05 / 燃气3.75 / 光热21.53）
    capDeclareRatio: 100,  // 申报容量比例 %
    
    // 收益 - 容量租赁
    leasePrice: 250,       // 元/kW/年
    leaseRatio: 50,        // 出租率 (%)，例如 50 表示 50%
    
    // 收益 - 辅助服务(调频)：广东独立储能调频测算（容量补偿 + 里程补偿）
    auxIncome: 504,                  // [兼容遗留] 万元/年（不再用于计算，仅保留兼容历史保存数据）
    frCapacityPriceYuanPerMWh: 12,   // 容量补偿单价 元/(MW·h)
    frMileagePerMWPerHour: 30,       // 单位中标容量·小时 调频里程 MW·min/(MW·h)
    frMileagePriceYuanPerMWMin: 0.8, // 里程出清价 元/(MW·min)
    frK1: 1.8,                       // K1 速率（0~2）
    frK2: 1.0,                       // K2 响应（0~1）
    frK3: 1.0,                       // K3 精度（0~1）
    frAnnualHours: 4000,             // 年等效调频小时数 h/年

    // 运营与税务
    opexRate: 0.02,        // 运维费率 (% of CAPEX)
    vatRate: 0.13,         // 增值税率 (销项) - 实际计算用综合税负简化
    vatRefundRatio: 0.50,  // 即征即退比例
    incomeTaxRate: 0.25,   // 企业所得税 (高新15%，基准25%)
    discountRate: 0.08,    // 基准折现率
  });

  // --- 2. 全生命周期衰减 / 更换仿真（与 params 联动） ---
  const lifeCycleSim = useMemo<SimulationResult>(() => {
    // 将 年循环次数 = cyclesPerDay × runDays 均衰为月均索引
    const annualCycles = params.cyclesPerDay * params.runDays;
    const perMonth = annualCycles / 365; // 配合 useActualMonthDays=true
    const monthlyCycles = Array(12).fill(perMonth);
    return simulateStoragePlant({
      operationYears: params.lifeSpan,
      nominalCapacity: params.capacityMWh,
      systemEfficiency: params.efficiency,
      dod: params.dodDepth,
      monthlyCycles,
      firstYearDegradation: params.firstYearDeg,
      annualDegradation: params.degradation,
      maxCyclesLimit: 10000,
      replaceThreshold: params.enableReplacement ? params.replaceThreshold : 0, // 0 代表从不触发更换
      useActualMonthDays: true,
    });
  }, [params.lifeSpan, params.capacityMWh, params.efficiency, params.dodDepth, params.cyclesPerDay, params.runDays, params.firstYearDeg, params.degradation, params.replaceThreshold, params.enableReplacement]);

  // --- 2.5 调峰按月分解（江苏迎峰期模型，与基础数据 / 调峰比例 联动） ---
  const peakshavingMonthly = useMemo(() => {
    const MONTHS = [
      { month: 1, days: 31 }, { month: 2, days: 28 }, { month: 3, days: 31 },
      { month: 4, days: 30 }, { month: 5, days: 31 }, { month: 6, days: 30 },
      { month: 7, days: 31 }, { month: 8, days: 31 }, { month: 9, days: 30 },
      { month: 10, days: 31 }, { month: 11, days: 30 }, { month: 12, days: 31 },
    ];
    const isPk = (m: number) => m === 1 || m === 6 || m === 7 || m === 12;
    // 调峰参与的额定容量(MWh) = 装机容量 × 调峰比例 × DOD
    const ratedEnergyMWh = params.capacityMWh * params.peakRatio * params.dodDepth;
    return MONTHS.map(m => {
      const isPeak = isPk(m.month);
      const cycles = isPeak ? params.pkCyclesSummer : params.pkCyclesNonSummer;
      const dischargeDailyMWh = ratedEnergyMWh * cycles;
      const chargeDailyMWh = params.efficiency > 0 ? dischargeDailyMWh / params.efficiency : 0;
      const dischargeMWh = dischargeDailyMWh * m.days;
      const chargeMWh = chargeDailyMWh * m.days;
      const dischargePrice = isPeak ? params.pkPriceDischargeSummer : params.pkPriceDischargeNonSummer;
      const subsidy = isPeak ? params.pkPriceSubsidySummer : 0;
      const defaultChargePrice = isPeak ? 0 : params.pkPriceChargeNonSummer;
      const chargePrice = params.pkMonthlyChargeOverrides[m.month] ?? defaultChargePrice;
      const incomeDischarge = dischargeMWh * 1000 * dischargePrice;
      const incomeSubsidy = dischargeMWh * 1000 * subsidy;
      const costCharge = chargeMWh * 1000 * chargePrice;
      const profit = incomeDischarge + incomeSubsidy - costCharge;
      return {
        month: m.month, days: m.days, isSummer: isPeak,
        dischargeMWh, chargeMWh,
        incomeDischarge, incomeSubsidy, costCharge, profit, chargePrice,
      };
    });
  }, [
    params.capacityMWh, params.peakRatio, params.dodDepth, params.efficiency,
    params.pkCyclesSummer, params.pkCyclesNonSummer,
    params.pkPriceDischargeSummer, params.pkPriceDischargeNonSummer,
    params.pkPriceSubsidySummer, params.pkPriceChargeNonSummer,
    params.pkMonthlyChargeOverrides,
  ]);

  // 调峰基准年净收益（万元，未含 SOH 衰减）
  const peakshavingAnnualWan = useMemo(
    () => peakshavingMonthly.reduce((s, r) => s + r.profit, 0) / 10000,
    [peakshavingMonthly]
  );

  // --- 3. 实时核心测算逻辑 ---

  const results = useMemo(() => {
    // A. 投资概算
    const totalInvestment = params.capacityMWh * 1000 * 1000 * params.epcPrice * (1 + params.otherCostRatio); // Total in Yuan
    const debtAmount = totalInvestment * params.debtRatio;
    const equityAmount = totalInvestment * (1 - params.debtRatio);

    // B. 逐年现金流计算
    const yearlyData = [];
    let accumulatedCashFlow = -equityAmount; // 累计现金流(资本金视角)
    
    // 现金流数组用于计算IRR
    const projectCashFlows = [-totalInvestment]; // 全投资CF
    const equityCashFlows = [-equityAmount];     // 资本金CF

    for (let year = 1; year <= params.lifeSpan; year++) {
      // 1. 物理参数
      // 电池实际可用容量衰减：优先采用全生命周期仿真结果（含更换后 SOH 回升逻辑）
      const simRow = lifeCycleSim.rows.find(r => r.year === year);
      const sohAvg = simRow ? 0.5 * (simRow.sohStart + simRow.sohEnd) : Math.pow(1 - params.degradation, year - 1);
      const degradFactor = sohAvg;
      const availableMWh = params.capacityMWh * degradFactor;
      
      // 2. 收入测算 (万元)
      
      // (1) 现货套利
      // 年放电量 (MWh) = 容量(衰减后) × DOD × 次数 × 天数 × 效率 × 现货功率比例
      const annualDischargeMWh = availableMWh * params.dodDepth * params.cyclesPerDay * params.runDays * params.efficiency * params.spotRatio;
      // 价差按年复合增长 (spotSpreadGrowth 为小数, 如 0.02 表示 +2%/年)
      const yearSpread = params.spotSpread * Math.pow(1 + params.spotSpreadGrowth, year - 1);
      // 理论收入
      const theoreticalSpotIncome = (annualDischargeMWh * 1000 * yearSpread) / 10000; 
      // 修正后实际收入 (含税口径, 与下游 vat / 所得税计算保持勾稽)
      const spotIncome = theoreticalSpotIncome * params.spotMarketUncertainty * params.tradingLossFactor;
      // 销项增值税额(万元) = 含税收入 × 税率 / (1 + 税率)；税后(不含税)现货收入 = 含税收入 / (1 + 税率)
      const spotIncomeAfterTax = spotIncome / (1 + params.vatRate);
      const spotVatOutput = spotIncome - spotIncomeAfterTax;

      // (2) 容量补偿（青海省发电侧容量电价机制 / 可靠容量补偿）
      // 公式（储能）：年度容量电费 = 申报容量(kW) × K × 容量补偿标准(元/kW·年)
      //   申报容量 = 有效容量 × 申报比例
      //   有效容量 = P × (1 − 厂用电率) × MIN(满功率放电时长 / T, 100%)
      //   满功率放电时长 = E ÷ P
      const _capAuxR = (params.capAuxRate || 0) / 100;
      const _capDur = params.capacityMW > 0 ? params.capacityMWh / params.capacityMW : 0;
      const _capT = params.capPeakHours || 1;
      const _capReliCoef = params.capSrcType === 'storage'
        ? (1 - _capAuxR) * Math.min(_capDur / _capT, 1)
        : (1 - _capAuxR);
      const _capEffMW = params.capacityMW * _capReliCoef;
      const _capDeclMW = _capEffMW * (params.capDeclareRatio / 100);
      // 年度容量电费(万元) = 申报容量(kW) × K × 单价(元/kW·年) ÷ 10000
      const compIncome = (_capDeclMW * 1000) * params.capKRatio * params.capPriceKW / 10000;

      // (3) 容量租赁
      // 年租赁收入(万元) = 装机容量(MW) × 出租率(%) ÷ 100 × 1000(kW/MW) × 租赁单价(元/kW·年) ÷ 10000
      const leaseIncome = (params.capacityMW * 1000 * (params.leaseRatio / 100) * params.leasePrice) / 10000;

      // (4) 辅助服务（调频）：广东独立储能 “容量补偿 + 里程补偿”
      // 参与调频容量(MW) = 装机功率 × 调频比例
      // 综合 K = clamp(K1 × K2 × K3, 0, 2)
      // 年容量补偿(元) = 中标容量 × 容量单价(元/MW·h) × 年等效小时
      // 年里程补偿(元) = 中标容量 × 单位中标容量小时里程(MW·min/(MW·h)) × 里程价(元/MW·min) × K × 年等效小时
      const frClearedCapacityMW = params.capacityMW * params.frRatio;
      const _frK = Math.min(Math.max(params.frK1 * params.frK2 * params.frK3, 0), 2);
      const frHourlyCapacityYuan = frClearedCapacityMW * params.frCapacityPriceYuanPerMWh;
      const frHourlyMileageYuan = frClearedCapacityMW * params.frMileagePerMWPerHour * params.frMileagePriceYuanPerMWMin * _frK;
      const frAnnualBaseWan = ((frHourlyCapacityYuan + frHourlyMileageYuan) * params.frAnnualHours) / 10000;
      const auxIncome = frAnnualBaseWan * degradFactor; // 随容量衰减折算

      // (5) 调峰收益（江苏：迎峰期 1/6/7/12 月，按月分解后年化，随 SOH 衰减折算）
      const peakIncome = peakshavingAnnualWan * degradFactor;

      const totalRevenue = spotIncome + compIncome + leaseIncome + auxIncome + peakIncome;

      // 3. 成本测算 (万元)
      const opex = (totalInvestment / 10000) * params.opexRate;
      
      // 折旧 (直线法, 残值5%)
      const depreciation = ((totalInvestment / 10000) * (1 - params.residualValue)) / params.lifeSpan;

      // 财务费用 (利息)
      // 等额本金简化计算
      const principalRepayment = year <= params.loanTerm ? (debtAmount / params.loanTerm) / 10000 : 0;
      const remainingDebt = year <= params.loanTerm 
        ? (debtAmount / 10000) - (principalRepayment * (year - 1)) 
        : 0;
      const interest = remainingDebt * params.interestRate;

      // 4. 税费
      // 简易增值税附加: 假设进项已抵扣完(运营期), 实际税负率按经验值 8.5% (含退税后)
      // PDF: "即征即退50%，实际税负8.5%"
      // 这里的Revenue是含税还是不含? PDF测算通常Revenue含税。
      // 假设 totalRevenue 含税。
      const vatTaxes = totalRevenue / (1 + params.vatRate) * 0.085;
      const surcharges = vatTaxes * 0.12; // 附加税

      // 5. 利润
      // 利润总额 = 不含税收入 - 不含税成本 - 财务费用 - 附加税
      // 简化：EBITDA - 折旧 - 利息
      // 这里为了快速计算，采用：
      // 净收入(不含税) —— 与上方现货税后口径保持勾稽
      const revenueExclTax = totalRevenue / (1 + params.vatRate);
      const totalCostExclTax = opex + depreciation + interest + surcharges; // OPEX含不含税? 假设OPEX为不含税支出
      
      const profitBeforeTax = revenueExclTax - totalCostExclTax;
      const incomeTax = profitBeforeTax > 0 ? profitBeforeTax * params.incomeTaxRate : 0;
      const netProfit = profitBeforeTax - incomeTax;

      // 6. 现金流
      // 经营性现金流 (净利 + 折旧)
      const ocf = netProfit + depreciation; 
      
      // 全投资净现金流 (不含融资成本)
      // = EBIT * (1-Tax) + Depreciation - Capex(0) - ChangeInWorkingCapital
      // 简化: (RevenueExcl - Opex - Surcharges) * (1-Tax) + Depreciation * TaxRate ???
      // 采用标准定义: NCF = NetProfit + Interest*(1-Tax) + Depreciation
      const projectNCF = netProfit + interest * (1 - params.incomeTaxRate) + depreciation;
      
      // 资本金净现金流 (含融资成本, 扣除还本)
      const equityNCF = ocf - principalRepayment; // 已扣利息在NetProfit里

      accumulatedCashFlow += equityNCF * 10000; // 转回元

      projectCashFlows.push(projectNCF * 10000);
      equityCashFlows.push(equityNCF * 10000);

      // 全口径年放电量 (MWh)：与 LCOS 测算口径一致，反映物理放出电量
      const annualTotalDischargeMWh = availableMWh * params.dodDepth * params.cyclesPerDay * params.runDays * params.efficiency;

      yearlyData.push({
        year,
        revenue: totalRevenue,
        revenueExclTax,        // 不含税总收入（万元）
        opex,                  // 运维费（万元）
        depreciation,          // 折旧（万元）
        interest,              // 利息（万元）
        vatTaxes,              // 综合增值税负（万元，含即征即退）
        surcharges,            // 附加税（万元）
        incomeTax,             // 企业所得税（万元）
        netProfit,
        projectNCF,
        equityNCF,
        annualTotalDischargeMWh,
        cost: opex + interest + incomeTax,
        sohStart: simRow?.sohStart ?? 1,
        sohEnd: simRow?.sohEnd ?? Math.pow(1 - params.degradation, year),
        replaced: simRow?.replaced ?? false,
        breakdown: {
          spot: spotIncome,                  // 含税
          spotAfterTax: spotIncomeAfterTax,  // 税后(不含税)
          spotVatOutput,                     // 销项税额
          comp: compIncome,
          lease: leaseIncome,
          aux: auxIncome,
          peak: peakIncome
        }
      });
    }

    // 回收残值
    const terminalValue = (totalInvestment / 10000) * params.residualValue;
    projectCashFlows[params.lifeSpan] += terminalValue * 10000;
    equityCashFlows[params.lifeSpan] += terminalValue * 10000; // 假设债务已还清

    // C. 指标计算
    const projectIRR = calculateIRR(projectCashFlows);
    const equityIRR = calculateIRR(equityCashFlows);
    const npv = calculateNPV(params.discountRate, projectCashFlows);
    
    // 静态回收期
    let paybackPeriod = 0;
    {
      let cum = -totalInvestment;
      for (let i = 1; i < projectCashFlows.length; i++) {
        if (cum < 0) {
          cum += projectCashFlows[i];
          if (cum >= 0) {
            paybackPeriod = (i - 1) + (Math.abs(cum - projectCashFlows[i]) / projectCashFlows[i]);
            break;
          }
        }
      }
    }

    // 动态回收期（折现现金流回收期）
    let dynamicPayback = 0;
    {
      let cum = -totalInvestment;
      for (let i = 1; i < projectCashFlows.length; i++) {
        const disc = projectCashFlows[i] / Math.pow(1 + params.discountRate, i);
        if (cum < 0) {
          cum += disc;
          if (cum >= 0) {
            dynamicPayback = (i - 1) + (Math.abs(cum - disc) / disc);
            break;
          }
        }
      }
    }

    // LCOS：折现 (CAPEX + OPEX − 残值) ÷ 折现总放电量(kWh)
    let discountedCostYuan = totalInvestment;
    let discountedDischargeKWh = 0;
    for (let i = 1; i <= params.lifeSpan; i++) {
      const y = yearlyData[i - 1];
      const r = Math.pow(1 + params.discountRate, i);
      discountedCostYuan += (y.opex * 10000) / r;            // 运维 (万元→元)
      discountedDischargeKWh += (y.annualTotalDischargeMWh * 1000) / r;
    }
    discountedCostYuan -= (terminalValue * 10000) / Math.pow(1 + params.discountRate, params.lifeSpan);
    const lcos = discountedDischargeKWh > 0 ? discountedCostYuan / discountedDischargeKWh : 0; // 元/kWh

    // 全生命周期累计指标
    const lifetimeRevenueWan = yearlyData.reduce((a, b) => a + b.revenue, 0);
    const lifetimeNetProfitWan = yearlyData.reduce((a, b) => a + b.netProfit, 0);
    const lifetimeOpexWan = yearlyData.reduce((a, b) => a + b.opex, 0);
    const lifetimeDischargeMWh = yearlyData.reduce((a, b) => a + b.annualTotalDischargeMWh, 0);
    const avgNetProfitWan = lifetimeNetProfitWan / params.lifeSpan;
    // 资产回报率(ROA) = 年均净利润 ÷ 总投资
    const roa = totalInvestment > 0 ? (avgNetProfitWan * 10000) / totalInvestment : 0;

    return {
      totalInvestment,     // 元
      debtAmount,
      equityAmount,
      yearlyData,
      projectIRR,
      equityIRR,
      npv,                 // 元
      paybackPeriod,       // 年
      dynamicPayback,      // 年
      lcos,                // 元/kWh
      roa,                 // 小数
      avgRevenue: lifetimeRevenueWan / params.lifeSpan,
      avgNetProfit: avgNetProfitWan,
      lifetimeRevenueWan,
      lifetimeNetProfitWan,
      lifetimeOpexWan,
      lifetimeDischargeMWh,
      terminalValueWan: terminalValue,
    };
  }, [params, lifeCycleSim, peakshavingAnnualWan]);

  /**
   * 计算基准年放电量（不考虑衰减，用于现货收入展示）
   */
  const annualDischargeMWh = useMemo(() => {
    return params.capacityMWh * params.dodDepth * params.cyclesPerDay * params.runDays * params.efficiency * params.spotRatio;
  }, [params.capacityMWh, params.dodDepth, params.cyclesPerDay, params.runDays, params.efficiency, params.spotRatio]);

  // --- 通知状态 ---
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showSavesPanel, setShowSavesPanel] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionKey>('overview');

  const showNotification = useCallback((type: 'success' | 'error', msg: string) => {
    setNotification({ type, msg });
    setTimeout(() => setNotification(null), 3000);
  }, []);

  // --- 保存测算 ---
  const handleSaveCalculation = useCallback(() => {
    try {
      const timestamp = Date.now();
      const dateStr = new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const saveData = {
        id: timestamp,
        name: `测算 ${dateStr}`,
        params,
        summary: {
          projectIRR: results.projectIRR,
          equityIRR: results.equityIRR,
          npv: results.npv,
          paybackPeriod: results.paybackPeriod,
          totalInvestment: results.totalInvestment,
        },
      };
      const existing: typeof saveData[] = JSON.parse(localStorage.getItem('sd_storage_saves') || '[]');
      existing.unshift(saveData);
      localStorage.setItem('sd_storage_saves', JSON.stringify(existing.slice(0, 20)));
      showNotification('success', `已保存「${saveData.name}」`);
    } catch {
      showNotification('error', '保存失败，请重试');
    }
  }, [params, results, showNotification]);

  // --- 读取保存记录 ---
  const getSavedCalculations = () => {
    try {
      return JSON.parse(localStorage.getItem('sd_storage_saves') || '[]') as Array<{
        id: number; name: string; params: typeof params;
        summary: { projectIRR: number; equityIRR: number; npv: number; paybackPeriod: number; totalInvestment: number };
      }>;
    } catch { return []; }
  };

  const handleDeleteSave = (id: number) => {
    const saves = getSavedCalculations().filter(s => s.id !== id);
    localStorage.setItem('sd_storage_saves', JSON.stringify(saves));
    showNotification('success', '已删除');
    setShowSavesPanel(prev => prev); // trigger re-render
  };

  const handleLoadSave = (savedParams: typeof params) => {
    setParams(savedParams);
    setShowSavesPanel(false);
    showNotification('success', '已加载保存的测算参数');
  };

  // ============ 导出（PDF / PNG / Excel） ============
  // 公共：把 #main-report-content 渲染成 canvas（处理掉 backdrop-filter / oklch / 渐变兜底）
  const captureReportCanvas = useCallback(async (): Promise<HTMLCanvasElement | null> => {
    const element = document.getElementById('main-report-content');
    if (!element) { showNotification('error', '未找到报告区域'); return null; }
    await new Promise(r => requestAnimationFrame(() => r(null)));
    if ((document as any).fonts?.ready) {
      try { await (document as any).fonts.ready; } catch {}
    }
    return await html2canvas(element, {
      scale: Math.min(window.devicePixelRatio || 1, 2),
      useCORS: true,
      allowTaint: true,
      logging: false,
      backgroundColor: '#f9fafb',
      windowWidth: element.scrollWidth,
      windowHeight: element.scrollHeight,
      onclone: (doc) => {
        const root = doc.getElementById('main-report-content');
        if (!root) return;
        const all = root.querySelectorAll<HTMLElement>('*');
        all.forEach(el => {
          const cs = doc.defaultView?.getComputedStyle(el);
          if (!cs) return;
          el.style.backdropFilter = 'none';
          (el.style as any).webkitBackdropFilter = 'none';
          if (cs.filter && cs.filter !== 'none') el.style.filter = 'none';
          if (cs.backgroundImage && cs.backgroundImage !== 'none') {
            el.style.backgroundImage = 'none';
            const isTransparent = !cs.backgroundColor || cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent';
            if (isTransparent) {
              const isDark = (el.closest('section')?.className || '').includes('bg-[radial-gradient') || /text-white|text-slate-(50|100|200|300)|text-emerald-(50|100|200)/.test(el.className);
              el.style.backgroundColor = isDark ? '#0f172a' : 'transparent';
            }
          }
          (['color','backgroundColor','borderColor'] as const).forEach(k => {
            const v = (cs as any)[k] as string;
            if (v && /oklch|lab\(|lch\(|color\(/.test(v)) {
              (el.style as any)[k] = k === 'color' ? '#0f172a' : '#ffffff';
            }
          });
        });
      },
    });
  }, []);

  // —— PDF：封面 + 内容（带页眉页脚 / 页码 / 边距 / 智能换页避免裁切）——
  const handleExportPDF = async () => {
    setIsExporting(true);
    try {
      const canvas = await captureReportCanvas();
      if (!canvas) return;

      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
      const pageW = pdf.internal.pageSize.getWidth();   // 210
      const pageH = pdf.internal.pageSize.getHeight();  // 297
      const margin = { top: 18, bottom: 16, left: 10, right: 10 };
      const contentW = pageW - margin.left - margin.right;
      const contentH = pageH - margin.top - margin.bottom;

      const dateStr = new Date().toLocaleDateString('zh-CN');
      const dateFile = dateStr.replace(/\//g, '-');
      const projectName = '广东独立储能项目（现货 + 容量电价）';

      // —— 页眉 / 页脚（注意：jsPDF 默认字体不支持中文 → 此处仅用 ASCII） ——
      const drawChrome = (pageNum: number, totalPages: number) => {
        // 顶部色带
        pdf.setFillColor(5, 46, 33);    // emerald-950
        pdf.rect(0, 0, pageW, 10, 'F');
        pdf.setFillColor(16, 185, 129); // emerald-500
        pdf.rect(0, 10, pageW, 1.2, 'F');
        // 顶部文字 (ASCII only)
        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(9);
        pdf.setFont('helvetica', 'normal');
        pdf.text('YICHU ENERGY  /  STORAGE PROJECT REVENUE REPORT', margin.left, 6.8);
        pdf.text(dateStr.replace(/\//g, '-'), pageW - margin.right, 6.8, { align: 'right' });
        // 页脚分隔线
        pdf.setDrawColor(220, 220, 220);
        pdf.setLineWidth(0.2);
        pdf.line(margin.left, pageH - margin.bottom + 6, pageW - margin.right, pageH - margin.bottom + 6);
        // 页脚文字 (ASCII only)
        pdf.setTextColor(120, 120, 120);
        pdf.setFontSize(8);
        pdf.text('YICHU ENERGY  ·  CONFIDENTIAL', margin.left, pageH - 5);
        pdf.text(`Page ${pageNum} / ${totalPages}`, pageW - margin.right, pageH - 5, { align: 'right' });
      };

      // —— 封面页（用离屏 HTML + html2canvas 渲染，确保中文字符正常显示） ——
      const drawCover = async () => {
        const A4_W_PX = 794;   // A4 在 96dpi 下的宽度
        const A4_H_PX = 1123;  // A4 在 96dpi 下的高度
        const host = document.createElement('div');
        host.style.cssText = `position:fixed; left:-99999px; top:0; width:${A4_W_PX}px; height:${A4_H_PX}px; z-index:-1;`;
        const safeDate = dateStr.replace(/\//g, '-');
        const fy = results.yearlyData[0];
        host.innerHTML = `
          <div style="
            width:${A4_W_PX}px; height:${A4_H_PX}px; box-sizing:border-box;
            background:linear-gradient(160deg,#031f17 0%,#063b29 45%,#03241a 100%);
            font-family:'PingFang SC','Microsoft YaHei','Hiragino Sans GB','Source Han Sans CN','Noto Sans CJK SC','sans-serif';
            color:#ecfdf5; position:relative; overflow:hidden; padding:60px 56px;">
            <!-- 装饰光斑 -->
            <div style="position:absolute; right:-60px; top:80px; width:260px; height:260px; border-radius:50%; background:radial-gradient(circle,rgba(16,185,129,0.28),rgba(6,59,41,0) 70%); filter:blur(6px);"></div>
            <div style="position:absolute; left:-60px; bottom:120px; width:240px; height:240px; border-radius:50%; background:radial-gradient(circle,rgba(110,231,183,0.18),rgba(6,59,41,0) 70%); filter:blur(8px);"></div>
            <!-- LOGO 标识带 -->
            <div style="display:flex; align-items:center; gap:14px; margin-bottom:18px;">
              <div style="width:6px; height:64px; background:#10b981; border-radius:3px; box-shadow:0 0 18px rgba(16,185,129,0.6);"></div>
              <div>
                <div style="font-size:13px; letter-spacing:.32em; color:#6ee7b7; font-weight:600;">REAL-TIME REVENUE MODELING</div>
                <div style="margin-top:4px; font-size:11px; letter-spacing:.18em; color:#a7f3d0;">YICHU ENERGY · 易储数智能源</div>
              </div>
            </div>
            <!-- 主标题 -->
            <div style="margin-top:28px;">
              <div style="font-size:46px; font-weight:800; color:#ffffff; line-height:1.15; letter-spacing:.02em;">储能项目收益测算报告</div>
              <div style="margin-top:10px; font-size:18px; color:#bbf7d0;">${projectName}</div>
              <div style="margin-top:24px; height:1px; background:linear-gradient(to right,rgba(110,231,183,0.6),rgba(110,231,183,0));"></div>
            </div>
            <!-- KPI 4 卡 -->
            <div style="margin-top:42px; display:grid; grid-template-columns:repeat(4,1fr); gap:14px;">
              ${[
                { k: '装机规模',   v: `${params.capacityMW} MW`,                          s: `${params.capacityMWh} MWh / ${params.systemDuration} h` },
                { k: '总投资',     v: `${(results.totalInvestment / 1e8).toFixed(2)} 亿元`, s: `单价 ${params.epcPrice.toFixed(2)} 元/Wh` },
                { k: '资本金 IRR', v: `${(results.equityIRR * 100).toFixed(2)} %`,        s: `项目 IRR ${(results.projectIRR * 100).toFixed(2)} %` },
                { k: '静态回收期', v: `${results.paybackPeriod.toFixed(2)} 年`,           s: `运营 ${params.lifeSpan} 年` },
              ].map(it => `
                <div style="border:1px solid rgba(110,231,183,0.35); border-radius:10px; padding:16px 16px 14px; background:rgba(8,56,42,0.6); position:relative;">
                  <div style="position:absolute; top:0; left:0; right:0; height:2px; background:linear-gradient(to right,transparent,#6ee7b7,transparent);"></div>
                  <div style="font-size:13px; color:#a7f3d0; letter-spacing:.06em;">${it.k}</div>
                  <div style="margin-top:10px; font-size:24px; font-weight:700; color:#ffffff;">${it.v}</div>
                  <div style="margin-top:6px; font-size:11px; color:#bbf7d0;">${it.s}</div>
                </div>
              `).join('')}
            </div>
            <!-- Snapshot 摘要 -->
            <div style="margin-top:48px;">
              <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-size:13px; color:#a7f3d0; letter-spacing:.28em;">PROJECT SNAPSHOT</span>
                <span style="flex:1; height:1px; background:linear-gradient(to right,rgba(110,231,183,0.55),rgba(110,231,183,0));"></span>
              </div>
              <div style="margin-top:18px; font-size:15px; line-height:2.0; color:#dcfce7;">
                <div>综合效率 ${(params.efficiency * 100).toFixed(1)}% · DOD ${(params.dodDepth * 100).toFixed(0)}% · 循环 ${params.cyclesPerDay} 次/日 × ${params.runDays} 天</div>
                <div>贷款比例 ${(params.debtRatio * 100).toFixed(0)}% · 贷款利率 ${(params.interestRate * 100).toFixed(2)}% · 折现率 ${(params.discountRate * 100).toFixed(1)}%</div>
                <div>功率分配 现货 ${(params.spotRatio * 100).toFixed(0)}% / 调频 ${(params.frRatio * 100).toFixed(0)}% / 调峰 ${(params.peakRatio * 100).toFixed(0)}%</div>
                <div>增值税率 ${(params.vatRate * 100).toFixed(1)}% · 所得税率 ${(params.incomeTaxRate * 100).toFixed(0)}%</div>
                <div style="color:#6ee7b7;">首年收入 ${(fy?.revenue ?? 0).toFixed(0)} 万元 · 年均净利润 ${results.avgNetProfit.toFixed(0)} 万元 · NPV ${(results.npv/10000).toFixed(0)} 万元 · LCOS ${results.lcos.toFixed(3)} 元/kWh</div>
              </div>
            </div>
            <!-- 底部水印 -->
            <div style="position:absolute; left:56px; right:56px; bottom:48px; display:flex; justify-content:space-between; align-items:end; color:#a7f3d0; font-size:12px;">
              <div>报告日期 · ${safeDate}</div>
              <div style="text-align:right;">
                <div style="font-size:14px; font-weight:600; color:#ffffff;">YICHU · 易储数智能源</div>
                <div style="margin-top:2px; opacity:.7;">独立储能项目收益测算与运营分析</div>
              </div>
            </div>
          </div>
        `;
        document.body.appendChild(host);
        try {
          // 等下一帧确保字体/布局就绪
          await new Promise(r => requestAnimationFrame(() => r(null)));
          if ((document as any).fonts?.ready) {
            try { await (document as any).fonts.ready; } catch {}
          }
          const coverCanvas = await html2canvas(host.firstElementChild as HTMLElement, {
            scale: 2,
            useCORS: true,
            backgroundColor: '#031f17',
            logging: false,
          });
          pdf.addImage(coverCanvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pageW, pageH);
        } finally {
          document.body.removeChild(host);
        }
      };

      await drawCover();

      // —— 内容页（按整页高度切片，避免横向裁切；为内容预留页眉页脚边距） ——
      const imgFullW_px = canvas.width;
      const imgFullH_px = canvas.height;
      const mmPerPx = contentW / imgFullW_px;            // 把图缩放到 contentW
      const fullImgH_mm = imgFullH_px * mmPerPx;
      const sliceH_px = contentH / mmPerPx;              // 每页对应的源像素高度

      let sy = 0;
      const slices: { dataUrl: string; h_mm: number }[] = [];
      while (sy < imgFullH_px) {
        const h_px = Math.min(sliceH_px, imgFullH_px - sy);
        const c = document.createElement('canvas');
        c.width = imgFullW_px;
        c.height = h_px;
        const ctx = c.getContext('2d');
        if (!ctx) break;
        ctx.fillStyle = '#f9fafb';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(canvas, 0, sy, imgFullW_px, h_px, 0, 0, imgFullW_px, h_px);
        slices.push({ dataUrl: c.toDataURL('image/jpeg', 0.92), h_mm: h_px * mmPerPx });
        sy += h_px;
      }

      slices.forEach(s => {
        pdf.addPage();
        pdf.addImage(s.dataUrl, 'JPEG', margin.left, margin.top, contentW, s.h_mm);
      });

      // 全部页面绘制 chrome（封面除外）
      const total = pdf.getNumberOfPages();
      for (let p = 2; p <= total; p++) {
        pdf.setPage(p);
        drawChrome(p - 1, total - 1);
      }
      // 封面页脚水印已绘
      void fullImgH_mm;

      pdf.save(`易储数智能源_储能测算报告_${dateFile}.pdf`);
      showNotification('success', 'PDF 报告已导出！');
    } catch (err) {
      console.error('[ExportPDF] 失败：', err);
      const msg = err instanceof Error ? err.message : String(err);
      showNotification('error', `PDF 导出失败：${msg.slice(0, 60)}`);
    } finally {
      setIsExporting(false);
      setShowExportMenu(false);
    }
  };

  // —— PNG 长图 ——
  const handleExportPNG = async () => {
    setIsExporting(true);
    try {
      const canvas = await captureReportCanvas();
      if (!canvas) return;
      const dateFile = new Date().toLocaleDateString('zh-CN').replace(/\//g, '-');
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `易储数智能源_储能测算报告_${dateFile}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showNotification('success', '长图（PNG）已导出！');
    } catch (err) {
      console.error('[ExportPNG] 失败：', err);
      const msg = err instanceof Error ? err.message : String(err);
      showNotification('error', `图片导出失败：${msg.slice(0, 60)}`);
    } finally {
      setIsExporting(false);
      setShowExportMenu(false);
    }
  };

  // —— Excel：多 sheet 测算数据 ——
  const handleExportExcel = async () => {
    setIsExporting(true);
    try {
      const wb = XLSX.utils.book_new();

      // Sheet 1：项目参数
      const paramsSheet = [
        ['类别', '参数', '数值', '单位'],
        ['基础', '装机功率', params.capacityMW, 'MW'],
        ['基础', '系统时长', params.systemDuration, 'h'],
        ['基础', '装机容量', params.capacityMWh, 'MWh'],
        ['基础', '运营年限', params.lifeSpan, '年'],
        ['基础', '年运行天数', params.runDays, '天'],
        ['基础', '综合效率', params.efficiency, ''],
        ['基础', 'DOD 充放深度', params.dodDepth, ''],
        ['基础', '年衰减率', params.degradation, ''],
        ['投资', '单位造价 EPC', params.epcPrice, '元/Wh'],
        ['投资', '其他成本系数', params.otherCostRatio, ''],
        ['投资', '残值率', params.residualValue, ''],
        ['融资', '贷款比例', params.debtRatio, ''],
        ['融资', '贷款利率', params.interestRate, ''],
        ['融资', '贷款期限', params.loanTerm, '年'],
        ['功率分配', '参与现货比例', params.spotRatio, ''],
        ['功率分配', '参与调频比例', params.frRatio, ''],
        ['功率分配', '参与调峰比例', params.peakRatio, ''],
        ['现货', '日循环次数', params.cyclesPerDay, '次/天'],
        ['现货', '净价差', params.spotSpread, '元/kWh'],
        ['容量电价', '容量补偿标准', params.capPriceKW, '元/(kW·年)'],
        ['容量电价', 'K 系数', params.capKRatio, ''],
        ['容量电价', '净负荷高峰持续时长 T', params.capPeakHours, 'h'],
        ['容量电价', '厂用电率', params.capAuxRate, '%'],
        ['容量电价', '申报容量比例', params.capDeclareRatio, '%'],
        ['容量租赁', '租赁单价', params.leasePrice, '元/kW/年'],
        ['容量租赁', '出租率', params.leaseRatio, '%'],
        ['调频', '容量补偿单价', params.frCapacityPriceYuanPerMWh, '元/(MW·h)'],
        ['调频', '调频里程系数', params.frMileagePerMWPerHour, 'MW·min/(MW·h)'],
        ['调频', '里程出清价', params.frMileagePriceYuanPerMWMin, '元/(MW·min)'],
        ['调频', 'K1 速率', params.frK1, ''],
        ['调频', 'K2 响应', params.frK2, ''],
        ['调频', 'K3 精度', params.frK3, ''],
        ['调频', '年等效调频小时数', params.frAnnualHours, 'h/年'],
        ['调峰', '迎峰期日周转次数(1/6/7/12月)', params.pkCyclesSummer, '次/日'],
        ['调峰', '非迎峰期日周转次数', params.pkCyclesNonSummer, '次/日'],
        ['调峰', '迎峰期放电电价', params.pkPriceDischargeSummer, '元/kWh'],
        ['调峰', '非迎峰期放电电价', params.pkPriceDischargeNonSummer, '元/kWh'],
        ['调峰', '迎峰期顶峰补贴', params.pkPriceSubsidySummer, '元/kWh'],
        ['调峰', '非迎峰期充电电价', params.pkPriceChargeNonSummer, '元/kWh'],
        ['运营', '运维费率', params.opexRate, '%/CAPEX'],
        ['税务', '增值税率', params.vatRate, ''],
        ['税务', '即征即退比例', params.vatRefundRatio, ''],
        ['税务', '所得税率', params.incomeTaxRate, ''],
        ['财务', '折现率', params.discountRate, ''],
      ];
      const ws1 = XLSX.utils.aoa_to_sheet(paramsSheet);
      ws1['!cols'] = [{ wch: 10 }, { wch: 22 }, { wch: 14 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws1, '项目参数');

      // Sheet 2：核心指标
      const kpiSheet = [
        ['指标', '数值', '单位'],
        ['总投资', results.totalInvestment / 10000, '万元'],
        ['资本金', results.equityAmount / 10000, '万元'],
        ['债务总额', results.debtAmount / 10000, '万元'],
        ['项目 IRR', results.projectIRR, ''],
        ['资本金 IRR', results.equityIRR, ''],
        ['NPV (项目)', results.npv / 10000, '万元'],
        ['静态回收期', results.paybackPeriod, '年'],
        ['年均收入', results.avgRevenue, '万元'],
        ['年均净利润', results.avgNetProfit, '万元'],
      ];
      const ws2 = XLSX.utils.aoa_to_sheet(kpiSheet);
      ws2['!cols'] = [{ wch: 18 }, { wch: 16 }, { wch: 10 }];
      XLSX.utils.book_append_sheet(wb, ws2, '核心指标');

      // Sheet 3：年度收益与现金流
      const yearHead = ['年份','期初SOH','期末SOH','是否更换','现货收益(万元)','容量电价(万元)','容量租赁(万元)','调频收益(万元)','调峰收益(万元)','总收入(万元)','成本(万元)','净利润(万元)','项目NCF(万元)','资本金NCF(万元)'];
      const yearRows = results.yearlyData.map(y => [
        y.year, y.sohStart, y.sohEnd, y.replaced ? '是' : '否',
        y.breakdown.spot, y.breakdown.comp, y.breakdown.lease, y.breakdown.aux, y.breakdown.peak,
        y.revenue, y.cost, y.netProfit, y.projectNCF, y.equityNCF
      ]);
      const ws3 = XLSX.utils.aoa_to_sheet([yearHead, ...yearRows]);
      ws3['!cols'] = yearHead.map((_, i) => ({ wch: i === 0 ? 6 : 14 }));
      XLSX.utils.book_append_sheet(wb, ws3, '年度收益与现金流');

      // Sheet 4：SOH 衰减
      const sohHead = ['年份','期初SOH','期末SOH','可用容量(MWh)','是否更换'];
      const sohRows = results.yearlyData.map(y => [
        y.year, y.sohStart, y.sohEnd, params.capacityMWh * y.sohEnd, y.replaced ? '是' : '否'
      ]);
      const ws4 = XLSX.utils.aoa_to_sheet([sohHead, ...sohRows]);
      ws4['!cols'] = sohHead.map((_, i) => ({ wch: i === 0 ? 6 : 14 }));
      XLSX.utils.book_append_sheet(wb, ws4, 'SOH 衰减');

      // Sheet 0（首位）：报告元信息
      const meta = [
        ['项目名称', '广东独立储能项目（现货 + 容量电价）'],
        ['报告日期', new Date().toLocaleString('zh-CN', { hour12: false })],
        ['出品方', '易储数智能源'],
        ['版本', 'CS01 / v1.0'],
        ['说明', '本工作簿包含：项目参数 / 核心指标 / 年度收益与现金流 / SOH 衰减 共 4 个 Sheet。'],
      ];
      const ws0 = XLSX.utils.aoa_to_sheet(meta);
      ws0['!cols'] = [{ wch: 14 }, { wch: 60 }];
      XLSX.utils.book_append_sheet(wb, ws0, '报告说明');
      // 把"报告说明"挪到首位
      wb.SheetNames = ['报告说明', '项目参数', '核心指标', '年度收益与现金流', 'SOH 衰减'];

      const dateFile = new Date().toLocaleDateString('zh-CN').replace(/\//g, '-');
      XLSX.writeFile(wb, `易储数智能源_储能测算数据_${dateFile}.xlsx`);
      showNotification('success', 'Excel 已导出！');
    } catch (err) {
      console.error('[ExportExcel] 失败：', err);
      const msg = err instanceof Error ? err.message : String(err);
      showNotification('error', `Excel 导出失败：${msg.slice(0, 60)}`);
    } finally {
      setIsExporting(false);
      setShowExportMenu(false);
    }
  };

  // 兼容历史调用名
  const handleExportReport = handleExportPDF;

  // --- 界面渲染辅助函数 ---
  const formatCurrency = (val: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 0 }).format(val);
  const formatPercent = (val: number) => (val * 100).toFixed(2) + '%';
  const formatNumber = (val: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(val);
  const firstYearRevenue = results.yearlyData[0]?.revenue ?? 0;
  const revenueStructure = [
    {
      label: '现货套利',
      shortLabel: '现货',
      value: results.yearlyData[0]?.breakdown.spot ?? 0,
      color: 'from-blue-500 to-cyan-400',
      glow: 'shadow-blue-500/20',
      accent: 'bg-blue-400',
      fill: '#3b82f6',
      description: '价差套利 / 分时滚动交易',
    },
    {
      label: '容量补偿',
      shortLabel: '补偿',
      value: results.yearlyData[0]?.breakdown.comp ?? 0,
      color: 'from-violet-500 to-fuchsia-400',
      glow: 'shadow-violet-500/20',
      accent: 'bg-violet-400',
      fill: '#8b5cf6',
      description: '容量价值 / 政策补偿兑现',
    },
    {
      label: '容量租赁',
      shortLabel: '租赁',
      value: results.yearlyData[0]?.breakdown.lease ?? 0,
      color: 'from-emerald-500 to-lime-400',
      glow: 'shadow-emerald-500/20',
      accent: 'bg-emerald-400',
      fill: '#10b981',
      description: '容量出租 / 长协收益锁定',
    },
    {
      label: '调频收益',
      shortLabel: '调频',
      value: results.yearlyData[0]?.breakdown.aux ?? 0,
      color: 'from-orange-500 to-amber-400',
      glow: 'shadow-orange-500/20',
      accent: 'bg-orange-400',
      fill: '#f97316',
      description: '调频调峰 / AGC性能结算',
    },
    {
      label: '调峰收益',
      shortLabel: '调峰',
      value: results.yearlyData[0]?.breakdown.peak ?? 0,
      color: 'from-rose-500 to-pink-400',
      glow: 'shadow-rose-500/20',
      accent: 'bg-rose-400',
      fill: '#f43f5e',
      description: '迎峰期顶峰补贴 / 月度滚动结算',
    },
  ].map(item => ({
    ...item,
    percent: firstYearRevenue > 0 ? (item.value / firstYearRevenue) * 100 : 0,
  }));

  /** 极简 SVG 迷你折线（性能优于 Recharts，仅用于卡片趋势） */
  const Sparkline: React.FC<{ data: number[]; stroke: string; fill?: string; height?: number; }> = ({ data, stroke, fill, height = 36 }) => {
    if (!data || data.length < 2) return null;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const w = 100;
    const pts = data.map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    const polyline = pts.join(' ');
    const area = `0,${height} ${polyline} ${w},${height}`;
    return (
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height }}>
        {fill && <polygon points={area} fill={fill} opacity={0.35} />}
        <polyline points={polyline} fill="none" stroke={stroke} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    );
  };

  // 趋势序列（用于财务指标卡片下的迷你 sparkline）
  const trendNetProfit = results.yearlyData.map(y => y.netProfit);
  const trendRevenue = results.yearlyData.map(y => y.revenue);
  let _cumNCF = -results.totalInvestment / 10000;
  const trendCumNCF = results.yearlyData.map(y => (_cumNCF += y.projectNCF));
  let _cumDiscNCF = -results.totalInvestment / 10000;
  const trendCumDiscNCF = results.yearlyData.map((y, i) => (_cumDiscNCF += y.projectNCF / Math.pow(1 + params.discountRate, i + 1)));
  // 投资折旧后净值（线性折旧后剩余净值）
  const trendInvestmentNet = results.yearlyData.map(y => (results.totalInvestment / 10000) - (y.year * (results.totalInvestment / 10000) * (1 - params.residualValue) / params.lifeSpan));
  // ROA(年度) = 当年净利润 / 总投资
  const trendROA = results.yearlyData.map(y => (y.netProfit * 10000) / results.totalInvestment);
  // LCOS：随累计运行/衰减，呈微幅上升（折现累计成本 ÷ 折现累计放电）
  const trendLcosCum = (() => {
    const arr: number[] = [];
    let costCum = results.totalInvestment;
    let dischCum = 0;
    for (let i = 0; i < results.yearlyData.length; i++) {
      const y = results.yearlyData[i];
      const dr = Math.pow(1 + params.discountRate, i + 1);
      costCum += (y.opex * 10000) / dr;
      dischCum += (y.annualTotalDischargeMWh * 1000) / dr;
      arr.push(dischCum > 0 ? costCum / dischCum : 0);
    }
    return arr;
  })();

  // 输入控件封装
  const InputField = ({ label, value, onChange, unit, step = 0.01, tooltip }: any) => (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1">
        <label className="text-sm font-medium text-gray-700 flex items-center gap-1">
          {label}
          {tooltip && (
            <div className="group relative flex justify-center">
              <Info size={12} className="text-gray-400 cursor-help" />
              <span className="absolute bottom-full mb-2 hidden w-48 p-2 text-xs text-white bg-gray-800 rounded group-hover:block z-10">
                {tooltip}
              </span>
            </div>
          )}
        </label>
        <span className="text-xs text-gray-500">{unit}</span>
      </div>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full px-3 py-2 text-sm border rounded-md border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
      />
    </div>
  );

  const savedList = showSavesPanel ? getSavedCalculations() : [];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">
      {/* 全局通知 Toast */}
      {notification && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-xl text-sm font-medium animate-in fade-in slide-in-from-top-2 ${
          notification.type === 'success' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
        }`}>
          {notification.type === 'success' ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
          {notification.msg}
        </div>
      )}

      {/* 已保存记录抽屉 */}
      {showSavesPanel && (
        <div className="fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowSavesPanel(false)} />
          <div className="relative ml-auto w-96 h-full bg-white shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <h2 className="text-base font-bold text-gray-800">已保存的测算记录</h2>
              <button onClick={() => setShowSavesPanel(false)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {savedList.length === 0 ? (
                <p className="text-center text-gray-400 py-10 text-sm">暂无保存记录</p>
              ) : savedList.map(save => (
                <div key={save.id} className="border border-gray-100 rounded-lg p-3 hover:border-blue-200 hover:bg-blue-50 transition-colors">
                  <div className="flex items-start justify-between mb-2">
                    <span className="text-sm font-medium text-gray-800">{save.name}</span>
                    <button onClick={() => handleDeleteSave(save.id)} className="text-gray-300 hover:text-red-400 ml-2">
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-1 text-xs text-gray-500 mb-3">
                    <span>全投IRR: <span className="text-blue-600 font-semibold">{(save.summary.projectIRR * 100).toFixed(2)}%</span></span>
                    <span>资本金IRR: <span className="text-green-600 font-semibold">{(save.summary.equityIRR * 100).toFixed(2)}%</span></span>
                    <span>回收期: {save.summary.paybackPeriod.toFixed(1)} 年</span>
                    <span>NPV: {(save.summary.npv / 10000).toFixed(0)} 万</span>
                  </div>
                  <button
                    onClick={() => handleLoadSave(save.params)}
                    className="w-full py-1.5 text-xs font-medium text-blue-600 border border-blue-200 rounded-md hover:bg-blue-600 hover:text-white transition-colors"
                  >加载此方案</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 整体布局：左侧深色导航 + 右侧主内容 */}
      <div className="flex min-h-screen">

        {/* 侧边栏导航 */}
        <aside className="w-56 shrink-0 bg-slate-900 text-slate-200 flex flex-col sticky top-0 h-screen">
          <div className="px-5 py-5 border-b border-slate-800 flex items-center gap-3">
            <div className="bg-blue-600 rounded-lg w-10 h-10 flex items-center justify-center font-bold text-white text-[10px] leading-tight text-center px-1">易储<br/>数能</div>
            <div className="leading-tight">
              <h1 className="text-sm font-bold">独立储能收益测算</h1>
              <p className="text-[11px] text-slate-400 mt-0.5">易储能源</p>
            </div>
          </div>
          <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
            {([
              { key: 'overview',  label: '收益总览', icon: LayoutDashboard },
              { key: 'spot',      label: '现货交易', icon: Zap },
              { key: 'frequency', label: '调频收益', icon: Gauge },
              { key: 'peakshaving', label: '调峰收益', icon: Activity },
              { key: 'capacity',  label: '容量电价', icon: Battery },
              { key: 'lease',     label: '容量租赁', icon: Building2 },
              { key: 'retirement',label: '电池退役', icon: BatteryWarning },
              { key: 'basics',    label: '基础数据', icon: Database },
            ] as { key: SectionKey; label: string; icon: any }[]).map(item => {
              const Icon = item.icon;
              const active = activeSection === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => setActiveSection(item.key)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                    active ? 'bg-blue-600 text-white shadow' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <Icon size={16} className="shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="px-4 py-3 border-t border-slate-800 text-[11px] text-slate-500">
            v1.0 · 财务测算平台
          </div>
        </aside>

        {/* 主内容区 */}
        <div className="flex-1 flex flex-col bg-gray-50 min-w-0">

          {/* 顶部工具栏 */}
          <header className="bg-white border-b border-gray-200 sticky top-0 z-20 shadow-sm">
            <div className="px-6 lg:px-8 h-16 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-900 tracking-tight">
                  {{
                    overview: '收益测算总览',
                    spot: '现货交易收益',
                    frequency: '调频(辅助服务)收益',
                    peakshaving: '调峰收益',
                    capacity: '容量电价补偿',
                    lease: '容量租赁收益',
                    retirement: '电池退役 / 全周期衰减模拟',
                    basics: '基础数据与参数',
                  }[activeSection]}
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">易储数智能源 | 独立储能项目收益测算与运营分析</p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowSavesPanel(true)}
                  className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  <FolderOpen size={16} /> 历史记录
                </button>
                <div className="relative">
                  <button
                    onClick={() => setShowExportMenu(v => !v)}
                    disabled={isExporting}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {isExporting ? <RefreshCw size={16} className="animate-spin" /> : <Download size={16} />}
                    {isExporting ? '导出中...' : '导出报告'}
                    <ChevronDown size={14} className={`transition-transform ${showExportMenu ? 'rotate-180' : ''}`} />
                  </button>
                  {showExportMenu && !isExporting && (
                    <>
                      {/* 点击外部关闭 */}
                      <div className="fixed inset-0 z-40" onClick={() => setShowExportMenu(false)} />
                      <div className="absolute right-0 mt-2 w-60 z-50 rounded-xl border border-gray-200 bg-white shadow-xl overflow-hidden">
                        <div className="px-4 py-2.5 text-[11px] uppercase tracking-[0.18em] text-gray-400 bg-gray-50 border-b border-gray-100">
                          选择导出格式
                        </div>
                        <button
                          onClick={handleExportPDF}
                          className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-emerald-50/60 transition-colors"
                        >
                          <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-rose-100 text-rose-600">
                            <FileText size={16} />
                          </span>
                          <span className="flex-1">
                            <span className="block text-sm font-medium text-gray-800">PDF 报告</span>
                            <span className="block text-[11px] text-gray-500 mt-0.5">含封面 / 页眉页脚 · 适合转发</span>
                          </span>
                        </button>
                        <button
                          onClick={handleExportPNG}
                          className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-emerald-50/60 transition-colors"
                        >
                          <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-sky-100 text-sky-600">
                            <ImageIcon size={16} />
                          </span>
                          <span className="flex-1">
                            <span className="block text-sm font-medium text-gray-800">长图（PNG）</span>
                            <span className="block text-[11px] text-gray-500 mt-0.5">整页拼接长图 · 适合社交分享</span>
                          </span>
                        </button>
                        <button
                          onClick={handleExportExcel}
                          className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-emerald-50/60 transition-colors border-t border-gray-100"
                        >
                          <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
                            <FileSpreadsheet size={16} />
                          </span>
                          <span className="flex-1">
                            <span className="block text-sm font-medium text-gray-800">Excel 数据</span>
                            <span className="block text-[11px] text-gray-500 mt-0.5">参数 / 指标 / 现金流 / SOH 多表</span>
                          </span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
                <button
                  onClick={handleSaveCalculation}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 shadow-sm"
                >
                  <Save size={16} /> 保存测算
                </button>
              </div>
            </div>
          </header>

          <main id="main-report-content" className="flex-1 px-6 lg:px-8 py-6 space-y-6">

            {/* ==================== 1. 收益总览 ==================== */}
            {activeSection === 'overview' && (
              <div className="space-y-5">
                {/* ===== 1. 头部 · 标题与首年总收益徽章 ===== */}
                <section className="relative overflow-hidden rounded-2xl border border-slate-800/80 bg-[linear-gradient(135deg,_#0a1224_0%,_#0b1830_50%,_#0a1224_100%)] px-6 py-5 shadow-[0_18px_60px_rgba(8,15,34,0.45)]">
                  <div className="pointer-events-none absolute inset-0 opacity-50">
                    <div className="absolute -left-10 -top-10 h-40 w-40 rounded-full bg-cyan-400/12 blur-3xl"></div>
                    <div className="absolute -bottom-10 right-20 h-40 w-40 rounded-full bg-sky-500/10 blur-3xl"></div>
                  </div>
                  <div className="relative flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h2 className="text-2xl md:text-3xl font-bold text-white tracking-wide">项目收益与财务总览</h2>
                      <p className="mt-1 text-xs md:text-sm text-slate-400">储能项目收益测算 / 数据实时展示 · 含税与不含税口径全勾稽</p>
                    </div>
                    <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-100 backdrop-blur-sm">
                      <span className="relative flex h-2 w-2">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-300 opacity-70"></span>
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_12px_rgba(103,232,249,0.9)]"></span>
                      </span>
                      <span className="text-slate-300">首年总收益</span>
                      <span className="font-mono font-bold text-cyan-200">{formatNumber(firstYearRevenue)}</span>
                      <span className="text-xs text-slate-400">万元</span>
                    </div>
                  </div>
                  <div className="relative mt-4 flex flex-wrap gap-1.5 text-xs">
                    {[
                      { id: 'hero', label: '总览' },
                      { id: 'revenue', label: '收益分析' },
                      { id: 'cashflow', label: '现金流分析' },
                      { id: 'sensitivity', label: '敏感性分析' },
                      { id: 'export', label: '报告导出' },
                    ].map((t, i) => (
                      <a
                        key={t.id}
                        href={`#ov-${t.id}`}
                        className={`rounded-md px-3 py-1.5 transition-all ${i===0 ? 'bg-cyan-400/20 text-cyan-200 border border-cyan-300/40' : 'border border-white/5 text-slate-300 hover:border-white/15 hover:bg-white/5'}`}
                      >{t.label}</a>
                    ))}
                  </div>
                </section>

                {/* ===== 2. Hero · 项目总收益 + 收入构成饼图 ===== */}
                <section id="ov-hero" className="relative overflow-hidden rounded-2xl border border-slate-800/80 bg-[linear-gradient(135deg,_#070f1f_0%,_#0b1830_50%,_#0a1530_100%)] p-6 shadow-[0_18px_60px_rgba(8,15,34,0.45)]">
                  <div className="pointer-events-none absolute inset-0 opacity-50">
                    <div className="absolute -left-20 top-10 h-72 w-72 rounded-full bg-cyan-500/12 blur-[120px]"></div>
                    <div className="absolute right-0 -bottom-10 h-64 w-64 rounded-full bg-violet-500/10 blur-[120px]"></div>
                  </div>
                  <div className="relative grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-stretch">
                    {/* 项目总收益椭圆光晕卡 */}
                    <div className="lg:col-span-5">
                      <div className="relative h-full rounded-2xl border border-cyan-300/15 bg-slate-950/50 p-5 backdrop-blur-sm">
                        <div className="absolute inset-0 rounded-2xl bg-[radial-gradient(circle_at_center,_rgba(34,211,238,0.10),_transparent_60%)]"></div>
                        <div className="relative">
                          <div className="flex items-center gap-2 text-cyan-300/80">
                            <Database size={16} />
                            <span className="text-sm font-medium">项目总收益</span>
                          </div>
                          <div className="mt-6 relative mx-auto flex h-[200px] items-center justify-center">
                            <div className="absolute inset-x-6 inset-y-2 rounded-full border border-cyan-300/15"></div>
                            <div className="absolute inset-x-12 inset-y-6 rounded-full border border-cyan-300/10 border-dashed animate-pulse"></div>
                            <div className="absolute inset-x-2 inset-y-8 rounded-[70%/40%] bg-[radial-gradient(circle,_rgba(34,211,238,0.20),_rgba(15,23,42,0)_70%)] blur-md"></div>
                            <div className="relative text-center">
                              <p className="text-5xl md:text-6xl font-bold leading-none tracking-tight bg-gradient-to-b from-white via-cyan-100 to-cyan-300 bg-clip-text text-transparent">{formatNumber(firstYearRevenue)}</p>
                              <p className="mt-3 text-sm text-cyan-300/80">万元</p>
                            </div>
                          </div>
                          <p className="mt-4 text-center text-xs text-slate-400">首年总收益 / First Year Revenue · 含税合计</p>
                          <div className="mt-4 grid grid-cols-3 gap-2 text-[11px]">
                            <div className="rounded-md border border-white/5 bg-white/[0.03] px-2 py-1.5">
                              <p className="text-slate-400">不含税</p>
                              <p className="mt-0.5 font-mono font-bold text-emerald-300">{formatNumber(results.yearlyData[0].revenueExclTax)}<span className="text-[10px] text-slate-500 ml-0.5">万</span></p>
                            </div>
                            <div className="rounded-md border border-white/5 bg-white/[0.03] px-2 py-1.5">
                              <p className="text-slate-400">净利润</p>
                              <p className="mt-0.5 font-mono font-bold text-violet-300">{formatNumber(results.yearlyData[0].netProfit)}<span className="text-[10px] text-slate-500 ml-0.5">万</span></p>
                            </div>
                            <div className="rounded-md border border-white/5 bg-white/[0.03] px-2 py-1.5">
                              <p className="text-slate-400">EBITDA</p>
                              <p className="mt-0.5 font-mono font-bold text-cyan-200">{formatNumber(results.yearlyData[0].revenueExclTax - results.yearlyData[0].opex - results.yearlyData[0].surcharges)}<span className="text-[10px] text-slate-500 ml-0.5">万</span></p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    {/* 收入构成饼图 + 明细列表 */}
                    <div className="lg:col-span-7">
                      <div className="relative h-full rounded-2xl border border-white/5 bg-slate-950/50 p-5 backdrop-blur-sm">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 text-slate-200">
                            <Activity size={16} className="text-cyan-300" />
                            <span className="text-sm font-medium">收入构成（首年）</span>
                          </div>
                          <span className="text-[11px] text-slate-400">含税口径 · 单位 万元</span>
                        </div>
                        <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
                          <div className="md:col-span-5 relative h-[240px]">
                            <ResponsiveContainer width="100%" height="100%">
                              <PieChart>
                                <Pie data={revenueStructure.filter(d => d.value > 0)} dataKey="value" innerRadius={56} outerRadius={88} paddingAngle={2} stroke="rgba(255,255,255,0.06)" strokeWidth={1}>
                                  {revenueStructure.filter(d => d.value > 0).map((d, i) => (<Cell key={i} fill={d.fill} />))}
                                </Pie>
                                <RechartsTooltip
                                  contentStyle={{ background:'#0b1830', border:'1px solid rgba(255,255,255,0.1)', borderRadius:8, color:'#e2e8f0' }}
                                  formatter={(v: number) => formatNumber(v) + ' 万元'}
                                />
                              </PieChart>
                            </ResponsiveContainer>
                            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                              <span className="text-xs text-slate-400">合计</span>
                              <span className="mt-1 text-xl font-bold text-white">{formatNumber(firstYearRevenue)}</span>
                              <span className="text-[11px] text-slate-500">万元</span>
                            </div>
                          </div>
                          <div className="md:col-span-7 space-y-2">
                            {revenueStructure.filter(item => item.value > 0).map(item => (
                              <div key={item.label} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2">
                                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: item.fill }}></span>
                                <span className="w-20 text-sm font-medium text-slate-200">{item.label}</span>
                                <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                                  <div className="h-full rounded-full" style={{ width: `${Math.max(item.percent, 1)}%`, background: item.fill, opacity: 0.85 }}></div>
                                </div>
                                <span className="w-24 text-right text-sm font-mono text-white">{formatNumber(item.value)} <span className="text-[10px] text-slate-500">万</span></span>
                                <span className="w-14 text-right text-xs font-mono text-slate-400">({item.percent.toFixed(1)}%)</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                {/* ===== 3. 项目基础参数 strip ===== */}
                <section className="relative overflow-hidden rounded-2xl border border-slate-800/80 bg-[linear-gradient(135deg,_#0a1224_0%,_#0b1830_100%)] p-5 shadow-[0_18px_60px_rgba(8,15,34,0.45)]">
                  <div className="mb-3 flex items-center gap-2">
                    <Settings size={16} className="text-cyan-300" />
                    <h3 className="text-sm font-semibold text-slate-200">项目基础参数</h3>
                    <span className="text-[11px] text-slate-500">· 装机 / 时长 / DOD / 综合效率 / 运营年限 全部联动测算结果</span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                    {[
                      { k: '装机功率', v: formatNumber(params.capacityMW), u: 'MW', hint: '功率分配口径', icon: Zap },
                      { k: '系统时长', v: params.systemDuration.toString(), u: '小时', hint: 'E / P = 时长', icon: Battery },
                      { k: '装机容量', v: formatNumber(params.capacityMWh), u: 'MWh', hint: '= 装机功率 × 时长', icon: Database },
                      { k: '综合效率', v: params.efficiency.toFixed(2), u: '', hint: '充→放往返效率', icon: Activity },
                      { k: 'DOD 充放深度', v: params.dodDepth.toFixed(2), u: '', hint: '单次有效放电深度', icon: Gauge },
                      { k: '运营年限', v: params.lifeSpan.toString(), u: '年', hint: '财务测算口径', icon: BookOpen },
                    ].map(p => (
                      <div key={p.k} className="rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
                        <div className="flex items-center justify-between">
                          <p className="text-[11px] text-slate-400">{p.k}</p>
                          <p.icon size={12} className="text-slate-500" />
                        </div>
                        <p className="mt-2 text-2xl font-bold text-white font-mono leading-none">{p.v}<span className="text-xs font-normal text-slate-400 ml-1">{p.u}</span></p>
                        <p className="mt-2 text-[10px] text-slate-500">{p.hint}</p>
                      </div>
                    ))}
                  </div>
                </section>

                {/* ===== 4. 收益分析 anchor · 收益流明细卡 ===== */}
                {(() => {
                  const visibleRevenue = revenueStructure.filter(item => item.value > 0);
                  const colClass = visibleRevenue.length <= 2 ? 'xl:grid-cols-2'
                    : visibleRevenue.length === 3 ? 'xl:grid-cols-3'
                    : visibleRevenue.length === 4 ? 'xl:grid-cols-4'
                    : 'xl:grid-cols-5';
                  return (
                    <section id="ov-revenue" className="relative overflow-hidden rounded-2xl border border-slate-800/80 bg-[linear-gradient(135deg,_#0a1224_0%,_#0b1830_100%)] p-5 shadow-[0_18px_60px_rgba(8,15,34,0.45)]">
                      <div className="mb-3 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <BookOpen size={16} className="text-cyan-300" />
                          <h3 className="text-sm font-semibold text-slate-200">收益流明细 · 五大收入源</h3>
                        </div>
                        <span className="text-[11px] text-slate-500">合计 {formatNumber(firstYearRevenue)} 万元 · 占总收入 100%</span>
                      </div>
                      <div className={`grid grid-cols-1 gap-3 md:grid-cols-2 ${colClass}`}>
                        {visibleRevenue.map(item => (
                          <div key={item.label} className="group relative overflow-hidden rounded-xl border border-white/5 bg-white/[0.03] p-4">
                            <div className={`absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r ${item.color}`}></div>
                            <div className={`absolute -right-8 -top-8 h-24 w-24 rounded-full bg-gradient-to-br ${item.color} opacity-15 blur-2xl`}></div>
                            <div className="relative flex items-start justify-between">
                              <div>
                                <p className="text-sm font-semibold text-white">{item.label}</p>
                                <p className="mt-1 text-[11px] text-slate-400">{item.description}</p>
                              </div>
                              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-slate-300">收益流</span>
                            </div>
                            <div className="relative mt-4 flex items-end justify-between">
                              <div>
                                <p className="text-2xl font-bold text-white font-mono">{formatNumber(item.value)}</p>
                                <p className="text-[11px] text-slate-400">万元 / 首年贡献</p>
                              </div>
                              <div className="text-right">
                                <p className="text-[10px] text-slate-500">占比</p>
                                <p className="mt-0.5 text-sm font-mono text-cyan-200">{item.percent.toFixed(1)}%</p>
                              </div>
                            </div>
                            <div className="relative mt-3 h-1.5 rounded-full bg-white/5 overflow-hidden">
                              <div className={`h-full rounded-full bg-gradient-to-r ${item.color}`} style={{ width: `${Math.max(item.percent, 2)}%` }}></div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  );
                })()}

                {/* ===== 5. 项目财务指标 strip · 8 卡 + sparkline ===== */}
                <section className="relative overflow-hidden rounded-2xl border border-slate-800/80 bg-[linear-gradient(135deg,_#0a1224_0%,_#0b1830_100%)] p-5 shadow-[0_18px_60px_rgba(8,15,34,0.45)]">
                  <div className="mb-3 flex items-center gap-2">
                    <TrendingUp size={16} className="text-cyan-300" />
                    <h3 className="text-sm font-semibold text-slate-200">项目财务指标</h3>
                    <span className="text-[11px] text-slate-500">· 同步勾稽：8 项核心指标均由现金流 / 折现 / 全寿命放电导出</span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
                    {[
                      {
                        icon: DollarSign, color: 'text-cyan-300', spark: '#22d3ee', fill: 'rgba(34,211,238,0.18)',
                        label: '投资总额', value: formatNumber(results.totalInvestment / 10000), unit: '万元',
                        hint: `EPC ${params.epcPrice} 元/Wh · 含其他 ${(params.otherCostRatio*100).toFixed(0)}%`,
                        data: trendInvestmentNet,
                      },
                      {
                        icon: TrendingUp, color: 'text-violet-300', spark: '#a78bfa', fill: 'rgba(167,139,250,0.18)',
                        label: '年均净收益', value: formatNumber(results.avgNetProfit), unit: '万元',
                        hint: `首年 ${formatNumber(results.yearlyData[0].netProfit)} 万元`,
                        data: trendNetProfit,
                      },
                      {
                        icon: Activity, color: 'text-emerald-300', spark: '#34d399', fill: 'rgba(52,211,153,0.18)',
                        label: '项目IRR', value: formatPercent(results.projectIRR), unit: '',
                        hint: `资本金 IRR ${formatPercent(results.equityIRR)}`,
                        data: trendCumNCF,
                      },
                      {
                        icon: RefreshCw, color: 'text-amber-300', spark: '#fbbf24', fill: 'rgba(251,191,36,0.18)',
                        label: '静态回收期', value: results.paybackPeriod.toFixed(2), unit: '年',
                        hint: `运营 ${params.lifeSpan} 年 · 不折现`,
                        data: trendCumNCF,
                      },
                      {
                        icon: RefreshCw, color: 'text-sky-300', spark: '#38bdf8', fill: 'rgba(56,189,248,0.18)',
                        label: '动态回收期', value: results.dynamicPayback.toFixed(2), unit: '年',
                        hint: `@ 折现率 ${(params.discountRate*100).toFixed(1)}%`,
                        data: trendCumDiscNCF,
                      },
                      {
                        icon: DollarSign, color: 'text-cyan-300', spark: '#22d3ee', fill: 'rgba(34,211,238,0.18)',
                        label: '净现值 NPV', value: formatNumber(results.npv / 10000), unit: '万元',
                        hint: `@ 折现率 ${(params.discountRate*100).toFixed(1)}%`,
                        data: trendCumDiscNCF,
                      },
                      {
                        icon: Zap, color: 'text-orange-300', spark: '#fb923c', fill: 'rgba(251,146,60,0.18)',
                        label: 'LCOS', value: results.lcos.toFixed(3), unit: '元/kWh',
                        hint: `全寿命放电 ${formatNumber(results.lifetimeDischargeMWh/10)} 万kWh`,
                        data: trendLcosCum,
                      },
                      {
                        icon: TrendingUp, color: 'text-emerald-300', spark: '#34d399', fill: 'rgba(52,211,153,0.18)',
                        label: '资产回报率 ROA', value: formatPercent(results.roa), unit: '',
                        hint: '= 年均净利 ÷ 总投资',
                        data: trendROA,
                      },
                    ].map(m => (
                      <div key={m.label} className="group relative overflow-hidden rounded-xl border border-white/5 bg-white/[0.03] px-3 py-3 hover:border-white/15 transition-all">
                        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent"></div>
                        <div className="flex items-center justify-between">
                          <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${m.color}`}>
                            <m.icon size={11} />
                            {m.label}
                          </span>
                        </div>
                        <p className="mt-2 text-xl font-bold text-white font-mono leading-none">{m.value}<span className="text-[10px] font-normal text-slate-400 ml-1">{m.unit}</span></p>
                        <p className="mt-1.5 text-[10px] text-slate-500 leading-tight">{m.hint}</p>
                        <div className="mt-2 -mx-1">
                          <Sparkline data={m.data} stroke={m.spark} fill={m.fill} height={28} />
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                {/* ===== 6. 现金流分析 ===== */}
                <section id="ov-cashflow" className="relative overflow-hidden rounded-2xl border border-slate-800/80 bg-[linear-gradient(135deg,_#0a1224_0%,_#0b1830_100%)] p-5 shadow-[0_18px_60px_rgba(8,15,34,0.45)]">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <TrendingUp size={16} className="text-cyan-300" />
                      <h3 className="text-sm font-semibold text-slate-200">全生命周期现金流</h3>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-slate-400">
                      <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-cyan-400"></span>当年净现金流</span>
                      <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-400"></span>年收入</span>
                      <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-violet-400"></span>净利润</span>
                    </div>
                  </div>
                  <div className="h-[320px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={results.yearlyData}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148,163,184,0.12)" />
                        <XAxis dataKey="year" tickLine={false} axisLine={false} tick={{fontSize:11, fill:'#94a3b8'}} />
                        <YAxis tickLine={false} axisLine={false} tick={{fontSize:11, fill:'#94a3b8'}} label={{ value:'万元', angle:-90, position:'insideLeft', style:{fill:'#64748b', fontSize:11} }} />
                        <RechartsTooltip
                          contentStyle={{ background:'#0b1830', border:'1px solid rgba(255,255,255,0.1)', borderRadius:8, color:'#e2e8f0' }}
                          formatter={(v: number) => formatNumber(v) + ' 万元'}
                        />
                        <Bar dataKey="projectNCF" fill="#22d3ee" radius={[4,4,0,0]} barSize={16} name="当年净现金流" />
                        <Line type="monotone" dataKey="revenue" stroke="#10b981" strokeWidth={2} dot={false} name="年收入" />
                        <Area type="monotone" dataKey="netProfit" fill="#8b5cf6" stroke="#8b5cf6" fillOpacity={0.18} name="净利润" />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </section>

                {/* ===== 7. 勾稽关系一览 · 整站计算公式速查 ===== */}
                <section id="ov-formula" className="relative overflow-hidden rounded-2xl border border-cyan-400/15 bg-[linear-gradient(135deg,_#06121f_0%,_#0a1c2f_100%)] p-5 shadow-[0_18px_60px_rgba(8,15,34,0.45)]">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ScrollText size={16} className="text-cyan-300" />
                      <h3 className="text-sm font-semibold text-slate-100">勾稽关系一览 · 整站计算公式速查</h3>
                    </div>
                    <span className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-2 py-0.5 text-[10px] font-mono text-cyan-200">FORMULA · v2.6</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                    {/* 4-1 收入勾稽 */}
                    <div className="rounded-xl border border-blue-400/20 bg-blue-500/[0.04] p-4">
                      <p className="text-xs font-bold text-blue-300 mb-2">① 收入勾稽 · 含税 → 不含税</p>
                      <ol className="space-y-1.5 text-[11px] text-slate-300 leading-relaxed list-decimal pl-4">
                        <li>现货 = 容量 × DOD × 次数 × 天数 × 效率 × 现货比例 × 净价差 × 不确定 × 损耗</li>
                        <li>容量补偿 = 申报容量(kW) × K × 容量价(元/kW·年)；申报容量 = 装机 × (1−厂用)×MIN(E/P÷T,1) × 申报比例</li>
                        <li>容量租赁 = 装机(kW) × 出租率 × 租赁单价</li>
                        <li>调频 = 中标容量 × (容量价 + 单位里程 × 里程价 × K) × 年等效小时</li>
                        <li>调峰 = Σ(月放电×电价+顶峰补贴 − 月充电×充电价)</li>
                        <li className="text-emerald-300">合计含税 = ①+②+③+④+⑤</li>
                        <li className="text-emerald-300">不含税 = 含税 ÷ (1 + 增值税率)</li>
                      </ol>
                    </div>
                    {/* 4-2 投资勾稽 */}
                    <div className="rounded-xl border border-violet-400/20 bg-violet-500/[0.04] p-4">
                      <p className="text-xs font-bold text-violet-300 mb-2">② 投资勾稽 · CAPEX 拆分</p>
                      <ol className="space-y-1.5 text-[11px] text-slate-300 leading-relaxed list-decimal pl-4">
                        <li>总投资 = 容量(Wh) × EPC 单价 × (1 + 其他费用比例)</li>
                        <li>自有资金 Equity = 总投资 × (1 − 贷款比例)</li>
                        <li>银行贷款 Debt   = 总投资 × 贷款比例</li>
                        <li>残值 Residual   = 总投资 × 残值率（运营期末回收）</li>
                        <li className="text-emerald-300">校验：Equity + Debt = 总投资 = {formatNumber(results.totalInvestment/10000)} 万元</li>
                      </ol>
                      <div className="mt-2 grid grid-cols-3 gap-1.5 text-[10px]">
                        <div className="rounded bg-white/5 px-1.5 py-1">
                          <p className="text-slate-400">Equity</p>
                          <p className="font-mono text-violet-200">{formatNumber(results.equityAmount/10000)}</p>
                        </div>
                        <div className="rounded bg-white/5 px-1.5 py-1">
                          <p className="text-slate-400">Debt</p>
                          <p className="font-mono text-violet-200">{formatNumber(results.debtAmount/10000)}</p>
                        </div>
                        <div className="rounded bg-white/5 px-1.5 py-1">
                          <p className="text-slate-400">残值</p>
                          <p className="font-mono text-violet-200">{formatNumber(results.terminalValueWan)}</p>
                        </div>
                      </div>
                    </div>
                    {/* 4-3 现金流与所得税勾稽 */}
                    <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/[0.04] p-4">
                      <p className="text-xs font-bold text-emerald-300 mb-2">③ 利润 & 现金流勾稽</p>
                      <ol className="space-y-1.5 text-[11px] text-slate-300 leading-relaxed list-decimal pl-4">
                        <li>不含税收入 = 总收入 ÷ (1 + VAT)</li>
                        <li>增值税(含即征即退) = 总收入 ÷ (1+VAT) × 8.5%；附加 = VAT × 12%</li>
                        <li>折旧 = (总投资×(1−残值)) ÷ 运营年限（直线法）</li>
                        <li>利润总额 = 不含税收入 − 运维 − 折旧 − 利息 − 附加</li>
                        <li>所得税 = MAX(利润总额, 0) × 所得税率</li>
                        <li>净利润 = 利润总额 − 所得税</li>
                        <li className="text-cyan-200">全投资 NCF = 净利润 + 利息×(1−所得税率) + 折旧</li>
                        <li className="text-cyan-200">资本金 NCF = 净利润 + 折旧 − 本金归还</li>
                      </ol>
                    </div>
                    {/* 4-4 评价指标勾稽 */}
                    <div className="rounded-xl border border-amber-400/20 bg-amber-500/[0.04] p-4">
                      <p className="text-xs font-bold text-amber-300 mb-2">④ 评价指标勾稽 · 输出口径</p>
                      <ol className="space-y-1.5 text-[11px] text-slate-300 leading-relaxed list-decimal pl-4">
                        <li>项目 IRR：使 ΣCFᵢ ÷ (1+r)ⁱ = 0 的 r（牛顿法）</li>
                        <li>资本金 IRR：用 EquityCF 同上</li>
                        <li>NPV = Σ NCFᵢ ÷ (1+折现率)ⁱ − 总投资</li>
                        <li>静态回收期：累计 NCF 首次≥0 的年份（线性插值）</li>
                        <li>动态回收期：折现累计 NCF 首次≥0</li>
                        <li>LCOS = 折现(CAPEX+OPEX−残值) ÷ 折现累计放电(kWh)</li>
                        <li>ROA = 年均净利 ÷ 总投资</li>
                      </ol>
                    </div>
                  </div>
                  <p className="mt-3 text-[11px] text-slate-400 leading-relaxed">
                    全链路勾稽闭环：<span className="text-cyan-200">物理参数</span>（容量/时长/DOD/效率/衰减）→ <span className="text-blue-200">五大收入流</span> → <span className="text-emerald-200">不含税利润 & 折旧</span> → <span className="text-violet-200">全投资 / 资本金现金流</span> → <span className="text-amber-200">IRR / NPV / 回收期 / LCOS / ROA</span>。所有税率、折现率、贷款利率均为单一来源（params），改动一次全站联动。
                  </p>
                </section>

                {/* ===== 8. 首年损益分配 + 财务勾稽校验 ===== */}
                <section id="ov-sensitivity" className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="rounded-2xl border border-slate-800/80 bg-[linear-gradient(135deg,_#0a1224_0%,_#0b1830_100%)] p-5 shadow-[0_18px_60px_rgba(8,15,34,0.45)]">
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-slate-200">首年损益分配（含税收入 → 净利润）</h3>
                      <span className="text-[11px] text-slate-500">勾稽 · 自上而下</span>
                    </div>
                    {(() => {
                      const y = results.yearlyData[0];
                      const ebitda = y.revenueExclTax - y.opex - y.surcharges;
                      const ebit = ebitda - y.depreciation;
                      const ebt = ebit - y.interest;
                      const rows = [
                        { k: '① 含税总收入', v: y.revenue, color: 'text-white' },
                        { k: '   − 销项及附加(含税抵扣还原)', v: -(y.revenue - y.revenueExclTax + y.surcharges), color: 'text-amber-300' },
                        { k: '② 不含税收入', v: y.revenueExclTax, color: 'text-emerald-300' },
                        { k: '   − 运维 OPEX', v: -y.opex, color: 'text-slate-300' },
                        { k: '   − 附加税(VAT × 12%)', v: -y.surcharges, color: 'text-slate-300' },
                        { k: '③ EBITDA', v: ebitda, color: 'text-cyan-200' },
                        { k: '   − 折旧（直线法）', v: -y.depreciation, color: 'text-slate-300' },
                        { k: '④ EBIT 营业利润', v: ebit, color: 'text-cyan-200' },
                        { k: '   − 利息', v: -y.interest, color: 'text-slate-300' },
                        { k: '⑤ 税前利润 EBT', v: ebt, color: 'text-cyan-200' },
                        { k: `   − 所得税(${(params.incomeTaxRate*100).toFixed(0)}%)`, v: -y.incomeTax, color: 'text-slate-300' },
                        { k: '⑥ 净利润', v: y.netProfit, color: 'text-emerald-300' },
                      ];
                      return (
                        <div className="space-y-1.5 text-[12px] font-mono">
                          {rows.map((r, i) => (
                            <div key={i} className={`flex justify-between border-b border-white/5 pb-1 ${r.color}`}>
                              <span>{r.k}</span>
                              <span>{formatNumber(r.v)} 万元</span>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                  <div className="rounded-2xl border border-slate-800/80 bg-[linear-gradient(135deg,_#0a1224_0%,_#0b1830_100%)] p-5 shadow-[0_18px_60px_rgba(8,15,34,0.45)]">
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-slate-200">财务指标校验 · 全寿命合计</h3>
                      <span className="text-[11px] text-slate-500">单位 万元 / 年限 {params.lifeSpan} 年</span>
                    </div>
                    <div className="space-y-2 text-[12px]">
                      {[
                        ['初始总投资 CAPEX', `${formatNumber(results.totalInvestment/10000)}`, 'text-white'],
                        ['├ 自有资金 Equity', `${formatNumber(results.equityAmount/10000)}`, 'text-violet-300'],
                        ['├ 银行贷款 Debt', `${formatNumber(results.debtAmount/10000)}`, 'text-violet-300'],
                        ['└ 期末残值', `${formatNumber(results.terminalValueWan)}`, 'text-violet-300'],
                        ['全寿命营业收入', `${formatNumber(results.lifetimeRevenueWan)}`, 'text-emerald-300'],
                        ['全寿命运维支出', `${formatNumber(results.lifetimeOpexWan)}`, 'text-amber-300'],
                        ['全寿命净利润', `${formatNumber(results.lifetimeNetProfitWan)}`, 'text-emerald-300'],
                        ['全寿命累计放电(MWh)', `${formatNumber(results.lifetimeDischargeMWh)}`, 'text-cyan-200'],
                        [`NPV @ ${(params.discountRate*100).toFixed(1)}%`, `${formatNumber(results.npv/10000)}`, 'text-cyan-200'],
                        ['项目 IRR / 资本金 IRR', `${formatPercent(results.projectIRR)} / ${formatPercent(results.equityIRR)}`, 'text-cyan-200'],
                        ['静态 / 动态回收期', `${results.paybackPeriod.toFixed(2)} 年 / ${results.dynamicPayback.toFixed(2)} 年`, 'text-cyan-200'],
                        ['LCOS / ROA', `${results.lcos.toFixed(3)} 元·kWh⁻¹ / ${formatPercent(results.roa)}`, 'text-cyan-200'],
                      ].map(([k, v, c], i) => (
                        <div key={i} className="flex justify-between border-b border-white/5 pb-1.5">
                          <span className="text-slate-400">{k}</span>
                          <span className={`font-mono font-semibold ${c}`}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>

                {/* ===== 9. 报告导出 anchor — 提示 ===== */}
                <section id="ov-export" className="rounded-2xl border border-slate-800/80 bg-[linear-gradient(135deg,_#0a1224_0%,_#0b1830_100%)] p-4 shadow-[0_18px_60px_rgba(8,15,34,0.45)] flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm text-slate-300">
                    <FileText size={16} className="text-cyan-300" />
                    报告导出：可使用页面顶部「导出报告」按钮下载 PDF / PNG / Excel；测算结果可通过「保存测算」入历史记录。
                  </div>
                  <span className="rounded-md bg-cyan-400/10 px-2.5 py-1 text-[11px] text-cyan-200">建议：路演前先保存当前参数版本，便于敏感性对比</span>
                </section>
              </div>
            )}

            {/* ==================== 2. 现货交易 ==================== */}
            {activeSection === 'spot' && (
              <div className="space-y-5">
              {/* —— 数据实时展示舱（科技绿 · 海报风）· 置顶 —— */}
              <section className="relative overflow-hidden rounded-[28px] border border-emerald-400/15 bg-[linear-gradient(135deg,_#03140d_0%,_#062b1f_45%,_#03140d_100%)] p-6 md:p-10 shadow-[0_24px_80px_rgba(5,46,33,0.45)]">
                <div className="pointer-events-none absolute inset-0 opacity-60">
                  <div className="absolute -left-20 top-10 h-64 w-64 rounded-full bg-emerald-400/15 blur-[100px]"></div>
                  <div className="absolute right-0 bottom-0 h-72 w-72 rounded-full bg-teal-300/10 blur-[120px]"></div>
                  <div className="absolute inset-0 bg-[linear-gradient(rgba(16,185,129,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(16,185,129,0.06)_1px,transparent_1px)] bg-[size:48px_48px]"></div>
                  <div className="absolute inset-x-10 top-24 h-px bg-gradient-to-r from-transparent via-emerald-300/40 to-transparent"></div>
                </div>

                <div className="relative flex flex-col gap-3 md:flex-row md:items-end md:justify-between mb-8">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-emerald-300/80">REAL-TIME DATA HUB</p>
                    <h3 className="mt-2 text-2xl md:text-3xl font-bold text-white tracking-wide">数据实时展示舱 <span className="text-emerald-300">// 现货运行</span></h3>
                    <p className="mt-2 max-w-xl text-sm text-emerald-100/70">基于当前参数实时演算的核心运行指标，可直接作为路演 / 海报展示。</p>
                  </div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/30 bg-emerald-400/10 px-4 py-2 text-xs text-emerald-100 backdrop-blur-sm">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-70"></span>
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.9)]"></span>
                    </span>
                    LIVE · {new Date().toLocaleTimeString('zh-CN', { hour12: false })}
                  </div>
                </div>

                <div className="relative grid grid-cols-2 lg:grid-cols-4 gap-5">
                  {[
                    {
                      key: 'revenue',
                      label: '首年现货收益（税后）',
                      sub: 'First-Year Spot Revenue · After VAT',
                      value: formatNumber(results.yearlyData[0].breakdown.spotAfterTax),
                      unit: '万元',
                      hint: `税率 ${(params.vatRate*100).toFixed(1)}% · 含税 ${formatNumber(results.yearlyData[0].breakdown.spot)} 万`,
                    },
                    {
                      key: 'discharge',
                      label: '首年放电量',
                      sub: 'Annual Discharge',
                      value: formatNumber(annualDischargeMWh),
                      unit: 'MWh',
                      hint: `≈ ${formatNumber(annualDischargeMWh / 10)} 万kWh`,
                    },
                    {
                      key: 'cycles',
                      label: '调用次数',
                      sub: 'Yearly Cycles',
                      value: formatNumber(params.cyclesPerDay * params.runDays),
                      unit: '次/年',
                      hint: `${params.cyclesPerDay} 次/天 × ${params.runDays} 天`,
                    },
                    {
                      key: 'duration',
                      label: '调用时长',
                      sub: 'Active Duration',
                      value: formatNumber(params.cyclesPerDay * params.runDays * params.systemDuration),
                      unit: 'h/年',
                      hint: `单次 ${params.systemDuration} h`,
                    },
                  ].map((it, idx) => (
                    <div
                      key={it.key}
                      className="group relative overflow-hidden rounded-2xl border border-emerald-300/15 bg-[linear-gradient(160deg,rgba(6,78,59,0.55)_0%,rgba(2,20,14,0.85)_100%)] p-5 backdrop-blur-md transition-all duration-300 hover:-translate-y-1 hover:border-emerald-300/40 hover:shadow-[0_18px_60px_rgba(16,185,129,0.25)]"
                    >
                      <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-emerald-300 to-transparent opacity-70"></div>
                      <div className="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-emerald-400/10 blur-2xl transition-opacity duration-300 group-hover:opacity-80"></div>
                      <div className="absolute right-3 top-3 font-mono text-[10px] tracking-widest text-emerald-300/60">0{idx + 1}</div>

                      <p className="text-[11px] uppercase tracking-[0.22em] text-emerald-300/70">{it.sub}</p>
                      <p className="mt-1 text-sm font-medium text-emerald-50">{it.label}</p>

                      <div className="mt-5 flex items-baseline gap-2">
                        <span className="text-[2.4rem] font-bold leading-none tracking-tight bg-gradient-to-br from-white via-emerald-100 to-emerald-300 bg-clip-text text-transparent">
                          {it.value}
                        </span>
                        <span className="text-xs text-emerald-200/70">{it.unit}</span>
                      </div>

                      <div className="mt-5 flex items-center justify-between text-[11px] text-emerald-200/60">
                        <span className="font-mono">{it.hint}</span>
                        <span className="inline-flex items-center gap-1 text-emerald-300">
                          <span className="h-1 w-1 rounded-full bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.9)]"></span>
                          ONLINE
                        </span>
                      </div>

                      <div className="mt-4 h-1 rounded-full bg-emerald-900/40 overflow-hidden">
                        <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-emerald-400 via-teal-300 to-emerald-200 group-hover:w-full transition-all duration-700"></div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="relative mt-6 flex flex-wrap items-center justify-between gap-3 text-[11px] text-emerald-200/50 font-mono">
                  <span>// SOURCE: spot-market-engine v2.6 · 实时演算</span>
                  <span>SYS: 容量 {formatNumber(params.capacityMWh)} MWh · 时长 {params.systemDuration} h · 综合效率 {(params.efficiency*100).toFixed(1)}% · DOD {(params.dodDepth*100).toFixed(1)}%</span>
                </div>
              </section>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <div className="lg:col-span-5 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                  <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                    <Zap size={16} className="text-blue-600" />
                    <h3 className="font-semibold text-gray-800">现货套利参数</h3>
                  </div>
                  <div className="p-4">
                    <div className="grid grid-cols-2 gap-4">
                      <InputField label="日循环次数" unit="次" value={params.cyclesPerDay} onChange={(v:any)=>setParams({...params, cyclesPerDay:v})} />
                      <InputField label="年运行天数" unit="天" value={params.runDays} onChange={(v:any)=>setParams({...params, runDays:v})} />
                    </div>
                    <InputField label="现货净价差" unit="元/kWh" step={0.0001} value={params.spotSpread} onChange={(v:any)=>setParams({...params, spotSpread:v})} tooltip="PDF基准: 0.4509" />
                    <InputField label="价差年增长率" unit="小数(0.02=2%)" step={0.001} value={params.spotSpreadGrowth} onChange={(v:any)=>setParams({...params, spotSpreadGrowth:v})} tooltip="按年复合增长，输入小数：0=持平，0.02 表示每年+2%。保守建议取 0" />
                    <div className="grid grid-cols-2 gap-4 bg-yellow-50 p-3 rounded-md border border-yellow-100">
                      <InputField label="市场不确定系数" unit="%" step={0.01} value={params.spotMarketUncertainty} onChange={(v:any)=>setParams({...params, spotMarketUncertainty:v})} tooltip="预测偏差修正 (默认0.9)" />
                      <InputField label="交易损耗系数" unit="%" step={0.01} value={params.tradingLossFactor} onChange={(v:any)=>setParams({...params, tradingLossFactor:v})} tooltip="调度/考核损耗 (默认0.95)" />
                    </div>
                    <div className="mt-3 bg-amber-50/70 p-3 rounded-md border border-amber-200">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-semibold text-amber-800">财务税务 · 销项增值税</span>
                        <span className="text-[10px] font-mono text-amber-700/80">VAT · 还原销售额</span>
                      </div>
                      <InputField label="增值税率" unit="小数(0.13=13%)" step={0.01} value={params.vatRate} onChange={(v:any)=>setParams({...params, vatRate:v})} tooltip="电力销售一般纳税人销项税率，默认 13%。税后(不含税)现货收入 = 含税现货收入 ÷ (1 + 增值税率)" />
                      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                        <div className="rounded bg-white/70 border border-amber-100 px-2 py-1.5">
                          <p className="text-gray-500">含税现货收入</p>
                          <p className="font-mono font-bold text-gray-800">{formatNumber(results.yearlyData[0].breakdown.spot)}<span className="text-[10px] text-gray-400 ml-0.5">万元</span></p>
                        </div>
                        <div className="rounded bg-white/70 border border-amber-100 px-2 py-1.5">
                          <p className="text-gray-500">销项税额</p>
                          <p className="font-mono font-bold text-amber-700">{formatNumber(results.yearlyData[0].breakdown.spotVatOutput)}<span className="text-[10px] text-gray-400 ml-0.5">万元</span></p>
                        </div>
                        <div className="rounded bg-emerald-50 border border-emerald-200 px-2 py-1.5">
                          <p className="text-emerald-700/80">税后现货收入</p>
                          <p className="font-mono font-bold text-emerald-700">{formatNumber(results.yearlyData[0].breakdown.spotAfterTax)}<span className="text-[10px] text-emerald-600 ml-0.5">万元</span></p>
                        </div>
                      </div>
                      <p className="mt-2 text-[10px] text-amber-800/70 leading-relaxed">勾稽：含税 = 税后 × (1 + 税率)；销项税 = 含税 − 税后 = 含税 × 税率 ÷ (1 + 税率)。</p>
                    </div>

                    {/* 功率分配联动展示 —— 深绿高亮风格 */}
                    <div className="mt-3 relative overflow-hidden rounded-xl border-2 border-emerald-400/60 ring-2 ring-emerald-300/30 ring-offset-2 ring-offset-white p-4 shadow-[0_8px_30px_rgba(5,150,105,0.35)] bg-[#0a3d33]">
                      <div className="pointer-events-none absolute inset-0 opacity-90">
                        <div className="absolute -left-10 -top-10 h-32 w-32 rounded-full bg-emerald-400/20 blur-3xl animate-pulse"></div>
                        <div className="absolute -right-12 -bottom-12 h-36 w-36 rounded-full bg-teal-300/15 blur-3xl animate-pulse [animation-delay:1.2s]"></div>
                      </div>
                      <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-transparent via-emerald-400 to-transparent opacity-90"></div>
                      <div className="relative">
                        <div className="flex items-center gap-1.5 mb-3">
                          <span className="relative flex h-2 w-2">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70"></span>
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.9)]"></span>
                          </span>
                          <span className="uppercase text-[10px] tracking-[0.22em] text-emerald-300/90">LINKED</span>
                          <span className="text-xs font-bold text-white">功率分配联动</span>
                        </div>
                        <div className="grid grid-cols-3 gap-3">
                          <div className="rounded-md border border-emerald-300/30 bg-emerald-900/40 px-3 py-2">
                            <p className="text-[11px] text-emerald-200/80">装机功率</p>
                            <p className="mt-0.5 text-base font-bold text-white font-mono">{formatNumber(params.capacityMW)} <span className="text-xs text-emerald-200/70">MW</span></p>
                          </div>
                          <div className="rounded-md border border-emerald-300/30 bg-emerald-900/40 px-3 py-2">
                            <p className="text-[11px] text-emerald-200/80">参与现货比例</p>
                            <p className="mt-0.5 text-base font-bold text-white font-mono">{(params.spotRatio * 100).toFixed(1)}<span className="text-xs text-emerald-200/70">%</span></p>
                          </div>
                          <div className="rounded-md border-2 border-emerald-300/70 bg-emerald-500/15 px-3 py-2 shadow-[0_0_18px_rgba(16,185,129,0.35)]">
                            <p className="text-[11px] text-emerald-200">参与现货容量</p>
                            <p className="mt-0.5 text-base font-extrabold text-white font-mono drop-shadow-[0_0_6px_rgba(110,231,183,0.6)]">{formatNumber(params.capacityMW * params.spotRatio)} <span className="text-xs text-emerald-100">MW</span></p>
                          </div>
                        </div>
                        <p className="text-[11px] text-emerald-200/80 mt-2">参与现货容量 = 装机功率 × 参与现货比例。如需修改比例，请在「基础数据」中调整。</p>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="lg:col-span-7 space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                      <p className="text-xs text-gray-500">理论年放电量</p>
                      <p className="text-xl font-bold text-gray-900 mt-1">{formatNumber(annualDischargeMWh)} <span className="text-sm font-normal text-gray-500">MWh</span></p>
                      <p className="text-xs text-gray-400 mt-1">≈ {formatNumber(annualDischargeMWh / 10)} 万kWh</p>
                    </div>
                    <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                      <p className="text-xs text-gray-500">首年现货收入（税后 · 不含税）</p>
                      <p className="text-xl font-bold text-emerald-600 mt-1">{formatNumber(results.yearlyData[0].breakdown.spotAfterTax)} <span className="text-sm font-normal text-gray-500">万元</span></p>
                      <p className="text-xs text-gray-400 mt-1">含税 {formatNumber(results.yearlyData[0].breakdown.spot)} 万元 · 税率 {(params.vatRate*100).toFixed(1)}%</p>
                    </div>
                  </div>
                  <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                    <h3 className="text-sm font-bold text-gray-800 mb-3">逐年现货收入 (含衰减)</h3>
                    <div className="h-[220px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={results.yearlyData}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                          <XAxis dataKey="year" tickLine={false} axisLine={false} tick={{fontSize: 12}} />
                          <YAxis tickLine={false} axisLine={false} tick={{fontSize: 12}} label={{ value: '万元', angle: -90, position: 'insideLeft', style: {fill: '#999'} }} />
                          <RechartsTooltip formatter={(v: number) => formatNumber(v) + ' 万元'} />
                          <Bar dataKey="breakdown.spot" fill="#3b82f6" radius={[4,4,0,0]} name="现货套利" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-900 flex gap-2">
                    <Info size={16} className="mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium mb-1">计算口径：</p>
                      <p>现货收入 = 装机容量(衰减后) × 日循环次数 × 年运行天数 × 综合效率 × 净价差 × 市场不确定系数 × 交易损耗系数。</p>
                    </div>
                  </div>
                </div>
              </div>

              </div>
            )}

            {/* ==================== 3. 调频收益 ==================== */}
            {activeSection === 'frequency' && (() => {
              // —— 派生量（与基础数据 / 功率分配 联动）——
              const frClearedMW = params.capacityMW * params.frRatio;
              const kCombined = Math.min(Math.max(params.frK1 * params.frK2 * params.frK3, 0), 2);
              const hourlyMileageMWMin = frClearedMW * params.frMileagePerMWPerHour;
              const hourlyCapacityYuan = frClearedMW * params.frCapacityPriceYuanPerMWh;
              const hourlyMileageYuan = hourlyMileageMWMin * params.frMileagePriceYuanPerMWMin * kCombined;
              const hourlyTotalYuan = hourlyCapacityYuan + hourlyMileageYuan;
              const annualCapacityWan = (hourlyCapacityYuan * params.frAnnualHours) / 10000;
              const annualMileageWan = (hourlyMileageYuan * params.frAnnualHours) / 10000;
              const annualTotalWan = annualCapacityWan + annualMileageWan;
              const hCapShare = hourlyTotalYuan > 0 ? (hourlyCapacityYuan / hourlyTotalYuan) * 100 : 0;
              const hMilShare = hourlyTotalYuan > 0 ? (hourlyMileageYuan / hourlyTotalYuan) * 100 : 0;
              const aCapShare = annualTotalWan > 0 ? (annualCapacityWan / annualTotalWan) * 100 : 0;
              const aMilShare = annualTotalWan > 0 ? (annualMileageWan / annualTotalWan) * 100 : 0;
              const annualPerMW = params.capacityMW > 0 ? annualTotalWan / params.capacityMW : 0;
              const annualPerMWh = params.capacityMWh > 0 ? annualTotalWan / params.capacityMWh : 0;
              const fmtYuan = (v: number) => {
                if (!Number.isFinite(v)) return '-';
                const abs = Math.abs(v);
                const fd = abs >= 100000 ? 0 : abs >= 10000 ? 1 : 2;
                return v.toLocaleString('zh-CN', { minimumFractionDigits: fd, maximumFractionDigits: fd });
              };
              const fmtWan = (v: number) => Number.isFinite(v) ? v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-';
              return (
              <div className="space-y-5">
              {/* —— 数据实时展示舱 // 辅助服务 | 调频（科技绿 · 海报风） —— */}
              <section className="relative overflow-hidden rounded-[28px] border border-emerald-400/15 bg-[linear-gradient(135deg,_#03140d_0%,_#062b1f_45%,_#03140d_100%)] p-6 md:p-10 shadow-[0_24px_80px_rgba(5,46,33,0.45)]">
                <div className="pointer-events-none absolute inset-0 opacity-60">
                  <div className="absolute -left-20 top-10 h-64 w-64 rounded-full bg-emerald-400/15 blur-[100px]"></div>
                  <div className="absolute right-0 bottom-0 h-72 w-72 rounded-full bg-teal-300/10 blur-[120px]"></div>
                  <div className="absolute inset-0 bg-[linear-gradient(rgba(16,185,129,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(16,185,129,0.06)_1px,transparent_1px)] bg-[size:48px_48px]"></div>
                  <div className="absolute inset-x-10 top-24 h-px bg-gradient-to-r from-transparent via-emerald-300/40 to-transparent"></div>
                </div>

                <div className="relative flex flex-col gap-3 md:flex-row md:items-end md:justify-between mb-8">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-emerald-300/80">REAL-TIME DATA HUB</p>
                    <h3 className="mt-2 text-2xl md:text-3xl font-bold text-white tracking-wide">数据实时展示舱 <span className="text-emerald-300">// 辅助服务 | 调频</span></h3>
                    <p className="mt-2 max-w-xl text-sm text-emerald-100/70">基于当前参数实时演算的调频核心运行指标，可直接作为路演 / 海报展示。</p>
                  </div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/30 bg-emerald-400/10 px-4 py-2 text-xs text-emerald-100 backdrop-blur-sm">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-70"></span>
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.9)]"></span>
                    </span>
                    LIVE · {new Date().toLocaleTimeString('zh-CN', { hour12: false })}
                  </div>
                </div>

                <div className="relative grid grid-cols-2 lg:grid-cols-4 gap-5">
                  {[
                    {
                      key: 'fr-cleared',
                      label: '参与调频容量',
                      sub: 'FR Cleared Capacity',
                      value: formatNumber(frClearedMW),
                      unit: 'MW',
                      hint: `装机 ${formatNumber(params.capacityMW)} MW × ${(params.frRatio*100).toFixed(1)}%`,
                    },
                    {
                      key: 'fr-annual',
                      label: '基准年调频收益',
                      sub: 'Annual FR Revenue',
                      value: fmtWan(annualTotalWan),
                      unit: '万元',
                      hint: `容量补偿 + 里程补偿（K=${kCombined.toFixed(2)}）`,
                    },
                    {
                      key: 'fr-firstyear',
                      label: '首年调频收益',
                      sub: 'First-Year FR Revenue',
                      value: formatNumber(results.yearlyData[0]?.breakdown.aux ?? 0),
                      unit: '万元',
                      hint: `占总收入 ${results.yearlyData[0] && results.yearlyData[0].revenue > 0 ? ((results.yearlyData[0].breakdown.aux / results.yearlyData[0].revenue)*100).toFixed(1) : '0.0'}%`,
                    },
                    {
                      key: 'fr-hours',
                      label: '年等效调频小时',
                      sub: 'Annual FR Hours',
                      value: formatNumber(params.frAnnualHours),
                      unit: 'h/年',
                      hint: `单小时合计 ${fmtYuan(hourlyTotalYuan)} 元`,
                    },
                  ].map((it, idx) => (
                    <div
                      key={it.key}
                      className="group relative overflow-hidden rounded-2xl border border-emerald-300/15 bg-[linear-gradient(160deg,rgba(6,78,59,0.55)_0%,rgba(2,20,14,0.85)_100%)] p-5 backdrop-blur-md transition-all duration-300 hover:-translate-y-1 hover:border-emerald-300/40 hover:shadow-[0_18px_60px_rgba(16,185,129,0.25)]"
                    >
                      <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-emerald-300 to-transparent opacity-70"></div>
                      <div className="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-emerald-400/10 blur-2xl transition-opacity duration-300 group-hover:opacity-80"></div>
                      <div className="absolute right-3 top-3 font-mono text-[10px] tracking-widest text-emerald-300/60">0{idx + 1}</div>

                      <p className="text-[11px] uppercase tracking-[0.22em] text-emerald-300/70">{it.sub}</p>
                      <p className="mt-1 text-sm font-medium text-emerald-50">{it.label}</p>

                      <div className="mt-5 flex items-baseline gap-2">
                        <span className="text-[2.4rem] font-bold leading-none tracking-tight bg-gradient-to-br from-white via-emerald-100 to-emerald-300 bg-clip-text text-transparent">
                          {it.value}
                        </span>
                        <span className="text-xs text-emerald-200/70">{it.unit}</span>
                      </div>

                      <div className="mt-5 flex items-center justify-between text-[11px] text-emerald-200/60">
                        <span className="font-mono">{it.hint}</span>
                        <span className="inline-flex items-center gap-1 text-emerald-300">
                          <span className="h-1 w-1 rounded-full bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.9)]"></span>
                          ONLINE
                        </span>
                      </div>

                      <div className="mt-4 h-1 rounded-full bg-emerald-900/40 overflow-hidden">
                        <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-emerald-400 via-teal-300 to-emerald-200 group-hover:w-full transition-all duration-700"></div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="relative mt-6 flex flex-wrap items-center justify-between gap-3 text-[11px] text-emerald-200/50 font-mono">
                  <span>// SOURCE: ancillary-service-engine v1.0 · 实时演算</span>
                  <span>SYS: 装机 {formatNumber(params.capacityMW)} MW · 调频比例 {(params.frRatio*100).toFixed(1)}% · 容量价 {params.frCapacityPriceYuanPerMWh} 元/MW·h · 里程价 {params.frMileagePriceYuanPerMWMin} 元/MW·min</span>
                </div>
              </section>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                {/* 输入区 */}
                <div className="lg:col-span-5 space-y-4">
                  <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                    <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                      <Gauge size={16} className="text-orange-600" />
                      <h3 className="font-semibold text-gray-800">调频(辅助服务)参数</h3>
                    </div>
                    <div className="p-4 space-y-3">
                      {/* 功率分配联动展示 —— 深绿高亮风格 */}
                      <div className="relative overflow-hidden rounded-xl border-2 border-emerald-400/60 ring-2 ring-emerald-300/30 ring-offset-2 ring-offset-white p-4 shadow-[0_8px_30px_rgba(5,150,105,0.35)] bg-[#0a3d33]">
                        <div className="pointer-events-none absolute inset-0 opacity-90">
                          <div className="absolute -left-10 -top-10 h-32 w-32 rounded-full bg-emerald-400/20 blur-3xl animate-pulse"></div>
                          <div className="absolute -right-12 -bottom-12 h-36 w-36 rounded-full bg-teal-300/15 blur-3xl animate-pulse [animation-delay:1.2s]"></div>
                        </div>
                        <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-transparent via-emerald-400 to-transparent opacity-90"></div>
                        <div className="relative">
                          <div className="flex items-center gap-1.5 mb-3">
                            <span className="relative flex h-2 w-2">
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70"></span>
                              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.9)]"></span>
                            </span>
                            <span className="uppercase text-[10px] tracking-[0.22em] text-emerald-300/90">LINKED</span>
                            <span className="text-xs font-bold text-white">功率分配联动</span>
                          </div>
                          <div className="grid grid-cols-3 gap-3">
                            <div className="rounded-md border border-emerald-300/30 bg-emerald-900/40 px-3 py-2">
                              <p className="text-[11px] text-emerald-200/80">装机功率</p>
                              <p className="mt-0.5 text-base font-bold text-white font-mono">{formatNumber(params.capacityMW)} <span className="text-xs text-emerald-200/70">MW</span></p>
                            </div>
                            <div className="rounded-md border border-emerald-300/30 bg-emerald-900/40 px-3 py-2">
                              <p className="text-[11px] text-emerald-200/80">调频比例</p>
                              <p className="mt-0.5 text-base font-bold text-white font-mono">{(params.frRatio * 100).toFixed(1)}<span className="text-xs text-emerald-200/70">%</span></p>
                            </div>
                            <div className="rounded-md border-2 border-emerald-300/70 bg-emerald-500/15 px-3 py-2 shadow-[0_0_18px_rgba(16,185,129,0.35)]">
                              <p className="text-[11px] text-emerald-200">参与调频容量</p>
                              <p className="mt-0.5 text-base font-extrabold text-white font-mono drop-shadow-[0_0_6px_rgba(110,231,183,0.6)]">{formatNumber(frClearedMW)} <span className="text-xs text-emerald-100">MW</span></p>
                            </div>
                          </div>
                          <p className="text-[11px] text-emerald-200/80 mt-2">参与调频容量 = 装机功率 × 调频比例。如需修改比例，请在「基础数据」中调整。</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <InputField label="容量补偿单价" unit="元/MW·h" step={0.1} value={params.frCapacityPriceYuanPerMWh} onChange={(v:number)=>setParams({...params, frCapacityPriceYuanPerMWh:v})} tooltip="广东调频结算容量补偿单价" />
                        <InputField label="里程出清价" unit="元/MW·min" step={0.01} value={params.frMileagePriceYuanPerMWMin} onChange={(v:number)=>setParams({...params, frMileagePriceYuanPerMWMin:v})} tooltip="调频里程市场出清价" />
                      </div>
                      <InputField label="单位容量·小时调频里程" unit="MW·min/(MW·h)" step={1} value={params.frMileagePerMWPerHour} onChange={(v:number)=>setParams({...params, frMileagePerMWPerHour:v})} tooltip="每 1MW 中标容量在 1 小时内可累积的有效调频里程，例如平均调节强度 50% × 60min ≈ 30" />

                      <div className="grid grid-cols-3 gap-3">
                        <InputField label="K1 速率" unit="0~2" step={0.05} value={params.frK1} onChange={(v:number)=>setParams({...params, frK1:v})} />
                        <InputField label="K2 响应" unit="0~1" step={0.05} value={params.frK2} onChange={(v:number)=>setParams({...params, frK2:v})} />
                        <InputField label="K3 精度" unit="0~1" step={0.05} value={params.frK3} onChange={(v:number)=>setParams({...params, frK3:v})} />
                      </div>
                      <p className="text-xs text-emerald-700">综合 K 值（截断 0–2）：<span className="font-semibold">{kCombined.toFixed(2)}</span></p>

                      <InputField label="年等效调频小时数" unit="h/年" step={50} value={params.frAnnualHours} onChange={(v:number)=>setParams({...params, frAnnualHours:v})} tooltip="结合机组实际中标小时数估算，例如 3000–5000 h/年" />

                      <div className="bg-yellow-50 border border-yellow-100 rounded-md p-3 text-xs text-yellow-900">
                        调频收益受 AGC 调用频次、性能折算系数（K1/K2/K3）、中标容量及里程价影响较大，
                        本工具按"容量补偿 + 里程补偿"静态测算，未含偏差考核与上下调分价；
                        与基础数据中"装机功率 / 调频比例 / 年衰减率"联动，逐年收入随 SOH 折算。
                      </div>
                    </div>
                  </div>
                </div>

                {/* 结果区 */}
                <div className="lg:col-span-7 space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                      <p className="text-xs text-gray-500">首年调频收入</p>
                      <p className="text-xl font-bold text-orange-600 mt-1">{formatNumber(results.yearlyData[0]?.breakdown.aux ?? 0)} <span className="text-sm font-normal text-gray-500">万元</span></p>
                      <p className="text-xs text-gray-400 mt-1">占总收入 {results.yearlyData[0] && results.yearlyData[0].revenue > 0 ? ((results.yearlyData[0].breakdown.aux / results.yearlyData[0].revenue)*100).toFixed(1) : '0.0'}%</p>
                    </div>
                    <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                      <p className="text-xs text-gray-500">基准年调频收入（未衰减）</p>
                      <p className="text-xl font-bold text-gray-900 mt-1">{fmtWan(annualTotalWan)} <span className="text-sm font-normal text-gray-500">万元</span></p>
                      <p className="text-xs text-gray-400 mt-1">容量+里程 合计</p>
                    </div>
                    <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                      <p className="text-xs text-gray-500">全周期调频累计</p>
                      <p className="text-xl font-bold text-gray-900 mt-1">{formatNumber(results.yearlyData.reduce((a,b)=>a+b.breakdown.aux,0))} <span className="text-sm font-normal text-gray-500">万元</span></p>
                    </div>
                  </div>

                  {/* 单小时收益结构 */}
                  <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                    <h3 className="text-sm font-bold text-gray-800 mb-3">单小时收益结构（元 / h）</h3>
                    <div className="overflow-hidden rounded-lg border border-gray-200">
                      <table className="min-w-full text-left text-xs text-gray-900">
                        <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
                          <tr>
                            <th className="px-3 py-2">项目</th>
                            <th className="px-3 py-2">公式</th>
                            <th className="px-3 py-2 text-right">金额（元/h）</th>
                            <th className="px-3 py-2 text-right">占比</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-t border-gray-200 bg-white">
                            <td className="px-3 py-2 text-emerald-700">容量补偿</td>
                            <td className="px-3 py-2 text-[11px] text-gray-500">中标容量 × 容量单价</td>
                            <td className="px-3 py-2 text-right font-mono">{fmtYuan(hourlyCapacityYuan)}</td>
                            <td className="px-3 py-2 text-right text-gray-500">{hCapShare.toFixed(1)}%</td>
                          </tr>
                          <tr className="border-t border-gray-200 bg-gray-50">
                            <td className="px-3 py-2 text-sky-700">里程补偿（调频）</td>
                            <td className="px-3 py-2 text-[11px] text-gray-500">里程 × 里程价 × K</td>
                            <td className="px-3 py-2 text-right font-mono">{fmtYuan(hourlyMileageYuan)}</td>
                            <td className="px-3 py-2 text-right text-gray-500">{hMilShare.toFixed(1)}%</td>
                          </tr>
                          <tr className="border-t border-gray-300 bg-gray-100">
                            <td className="px-3 py-2 font-semibold text-gray-900">小计</td>
                            <td className="px-3 py-2 text-[11px] text-gray-500">容量补偿 + 里程补偿</td>
                            <td className="px-3 py-2 text-right font-mono font-semibold text-orange-700">{fmtYuan(hourlyTotalYuan)}</td>
                            <td className="px-3 py-2 text-right text-gray-500">{hourlyTotalYuan > 0 ? '100.0%' : '-'}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="text-[11px] text-gray-500 mt-2">当前小时有效调频里程 ≈ {formatNumber(hourlyMileageMWMin)} MW·min（= 中标容量 × 单位里程系数）</p>
                  </div>

                  {/* 年度收益结构 */}
                  <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                    <h3 className="text-sm font-bold text-gray-800 mb-3">年度收益结构（万元 / 年，按年等效小时 {params.frAnnualHours.toLocaleString('zh-CN')} h 放大）</h3>
                    <div className="overflow-hidden rounded-lg border border-gray-200">
                      <table className="min-w-full text-left text-xs text-gray-900">
                        <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
                          <tr>
                            <th className="px-3 py-2">项目</th>
                            <th className="px-3 py-2">公式</th>
                            <th className="px-3 py-2 text-right">金额（万元/年）</th>
                            <th className="px-3 py-2 text-right">占比</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-t border-gray-200 bg-white">
                            <td className="px-3 py-2 text-emerald-700">容量补偿</td>
                            <td className="px-3 py-2 text-[11px] text-gray-500">小时容量补偿 × 年等效小时</td>
                            <td className="px-3 py-2 text-right font-mono">{fmtWan(annualCapacityWan)}</td>
                            <td className="px-3 py-2 text-right text-gray-500">{aCapShare.toFixed(1)}%</td>
                          </tr>
                          <tr className="border-t border-gray-200 bg-gray-50">
                            <td className="px-3 py-2 text-sky-700">里程补偿（调频）</td>
                            <td className="px-3 py-2 text-[11px] text-gray-500">小时里程补偿 × 年等效小时</td>
                            <td className="px-3 py-2 text-right font-mono">{fmtWan(annualMileageWan)}</td>
                            <td className="px-3 py-2 text-right text-gray-500">{aMilShare.toFixed(1)}%</td>
                          </tr>
                          <tr className="border-t border-gray-300 bg-gray-100">
                            <td className="px-3 py-2 font-semibold text-gray-900">基准年合计</td>
                            <td className="px-3 py-2 text-[11px] text-gray-500">年容量补偿 + 年里程补偿</td>
                            <td className="px-3 py-2 text-right font-mono font-semibold text-orange-700">{fmtWan(annualTotalWan)}</td>
                            <td className="px-3 py-2 text-right text-gray-500">{annualTotalWan > 0 ? '100.0%' : '-'}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                        <p className="text-[11px] text-gray-500">单位功率收益</p>
                        <p className="mt-1 text-lg font-semibold text-orange-700">{fmtWan(annualPerMW)} <span className="text-xs text-gray-600">万元 / MW·年</span></p>
                      </div>
                      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                        <p className="text-[11px] text-gray-500">单位电量收益</p>
                        <p className="mt-1 text-lg font-semibold text-orange-700">{fmtWan(annualPerMWh)} <span className="text-xs text-gray-600">万元 / MWh·年</span></p>
                      </div>
                    </div>
                  </div>

                  {/* 逐年柱状图（含衰减） */}
                  <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                    <h3 className="text-sm font-bold text-gray-800 mb-3">逐年调频收入（含 SOH 衰减折算）</h3>
                    <div className="h-[220px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={results.yearlyData}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                          <XAxis dataKey="year" tickLine={false} axisLine={false} tick={{fontSize: 12}} />
                          <YAxis tickLine={false} axisLine={false} tick={{fontSize: 12}} label={{ value: '万元', angle: -90, position: 'insideLeft', style: {fill: '#999'} }} />
                          <RechartsTooltip formatter={(v: number) => formatNumber(v) + ' 万元'} />
                          <Bar dataKey="breakdown.aux" fill="#f97316" radius={[4,4,0,0]} name="调频收益" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-800">
                    <p className="font-semibold">勾稽关系说明</p>
                    <p className="mt-1">调频收益的中标容量来自「基础数据 → 装机功率 × 调频比例」；逐年收入按全生命周期 SOH 自动折算；与现货板块共用同一套装机功率、效率、衰减参数，避免重复计列。</p>
                  </div>
                </div>
              </div>
              </div>
              );
            })()}

            {/* ==================== 调峰收益（江苏迎峰期模型 · 按月分解） ==================== */}
            {activeSection === 'peakshaving' && (() => {
              const peakClearedMW = params.capacityMW * params.peakRatio;
              const peakRatedMWh = params.capacityMWh * params.peakRatio;
              const monthlyRows = peakshavingMonthly;
              const totalProfit = monthlyRows.reduce((s, r) => s + r.profit, 0);
              const profitSummer = monthlyRows.filter(r => r.isSummer).reduce((s, r) => s + r.profit, 0);
              const profitNonSummer = monthlyRows.filter(r => !r.isSummer).reduce((s, r) => s + r.profit, 0);
              const incomeDischargeTotal = monthlyRows.reduce((s, r) => s + r.incomeDischarge, 0);
              const incomeSubsidyTotal = monthlyRows.reduce((s, r) => s + r.incomeSubsidy, 0);
              const costChargeTotal = monthlyRows.reduce((s, r) => s + r.costCharge, 0);
              const dischargeMWhTotal = monthlyRows.reduce((s, r) => s + r.dischargeMWh, 0);
              const chargeMWhTotal = monthlyRows.reduce((s, r) => s + r.chargeMWh, 0);
              const firstYearPeak = results.yearlyData[0]?.breakdown.peak ?? 0;
              const lifetimePeak = results.yearlyData.reduce((a, b) => a + b.breakdown.peak, 0);
              const toWan = (v: number) => (v / 10000).toFixed(2);
              const handleMonthChargeChange = (month: number, price: number) => {
                setParams(p => ({
                  ...p,
                  pkMonthlyChargeOverrides: { ...p.pkMonthlyChargeOverrides, [month]: price },
                }));
              };
              const exportPeakCsv = () => {
                const header = ['month','days','isPeak','dischargeMWh','chargeMWh','incomeDischarge(元)','incomeSubsidy(元)','costCharge(元)','profit(元)','chargePrice(元/kWh)'];
                const lines = monthlyRows.map(r => [
                  r.month, r.days, r.isSummer ? 'P' : 'N',
                  r.dischargeMWh.toFixed(3), r.chargeMWh.toFixed(3),
                  r.incomeDischarge.toFixed(2), r.incomeSubsidy.toFixed(2),
                  r.costCharge.toFixed(2), r.profit.toFixed(2), r.chargePrice.toFixed(4),
                ].join(','));
                const csv = [header.join(','), ...lines].join('\n');
                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = '调峰收益_按月分解.csv';
                a.click(); URL.revokeObjectURL(url);
              };
              return (
              <div className="space-y-5">
                {/* —— 数据实时展示舱 // 调峰收益 —— */}
                <section className="relative overflow-hidden rounded-[28px] border border-emerald-400/15 bg-[linear-gradient(135deg,_#03140d_0%,_#062b1f_45%,_#03140d_100%)] p-6 md:p-10 shadow-[0_24px_80px_rgba(5,46,33,0.45)]">
                  <div className="pointer-events-none absolute inset-0 opacity-60">
                    <div className="absolute -left-20 top-10 h-64 w-64 rounded-full bg-emerald-400/15 blur-[100px]"></div>
                    <div className="absolute right-0 bottom-0 h-72 w-72 rounded-full bg-teal-300/10 blur-[120px]"></div>
                    <div className="absolute inset-0 bg-[linear-gradient(rgba(16,185,129,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(16,185,129,0.06)_1px,transparent_1px)] bg-[size:48px_48px]"></div>
                    <div className="absolute inset-x-10 top-24 h-px bg-gradient-to-r from-transparent via-emerald-300/40 to-transparent"></div>
                  </div>
                  <div className="relative flex flex-col gap-3 md:flex-row md:items-end md:justify-between mb-8">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-emerald-300/80">REAL-TIME DATA HUB</p>
                      <h3 className="mt-2 text-2xl md:text-3xl font-bold text-white tracking-wide">数据实时展示舱 <span className="text-emerald-300">// 调峰收益（江苏 · 迎峰期）</span></h3>
                      <p className="mt-2 max-w-xl text-sm text-emerald-100/70">基于江苏省独立储能政策（1、6、7、12 月迎峰期享顶峰补贴 + 0 充电电费），按月分解实时演算。</p>
                    </div>
                    <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/30 bg-emerald-400/10 px-4 py-2 text-xs text-emerald-100 backdrop-blur-sm">
                      <span className="relative flex h-2 w-2">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-70"></span>
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.9)]"></span>
                      </span>
                      LIVE · {new Date().toLocaleTimeString('zh-CN', { hour12: false })}
                    </div>
                  </div>
                  <div className="relative grid grid-cols-2 lg:grid-cols-4 gap-5">
                    {[
                      { key: 'pk-cap', label: '参与调峰功率', sub: 'Peak-Shaving Capacity', value: formatNumber(peakClearedMW), unit: 'MW', hint: `装机 ${formatNumber(params.capacityMW)} MW × ${(params.peakRatio*100).toFixed(1)}%` },
                      { key: 'pk-energy', label: '参与调峰容量', sub: 'Peak-Shaving Energy', value: formatNumber(peakRatedMWh), unit: 'MWh', hint: `装机容量 × 调峰比例` },
                      { key: 'pk-base', label: '基准年净收益', sub: 'Annual Net Profit', value: toWan(totalProfit), unit: '万元', hint: `迎峰 ${toWan(profitSummer)} / 非迎峰 ${toWan(profitNonSummer)}` },
                      { key: 'pk-firstyear', label: '首年调峰收益', sub: 'First-Year Revenue', value: formatNumber(firstYearPeak), unit: '万元', hint: `占总收入 ${results.yearlyData[0] && results.yearlyData[0].revenue > 0 ? ((firstYearPeak / results.yearlyData[0].revenue)*100).toFixed(1) : '0.0'}%` },
                    ].map((it, idx) => (
                      <div key={it.key} className="group relative overflow-hidden rounded-2xl border border-emerald-300/15 bg-[linear-gradient(160deg,rgba(6,78,59,0.55)_0%,rgba(2,20,14,0.85)_100%)] p-5 backdrop-blur-md transition-all duration-300 hover:-translate-y-1 hover:border-emerald-300/40 hover:shadow-[0_18px_60px_rgba(16,185,129,0.25)]">
                        <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-emerald-300 to-transparent opacity-70"></div>
                        <div className="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-emerald-400/10 blur-2xl transition-opacity duration-300 group-hover:opacity-80"></div>
                        <div className="absolute right-3 top-3 font-mono text-[10px] tracking-widest text-emerald-300/60">0{idx + 1}</div>
                        <p className="text-[11px] uppercase tracking-[0.22em] text-emerald-300/70">{it.sub}</p>
                        <p className="mt-1 text-sm font-medium text-emerald-50">{it.label}</p>
                        <div className="mt-5 flex items-baseline gap-2">
                          <span className="text-[2.4rem] font-bold leading-none tracking-tight bg-gradient-to-br from-white via-emerald-100 to-emerald-300 bg-clip-text text-transparent">{it.value}</span>
                          <span className="text-xs text-emerald-200/70">{it.unit}</span>
                        </div>
                        <div className="mt-5 flex items-center justify-between text-[11px] text-emerald-200/60">
                          <span className="font-mono">{it.hint}</span>
                          <span className="inline-flex items-center gap-1 text-emerald-300">
                            <span className="h-1 w-1 rounded-full bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.9)]"></span>
                            ONLINE
                          </span>
                        </div>
                        <div className="mt-4 h-1 rounded-full bg-emerald-900/40 overflow-hidden">
                          <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-emerald-400 via-teal-300 to-emerald-200 group-hover:w-full transition-all duration-700"></div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="relative mt-6 flex flex-wrap items-center justify-between gap-3 text-[11px] text-emerald-200/50 font-mono">
                    <span>// SOURCE: peak-shaving-engine v1.0 · 江苏迎峰期模型 · 实时演算</span>
                    <span>SYS: 调峰功率 {formatNumber(peakClearedMW)} MW · 调峰容量 {formatNumber(peakRatedMWh)} MWh · 全周期累计 {formatNumber(lifetimePeak)} 万元</span>
                  </div>
                </section>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                  {/* 输入区 */}
                  <div className="lg:col-span-5 space-y-4">
                    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                      <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                        <Activity size={16} className="text-rose-600" />
                        <h3 className="font-semibold text-gray-800">调峰参数（江苏迎峰期模型）</h3>
                      </div>
                      <div className="p-4 space-y-3">
                        {/* 功率分配联动展示 —— 深绿高亮风格 */}
                        <div className="relative overflow-hidden rounded-xl border-2 border-emerald-400/60 ring-2 ring-emerald-300/30 ring-offset-2 ring-offset-white p-4 shadow-[0_8px_30px_rgba(5,150,105,0.35)] bg-[#0a3d33]">
                          <div className="pointer-events-none absolute inset-0 opacity-90">
                            <div className="absolute -left-10 -top-10 h-32 w-32 rounded-full bg-emerald-400/20 blur-3xl animate-pulse"></div>
                            <div className="absolute -right-12 -bottom-12 h-36 w-36 rounded-full bg-teal-300/15 blur-3xl animate-pulse [animation-delay:1.2s]"></div>
                          </div>
                          <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-transparent via-emerald-400 to-transparent opacity-90"></div>
                          <div className="relative">
                            <div className="flex items-center gap-1.5 mb-3">
                              <span className="relative flex h-2 w-2">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70"></span>
                                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.9)]"></span>
                              </span>
                              <span className="uppercase text-[10px] tracking-[0.22em] text-emerald-300/90">LINKED</span>
                              <span className="text-xs font-bold text-white">功率分配联动</span>
                            </div>
                            <div className="grid grid-cols-3 gap-3">
                              <div className="rounded-md border border-emerald-300/30 bg-emerald-900/40 px-3 py-2">
                                <p className="text-[11px] text-emerald-200/80">装机功率</p>
                                <p className="mt-0.5 text-base font-bold text-white font-mono">{formatNumber(params.capacityMW)} <span className="text-xs text-emerald-200/70">MW</span></p>
                              </div>
                              <div className="rounded-md border border-emerald-300/30 bg-emerald-900/40 px-3 py-2">
                                <p className="text-[11px] text-emerald-200/80">调峰比例</p>
                                <p className="mt-0.5 text-base font-bold text-white font-mono">{(params.peakRatio * 100).toFixed(1)}<span className="text-xs text-emerald-200/70">%</span></p>
                              </div>
                              <div className="rounded-md border-2 border-emerald-300/70 bg-emerald-500/15 px-3 py-2 shadow-[0_0_18px_rgba(16,185,129,0.35)]">
                                <p className="text-[11px] text-emerald-200">参与调峰容量</p>
                                <p className="mt-0.5 text-base font-extrabold text-white font-mono drop-shadow-[0_0_6px_rgba(110,231,183,0.6)]">{formatNumber(peakClearedMW)} <span className="text-xs text-emerald-100">MW</span></p>
                              </div>
                            </div>
                            <p className="text-[11px] text-emerald-200/80 mt-2">参与调峰容量 = 装机功率 × 调峰比例。如需修改比例，请在「基础数据」中调整。</p>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <InputField label="迎峰期日周转次数" unit="次/日" step={0.1} value={params.pkCyclesSummer} onChange={(v:number)=>setParams({...params, pkCyclesSummer:v})} tooltip="迎峰期（1、6、7、12 月）日均循环次数" />
                          <InputField label="非迎峰期日周转次数" unit="次/日" step={0.1} value={params.pkCyclesNonSummer} onChange={(v:number)=>setParams({...params, pkCyclesNonSummer:v})} tooltip="非迎峰期日均循环次数" />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <InputField label="迎峰期放电电价" unit="元/kWh" step={0.001} value={params.pkPriceDischargeSummer} onChange={(v:number)=>setParams({...params, pkPriceDischargeSummer:v})} />
                          <InputField label="非迎峰期放电电价" unit="元/kWh" step={0.001} value={params.pkPriceDischargeNonSummer} onChange={(v:number)=>setParams({...params, pkPriceDischargeNonSummer:v})} />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <InputField label="迎峰期顶峰补贴" unit="元/kWh" step={0.01} value={params.pkPriceSubsidySummer} onChange={(v:number)=>setParams({...params, pkPriceSubsidySummer:v})} tooltip="政策给予的迎峰期顶峰放电补贴" />
                          <InputField label="非迎峰期充电电价" unit="元/kWh" step={0.001} value={params.pkPriceChargeNonSummer} onChange={(v:number)=>setParams({...params, pkPriceChargeNonSummer:v})} tooltip="迎峰期默认充电电价 = 0；非迎峰期按本电价结算" />
                        </div>

                        <div className="bg-yellow-50 border border-yellow-100 rounded-md p-3 text-xs text-yellow-900">
                          说明：迎峰期（1、6、7、12 月）默认享受顶峰补贴且充电电价为 0；其余月份按非迎峰期参数结算。可在下方表格中按月覆盖单月充电电价。
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 结果区 */}
                  <div className="lg:col-span-7 space-y-3">
                    <div className="grid grid-cols-3 gap-3">
                      <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                        <p className="text-xs text-gray-500">基准年净收益</p>
                        <p className="text-xl font-bold text-rose-600 mt-1">{toWan(totalProfit)} <span className="text-sm font-normal text-gray-500">万元</span></p>
                        <p className="text-xs text-gray-400 mt-1">未含 SOH 衰减折算</p>
                      </div>
                      <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                        <p className="text-xs text-gray-500">首年调峰收益（含衰减）</p>
                        <p className="text-xl font-bold text-rose-600 mt-1">{formatNumber(firstYearPeak)} <span className="text-sm font-normal text-gray-500">万元</span></p>
                        <p className="text-xs text-gray-400 mt-1">占总收入 {results.yearlyData[0] && results.yearlyData[0].revenue > 0 ? ((firstYearPeak / results.yearlyData[0].revenue)*100).toFixed(1) : '0.0'}%</p>
                      </div>
                      <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                        <p className="text-xs text-gray-500">全周期调峰累计</p>
                        <p className="text-xl font-bold text-gray-900 mt-1">{formatNumber(lifetimePeak)} <span className="text-sm font-normal text-gray-500">万元</span></p>
                        <p className="text-xs text-gray-400 mt-1">{params.lifeSpan} 年合计（含衰减）</p>
                      </div>
                    </div>

                    {/* 迎峰期 vs 非迎峰期 概览 */}
                    <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                      <h3 className="text-sm font-bold text-gray-800 mb-3">基准年收益结构（万元）</h3>
                      <div className="overflow-hidden rounded-lg border border-gray-200">
                        <table className="min-w-full text-left text-xs text-gray-900">
                          <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
                            <tr>
                              <th className="px-3 py-2">项目</th>
                              <th className="px-3 py-2 text-right">放电量 (MWh)</th>
                              <th className="px-3 py-2 text-right">放电收入 (万元)</th>
                              <th className="px-3 py-2 text-right">顶峰补贴 (万元)</th>
                              <th className="px-3 py-2 text-right">充电成本 (万元)</th>
                              <th className="px-3 py-2 text-right">净收益 (万元)</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr className="border-t border-gray-200 bg-white">
                              <td className="px-3 py-2 text-rose-700">迎峰期 (1/6/7/12 月)</td>
                              <td className="px-3 py-2 text-right font-mono">{monthlyRows.filter(r=>r.isSummer).reduce((s,r)=>s+r.dischargeMWh,0).toFixed(2)}</td>
                              <td className="px-3 py-2 text-right font-mono">{toWan(monthlyRows.filter(r=>r.isSummer).reduce((s,r)=>s+r.incomeDischarge,0))}</td>
                              <td className="px-3 py-2 text-right font-mono">{toWan(monthlyRows.filter(r=>r.isSummer).reduce((s,r)=>s+r.incomeSubsidy,0))}</td>
                              <td className="px-3 py-2 text-right font-mono">{toWan(monthlyRows.filter(r=>r.isSummer).reduce((s,r)=>s+r.costCharge,0))}</td>
                              <td className="px-3 py-2 text-right font-mono font-semibold text-rose-700">{toWan(profitSummer)}</td>
                            </tr>
                            <tr className="border-t border-gray-200 bg-gray-50">
                              <td className="px-3 py-2 text-sky-700">非迎峰期</td>
                              <td className="px-3 py-2 text-right font-mono">{monthlyRows.filter(r=>!r.isSummer).reduce((s,r)=>s+r.dischargeMWh,0).toFixed(2)}</td>
                              <td className="px-3 py-2 text-right font-mono">{toWan(monthlyRows.filter(r=>!r.isSummer).reduce((s,r)=>s+r.incomeDischarge,0))}</td>
                              <td className="px-3 py-2 text-right font-mono">{toWan(monthlyRows.filter(r=>!r.isSummer).reduce((s,r)=>s+r.incomeSubsidy,0))}</td>
                              <td className="px-3 py-2 text-right font-mono">{toWan(monthlyRows.filter(r=>!r.isSummer).reduce((s,r)=>s+r.costCharge,0))}</td>
                              <td className="px-3 py-2 text-right font-mono font-semibold text-sky-700">{toWan(profitNonSummer)}</td>
                            </tr>
                            <tr className="border-t border-gray-300 bg-gray-100">
                              <td className="px-3 py-2 font-semibold text-gray-900">基准年合计</td>
                              <td className="px-3 py-2 text-right font-mono">{dischargeMWhTotal.toFixed(2)}</td>
                              <td className="px-3 py-2 text-right font-mono">{toWan(incomeDischargeTotal)}</td>
                              <td className="px-3 py-2 text-right font-mono">{toWan(incomeSubsidyTotal)}</td>
                              <td className="px-3 py-2 text-right font-mono">{toWan(costChargeTotal)}</td>
                              <td className="px-3 py-2 text-right font-mono font-semibold text-rose-700">{toWan(totalProfit)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      <p className="text-[11px] text-gray-500 mt-2">充电量合计 {chargeMWhTotal.toFixed(2)} MWh；放电量合计 {dischargeMWhTotal.toFixed(2)} MWh。</p>
                    </div>

                    {/* 逐年柱状图（含衰减） */}
                    <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                      <h3 className="text-sm font-bold text-gray-800 mb-3">逐年调峰收入（含 SOH 衰减折算）</h3>
                      <div className="h-[220px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={results.yearlyData}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                            <XAxis dataKey="year" tickLine={false} axisLine={false} tick={{fontSize: 12}} />
                            <YAxis tickLine={false} axisLine={false} tick={{fontSize: 12}} label={{ value: '万元', angle: -90, position: 'insideLeft', style: {fill: '#999'} }} />
                            <RechartsTooltip formatter={(v: number) => formatNumber(v) + ' 万元'} />
                            <Bar dataKey="breakdown.peak" fill="#e11d48" radius={[4,4,0,0]} name="调峰收益" />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-800">
                      <p className="font-semibold">勾稽关系说明</p>
                      <p className="mt-1">调峰收益的参与容量来自「基础数据 → 装机容量 × 调峰比例 × DOD」；按月分解后年度净收益作为基准年值，逐年随全生命周期 SOH 折算并计入总收入。修改「调峰比例」会自动调整现货 / 调频比例之和（保持合计=1）。</p>
                    </div>
                  </div>
                </div>

                {/* 月度分解表（可编辑充电电价） */}
                <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-gray-800">按月分解（可编辑每月充电电价）</h3>
                    <button onClick={exportPeakCsv} className="inline-flex items-center gap-2 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500">
                      <Download size={14} /> 导出 CSV
                    </button>
                  </div>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[900px] table-auto text-xs">
                      <thead>
                        <tr className="text-left text-gray-600 border-b border-gray-200">
                          <th className="pr-4 pb-2">月</th>
                          <th className="pr-4 pb-2">天数</th>
                          <th className="pr-4 pb-2">类型</th>
                          <th className="pr-4 pb-2">放电量 (MWh)</th>
                          <th className="pr-4 pb-2">充电量 (MWh)</th>
                          <th className="pr-4 pb-2">放电收入 (万元)</th>
                          <th className="pr-4 pb-2">顶峰补贴 (万元)</th>
                          <th className="pr-4 pb-2">充电成本 (万元)</th>
                          <th className="pr-4 pb-2">净收益 (万元)</th>
                          <th className="pr-4 pb-2">充电电价 (元/kWh)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {monthlyRows.map(r => (
                          <tr key={r.month} className="border-t border-gray-100">
                            <td className="py-2">{r.month} 月</td>
                            <td>{r.days}</td>
                            <td>{r.isSummer ? <span className="text-rose-700">迎峰期</span> : <span className="text-gray-500">非迎峰期</span>}</td>
                            <td>{r.dischargeMWh.toFixed(2)}</td>
                            <td>{r.chargeMWh.toFixed(2)}</td>
                            <td className="text-sky-700">{toWan(r.incomeDischarge)}</td>
                            <td className="text-emerald-700">{toWan(r.incomeSubsidy)}</td>
                            <td className="text-rose-600">{toWan(r.costCharge)}</td>
                            <td className="font-semibold text-emerald-600">{toWan(r.profit)}</td>
                            <td>
                              <input
                                type="number"
                                value={r.chargePrice}
                                step={0.0001}
                                min={0}
                                onChange={e => handleMonthChargeChange(r.month, Number(e.target.value))}
                                className="w-24 rounded-md border border-gray-300 bg-white px-2 py-0.5 text-xs text-gray-900 outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-200"
                              />
                            </td>
                          </tr>
                        ))}
                        <tr className="border-t border-gray-300 bg-gray-50">
                          <td className="py-2 font-semibold" colSpan={3}>合计</td>
                          <td className="font-mono">{dischargeMWhTotal.toFixed(2)}</td>
                          <td className="font-mono">{chargeMWhTotal.toFixed(2)}</td>
                          <td className="font-mono text-sky-700">{toWan(incomeDischargeTotal)}</td>
                          <td className="font-mono text-emerald-700">{toWan(incomeSubsidyTotal)}</td>
                          <td className="font-mono text-rose-600">{toWan(costChargeTotal)}</td>
                          <td className="font-mono font-semibold text-emerald-700">{toWan(totalProfit)}</td>
                          <td className="text-gray-400">—</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              );
            })()}

            {/* ==================== 4. 容量电价（青海发电侧容量电价 / 可靠容量补偿） ==================== */}
            {activeSection === 'capacity' && (() => {
              const auxDefaultMap: Record<string, number> = { storage: 10.39, coal: 6.05, gas: 3.75, csp: 21.53 };
              const typeNameMap: Record<string, string> = { storage: '新型储能', coal: '燃煤', gas: '燃气', csp: '光热' };
              const isStorage = params.capSrcType === 'storage';
              const auxR = (params.capAuxRate || 0) / 100;
              const dur = params.capacityMW > 0 ? params.capacityMWh / params.capacityMW : 0;
              const T = params.capPeakHours || 1;
              const reliCoef = isStorage
                ? (1 - auxR) * Math.min(dur / T, 1)
                : (1 - auxR);
              const effMW = params.capacityMW * reliCoef;
              const declMW = effMW * (params.capDeclareRatio / 100);
              const declKW = declMW * 1000;
              const yearFee = declKW * params.capKRatio * params.capPriceKW; // 元
              const monthFee = yearFee / 12;
              const perKw = params.capacityMW > 0 ? yearFee / (params.capacityMW * 1000) : 0;
              const firstYearComp = results.yearlyData[0]?.breakdown.comp ?? 0;
              const totalRev0 = results.yearlyData[0]?.revenue ?? 1;

              return (
                <div className="space-y-4">
                  {/* 顶部品牌条 */}
                  <div className="rounded-xl p-4 text-white shadow-sm" style={{ background: 'linear-gradient(135deg,#0b6cf2,#0a8f5b)' }}>
                    <h3 className="text-base font-bold">易储能源 | 独立储能电站容量电价测算工具</h3>
                    <p className="text-xs opacity-90 mt-1">
                      依据《关于建立青海省发电侧容量电价机制的通知（征求意见稿）》及《青海省发电侧可靠容量补偿机制（征求意见稿）》 ·
                      仅测算 <b>容量电价收入</b>，不含电能量市场与辅助服务收益
                    </p>
                  </div>

                  {/* 数据实时展示舱 // 容量电价（科技绿 · 海报风） */}
                  <section className="relative overflow-hidden rounded-[28px] border border-emerald-400/15 bg-[linear-gradient(135deg,_#03140d_0%,_#062b1f_45%,_#03140d_100%)] p-6 md:p-10 shadow-[0_24px_80px_rgba(5,46,33,0.45)]">
                    <div className="pointer-events-none absolute inset-0 opacity-60">
                      <div className="absolute -left-20 top-10 h-64 w-64 rounded-full bg-emerald-400/15 blur-[100px]"></div>
                      <div className="absolute right-0 bottom-0 h-72 w-72 rounded-full bg-teal-300/10 blur-[120px]"></div>
                      <div className="absolute inset-0 bg-[linear-gradient(rgba(16,185,129,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(16,185,129,0.06)_1px,transparent_1px)] bg-[size:48px_48px]"></div>
                      <div className="absolute inset-x-10 top-24 h-px bg-gradient-to-r from-transparent via-emerald-300/40 to-transparent"></div>
                    </div>

                    <div className="relative flex flex-col gap-3 md:flex-row md:items-end md:justify-between mb-8">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-emerald-300/80">REAL-TIME DATA HUB</p>
                        <h3 className="mt-2 text-2xl md:text-3xl font-bold text-white tracking-wide">数据实时展示舱 <span className="text-emerald-300">// 容量电价</span></h3>
                        <p className="mt-2 max-w-xl text-sm text-emerald-100/70">基于当前参数实时演算的容量电价核心指标，可直接作为路演 / 海报展示。</p>
                      </div>
                      <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/30 bg-emerald-400/10 px-4 py-2 text-xs text-emerald-100 backdrop-blur-sm">
                        <span className="relative flex h-2 w-2">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-70"></span>
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.9)]"></span>
                        </span>
                        LIVE · {new Date().toLocaleTimeString('zh-CN', { hour12: false })}
                      </div>
                    </div>

                    <div className={`relative grid grid-cols-2 ${isStorage ? 'lg:grid-cols-6' : 'lg:grid-cols-5'} gap-5`}>
                      {([
                        ...(isStorage ? [{
                          key: 'duration',
                          label: '满功率放电时长',
                          sub: 'Full-Power Duration',
                          value: dur.toFixed(2),
                          unit: 'h',
                          hint: `E ${params.capacityMWh.toFixed(1)} MWh ÷ P ${params.capacityMW} MW`,
                        }] : []),
                        {
                          key: 'reli',
                          label: '可靠容量系数',
                          sub: 'Reliable Capacity Factor',
                          value: (reliCoef * 100).toFixed(2) + '%',
                          unit: '',
                          hint: `(1 − ${params.capAuxRate}%) × MIN(h/T, 100%)`,
                        },
                        {
                          key: 'eff',
                          label: '有效容量',
                          sub: 'Effective Capacity',
                          value: effMW.toFixed(2),
                          unit: 'MW',
                          hint: `${declKW.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} kW (申报)`,
                        },
                        {
                          key: 'year',
                          label: '年度容量电费',
                          sub: 'Annual Capacity Fee',
                          value: (yearFee / 10000).toFixed(2),
                          unit: '万元',
                          hint: `${yearFee.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} 元/年`,
                        },
                        {
                          key: 'month',
                          label: '月度容量电费',
                          sub: 'Monthly Capacity Fee',
                          value: (monthFee / 10000).toFixed(2),
                          unit: '万元',
                          hint: `年费 ÷ 12`,
                        },
                        {
                          key: 'perKw',
                          label: '单位装机容量电费',
                          sub: 'Unit Capacity Fee',
                          value: perKw.toFixed(2),
                          unit: '元/(kW·年)',
                          hint: `含 K 与可靠容量系数后等效值`,
                        },
                      ] as Array<{ key: string; label: string; sub: string; value: string; unit: string; hint: string }>).map((it, idx) => (
                        <div
                          key={it.key}
                          className="group relative overflow-hidden rounded-2xl border border-emerald-300/15 bg-[linear-gradient(160deg,rgba(6,78,59,0.55)_0%,rgba(2,20,14,0.85)_100%)] p-5 backdrop-blur-md transition-all duration-300 hover:-translate-y-1 hover:border-emerald-300/40 hover:shadow-[0_18px_60px_rgba(16,185,129,0.25)]"
                        >
                          <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-emerald-300 to-transparent opacity-70"></div>
                          <div className="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-emerald-400/10 blur-2xl transition-opacity duration-300 group-hover:opacity-80"></div>
                          <div className="absolute right-3 top-3 font-mono text-[10px] tracking-widest text-emerald-300/60">0{idx + 1}</div>

                          <p className="text-[11px] uppercase tracking-[0.22em] text-emerald-300/70">{it.sub}</p>
                          <p className="mt-1 text-sm font-medium text-emerald-50">{it.label}</p>

                          <div className="mt-5 flex items-baseline gap-2">
                            <span className="text-[2.0rem] font-bold leading-none tracking-tight bg-gradient-to-br from-white via-emerald-100 to-emerald-300 bg-clip-text text-transparent">
                              {it.value}
                            </span>
                            {it.unit && <span className="text-xs text-emerald-200/70">{it.unit}</span>}
                          </div>

                          <div className="mt-5 flex items-center justify-between text-[11px] text-emerald-200/60">
                            <span className="font-mono truncate" title={it.hint}>{it.hint}</span>
                            <span className="inline-flex items-center gap-1 text-emerald-300 shrink-0">
                              <span className="h-1 w-1 rounded-full bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.9)]"></span>
                              ONLINE
                            </span>
                          </div>

                          <div className="mt-4 h-1 rounded-full bg-emerald-900/40 overflow-hidden">
                            <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-emerald-400 via-teal-300 to-emerald-200 group-hover:w-full transition-all duration-700"></div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="relative mt-6 flex flex-wrap items-center justify-between gap-3 text-[11px] text-emerald-200/50 font-mono">
                      <span>// SOURCE: capacity-price-engine v1.0 · 实时演算</span>
                      <span>SYS: P {params.capacityMW} MW · E {params.capacityMWh.toFixed(1)} MWh · K {params.capKRatio} · 单价 {params.capPriceKW} 元/(kW·年) · T {params.capPeakHours} h</span>
                    </div>
                  </section>

                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                    {/* 政策参数 */}
                    <div className="lg:col-span-6 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                      <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-600 text-white text-[11px] font-bold">①</span>
                        <h3 className="font-semibold text-gray-800">政策参数</h3>
                        <span className="ml-auto text-[11px] text-gray-500">2月稿:165/1.04/4h · 4月稿:185/0.92/8h</span>
                      </div>
                      <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
                        <InputField label="容量补偿标准" unit="元/(kW·年)" step={1} value={params.capPriceKW}
                          onChange={(v: number) => setParams({ ...params, capPriceKW: v })}
                          tooltip="单位有效容量每年获得的补偿。2026年青海初定 165，4月稿拟提至 185" />
                        <InputField label="容量供需系数 K" unit="-" step={0.01} value={params.capKRatio}
                          onChange={(v: number) => setParams({ ...params, capKRatio: v })}
                          tooltip=">1 容量不足，激励投资；<1 容量富余，补偿打折。按年核定" />
                        <InputField label="净负荷高峰持续时长 T" unit="小时" step={0.5} value={params.capPeakHours}
                          onChange={(v: number) => setParams({ ...params, capPeakHours: v })}
                          tooltip="近3年净负荷高峰对应时段最大持续小时数。该参数对储能影响最大" />
                      </div>
                      <div className="px-4 pb-4 -mt-1">
                        <div className="rounded-md border border-sky-100 bg-sky-50 px-3 py-2 text-[12px] leading-relaxed text-sky-900">
                          <b>核心公式：</b>容量电费 = 申报容量(kW) × 容量供需系数 K × 容量补偿标准(元/kW·年)
                          <br />申报容量 ≤ 有效容量；有效容量随电源类型差异显著
                        </div>
                      </div>
                    </div>

                    {/* 项目技术参数 */}
                    <div className="lg:col-span-6 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                      <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-600 text-white text-[11px] font-bold">②</span>
                        <h3 className="font-semibold text-gray-800">项目技术参数</h3>
                        <span className="ml-auto text-[11px] text-gray-500">P/E 与「基础数据」实时同步</span>
                      </div>
                      <div className="p-4 space-y-3">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="mb-0">
                            <div className="flex items-center justify-between mb-1">
                              <label className="text-sm font-medium text-gray-700">电源类型</label>
                              <span className="text-xs text-gray-500">-</span>
                            </div>
                            <select
                              value={params.capSrcType}
                              onChange={(e) => {
                                const v = e.target.value as typeof params.capSrcType;
                                setParams({ ...params, capSrcType: v, capAuxRate: auxDefaultMap[v] });
                              }}
                              className="w-full px-3 py-2 text-sm border rounded-md border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            >
                              <option value="storage">新型储能（独立、未参与配储）</option>
                              <option value="coal">燃煤发电</option>
                              <option value="gas">燃气发电</option>
                              <option value="csp">光热发电（未享其他补贴）</option>
                            </select>
                          </div>
                          <InputField label="厂用电率" unit="%" step={0.01} value={params.capAuxRate}
                            onChange={(v: number) => setParams({ ...params, capAuxRate: v })}
                            tooltip="燃煤6.05% / 燃气3.75% / 光热21.53% / 储能10.39%" />
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          <InputField label="额定/最大功率 P" unit="MW" step={1} value={params.capacityMW}
                            onChange={(v: number) => {
                              const newDuration = v > 0 ? +(params.capacityMWh / v).toFixed(3) : params.systemDuration;
                              setParams({ ...params, capacityMW: v, systemDuration: newDuration });
                            }}
                            tooltip="与基础数据同步；储能为最大放电功率" />
                          {isStorage && (
                            <>
                              <InputField label="放电时长 h" unit="小时" step={0.5} value={params.systemDuration}
                                onChange={(v: number) => {
                                  const newMWh = +(params.capacityMW * v).toFixed(2);
                                  setParams({ ...params, systemDuration: v, capacityMWh: newMWh });
                                }}
                                tooltip="储能额定电量 E = P × h（自动计算）" />
                              <div className="mb-0">
                                <div className="flex items-center justify-between mb-1">
                                  <label className="text-sm font-medium text-gray-700">储能电量 E</label>
                                  <span className="text-xs text-gray-500">MWh</span>
                                </div>
                                <input
                                  type="number"
                                  readOnly
                                  value={params.capacityMWh}
                                  className="w-full px-3 py-2 text-sm border rounded-md border-gray-200 bg-gray-100 text-gray-700"
                                />
                              </div>
                            </>
                          )}
                          <InputField label="申报容量比例" unit="%" step={1} value={params.capDeclareRatio}
                            onChange={(v: number) => setParams({ ...params, capDeclareRatio: v })}
                            tooltip="申报容量占有效容量比例（≤100%）。机组按月申报，不得超核定有效容量" />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 计算过程 + 图表 */}
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                    <div className="lg:col-span-7 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                      <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-600 text-white text-[11px] font-bold">③</span>
                        <h3 className="font-semibold text-gray-800">测算结果 · 计算过程</h3>
                      </div>
                      <div className="p-4 space-y-2 text-[12.5px] font-mono leading-relaxed">
                        {isStorage ? (
                          <>
                            <div className="bg-amber-50 border-l-[3px] border-amber-500 rounded px-3 py-2 text-gray-700">
                              储能电量 E = {params.capacityMW} MW × {params.systemDuration} h = <b>{params.capacityMWh.toFixed(1)} MWh</b>
                            </div>
                            <div className="bg-amber-50 border-l-[3px] border-amber-500 rounded px-3 py-2 text-gray-700">
                              满功率放电时长 = {params.capacityMWh.toFixed(1)} ÷ {params.capacityMW} = <b>{dur.toFixed(2)} 小时</b>
                            </div>
                            <div className="bg-amber-50 border-l-[3px] border-amber-500 rounded px-3 py-2 text-gray-700">
                              可靠容量系数 = (1 − {params.capAuxRate}%) × MIN({dur.toFixed(2)}/{T}, 100%) = {((1 - auxR) * 100).toFixed(2)}% × {(Math.min(dur / T, 1) * 100).toFixed(2)}% = <b>{(reliCoef * 100).toFixed(2)}%</b>
                            </div>
                          </>
                        ) : (
                          <div className="bg-amber-50 border-l-[3px] border-amber-500 rounded px-3 py-2 text-gray-700">
                            有效容量 = {params.capacityMW} MW × (1 − {params.capAuxRate}%) = <b>{effMW.toFixed(2)} MW</b>（{typeNameMap[params.capSrcType]}不计可靠容量系数）
                          </div>
                        )}
                        {isStorage && (
                          <div className="bg-amber-50 border-l-[3px] border-amber-500 rounded px-3 py-2 text-gray-700">
                            有效容量 = {params.capacityMW} MW × {(reliCoef * 100).toFixed(2)}% = <b>{effMW.toFixed(2)} MW</b>
                          </div>
                        )}
                        <div className="bg-amber-50 border-l-[3px] border-amber-500 rounded px-3 py-2 text-gray-700">
                          申报容量 = {effMW.toFixed(2)} × {params.capDeclareRatio}% = <b>{declMW.toFixed(2)} MW = {declKW.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} kW</b>
                        </div>
                        <div className="bg-amber-50 border-l-[3px] border-amber-500 rounded px-3 py-2 text-gray-700">
                          年度容量电费 = {declKW.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} kW × {params.capKRatio} × {params.capPriceKW} 元 = <b>{(yearFee / 10000).toFixed(2)} 万元</b>
                        </div>
                      </div>
                      <details className="px-4 pb-4">
                        <summary className="cursor-pointer text-sm font-semibold text-blue-600 py-1">展开：公式逐项说明</summary>
                        <div className="mt-2 space-y-1 text-[12px] font-mono text-gray-700">
                          <div className="bg-gray-50 border border-dashed border-gray-300 rounded px-3 py-1.5">① 满功率放电时长 = 储能电量 E ÷ 功率 P</div>
                          <div className="bg-gray-50 border border-dashed border-gray-300 rounded px-3 py-1.5">② 可靠容量系数（仅储能）= (1 − 厂用电率) × MIN(满功率放电时长 ÷ T, 100%)</div>
                          <div className="bg-gray-50 border border-dashed border-gray-300 rounded px-3 py-1.5">③ 有效容量（火/气/光热）= 额定容量 × (1 − 厂用电率)</div>
                          <div className="bg-gray-50 border border-dashed border-gray-300 rounded px-3 py-1.5">④ 有效容量（储能）= 最大放电功率 × 可靠容量系数</div>
                          <div className="bg-gray-50 border border-dashed border-gray-300 rounded px-3 py-1.5">⑤ 申报容量 = 有效容量 × 申报比例</div>
                          <div className="bg-gray-50 border border-dashed border-gray-300 rounded px-3 py-1.5">⑥ 年度容量电费 = 申报容量(kW) × K × 容量补偿标准</div>
                          <div className="bg-gray-50 border border-dashed border-gray-300 rounded px-3 py-1.5">⑦ 单位装机容量电费 = 年度容量电费 ÷ 装机功率(kW)</div>
                        </div>
                      </details>
                    </div>

                    <div className="lg:col-span-5 space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                          <p className="text-xs text-gray-500">首年容量补偿</p>
                          <p className="text-xl font-bold text-purple-600 mt-1">{formatNumber(firstYearComp)} <span className="text-sm font-normal text-gray-500">万元</span></p>
                          <p className="text-xs text-gray-400 mt-1">占总收入 {((firstYearComp / totalRev0) * 100).toFixed(1)}%</p>
                        </div>
                        <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                          <p className="text-xs text-gray-500">有效容量</p>
                          <p className="text-xl font-bold text-gray-900 mt-1">{effMW.toFixed(2)} <span className="text-sm font-normal text-gray-500">MW</span></p>
                          <p className="text-xs text-gray-400 mt-1">{typeNameMap[params.capSrcType]} · K={params.capKRatio}</p>
                        </div>
                      </div>
                      <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                        <h3 className="text-sm font-bold text-gray-800 mb-3">逐年容量补偿（含 SOH 与基础数据联动后的实际入账值）</h3>
                        <div className="h-[240px] w-full">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={results.yearlyData}>
                              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                              <XAxis dataKey="year" tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
                              <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
                              <RechartsTooltip formatter={(v: number) => formatNumber(v) + ' 万元'} />
                              <Bar dataKey="breakdown.comp" fill="#a855f7" radius={[4, 4, 0, 0]} name="容量补偿" />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 核心计算公式 */}
                  <div className="rounded-md border-l-[3px] border-sky-500 bg-sky-50/60 px-4 py-3 text-[12.5px] leading-relaxed text-sky-900">
                    <b>核心计算公式：</b>
                    <ol className="list-decimal pl-5 mt-1 space-y-1">
                      <li><b>容量电费</b> = 机组申报容量 × 容量供需系数 × 容量补偿标准</li>
                      <li><b>容量供需系数</b> = 系统可靠容量需求 / 系统可靠容量供给</li>
                      <li>
                        <b>系统净负荷</b> = 省内负荷（含线损）+ 外送需求 + 备用容量 − 省内风光出力 − 季调节及以下水电出力 − 外购电力 − 可中断负荷
                        <span className="ml-1 text-sky-700">（关联“鸭子曲线”效应）</span>
                      </li>
                      <li><b>可靠容量系数</b> = (1 − 厂用电率) × MIN(满功率放电时长 / 系统净负荷高峰持续时长, 100%)</li>
                    </ol>
                  </div>
                </div>
              );
            })()}

            {/* ==================== 5. 容量租赁 ==================== */}
            {activeSection === 'lease' && (() => {
              const leaseMW = params.capacityMW * params.leaseRatio / 100;
              const leaseKW = leaseMW * 1000;
              const yearLeaseFee = leaseKW * params.leasePrice; // 元
              const monthLeaseFee = yearLeaseFee / 12;
              const firstYearLease = results.yearlyData[0]?.breakdown.lease ?? 0;
              const totalRev0 = results.yearlyData[0]?.revenue ?? 1;
              const lifeLease = firstYearLease * params.lifeSpan; // 万元

              return (
                <div className="space-y-4">
                  {/* 数据实时展示舱 // 容量租赁（科技绿 · 海报风） */}
                  <section className="relative overflow-hidden rounded-[28px] border border-emerald-400/15 bg-[linear-gradient(135deg,_#03140d_0%,_#062b1f_45%,_#03140d_100%)] p-6 md:p-10 shadow-[0_24px_80px_rgba(5,46,33,0.45)]">
                    <div className="pointer-events-none absolute inset-0 opacity-60">
                      <div className="absolute -left-20 top-10 h-64 w-64 rounded-full bg-emerald-400/15 blur-[100px]"></div>
                      <div className="absolute right-0 bottom-0 h-72 w-72 rounded-full bg-teal-300/10 blur-[120px]"></div>
                      <div className="absolute inset-0 bg-[linear-gradient(rgba(16,185,129,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(16,185,129,0.06)_1px,transparent_1px)] bg-[size:48px_48px]"></div>
                      <div className="absolute inset-x-10 top-24 h-px bg-gradient-to-r from-transparent via-emerald-300/40 to-transparent"></div>
                    </div>

                    <div className="relative flex flex-col gap-3 md:flex-row md:items-end md:justify-between mb-8">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-emerald-300/80">REAL-TIME DATA HUB</p>
                        <h3 className="mt-2 text-2xl md:text-3xl font-bold text-white tracking-wide">数据实时展示舱 <span className="text-emerald-300">// 容量租赁</span></h3>
                        <p className="mt-2 max-w-xl text-sm text-emerald-100/70">基于当前参数实时演算的容量租赁核心指标，可直接作为路演 / 海报展示。</p>
                      </div>
                      <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/30 bg-emerald-400/10 px-4 py-2 text-xs text-emerald-100 backdrop-blur-sm">
                        <span className="relative flex h-2 w-2">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-70"></span>
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.9)]"></span>
                        </span>
                        LIVE · {new Date().toLocaleTimeString('zh-CN', { hour12: false })}
                      </div>
                    </div>

                    <div className="relative grid grid-cols-2 lg:grid-cols-5 gap-5">
                      {[
                        {
                          key: 'leaseMW',
                          label: '出租容量',
                          sub: 'Leased Capacity',
                          value: leaseMW.toFixed(2),
                          unit: 'MW',
                          hint: `出租率 ${params.leaseRatio}% · ${leaseKW.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} kW`,
                        },
                        {
                          key: 'price',
                          label: '租赁单价',
                          sub: 'Lease Unit Price',
                          value: formatNumber(params.leasePrice),
                          unit: '元/(kW·年)',
                          hint: `按合同口径不随 SOH 折算`,
                        },
                        {
                          key: 'year',
                          label: '首年租赁收入',
                          sub: 'First-Year Lease Income',
                          value: formatNumber(firstYearLease),
                          unit: '万元',
                          hint: `占总收入 ${((firstYearLease / totalRev0) * 100).toFixed(1)}%`,
                        },
                        {
                          key: 'month',
                          label: '月度租赁收入',
                          sub: 'Monthly Lease Income',
                          value: (monthLeaseFee / 10000).toFixed(2),
                          unit: '万元',
                          hint: `年费 ÷ 12`,
                        },
                        {
                          key: 'life',
                          label: '全周期租赁收入',
                          sub: 'Lifetime Lease Income',
                          value: formatNumber(lifeLease),
                          unit: '万元',
                          hint: `${params.lifeSpan} 年 · 按当前口径估算`,
                        },
                      ].map((it, idx) => (
                        <div
                          key={it.key}
                          className="group relative overflow-hidden rounded-2xl border border-emerald-300/15 bg-[linear-gradient(160deg,rgba(6,78,59,0.55)_0%,rgba(2,20,14,0.85)_100%)] p-5 backdrop-blur-md transition-all duration-300 hover:-translate-y-1 hover:border-emerald-300/40 hover:shadow-[0_18px_60px_rgba(16,185,129,0.25)]"
                        >
                          <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-emerald-300 to-transparent opacity-70"></div>
                          <div className="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-emerald-400/10 blur-2xl transition-opacity duration-300 group-hover:opacity-80"></div>
                          <div className="absolute right-3 top-3 font-mono text-[10px] tracking-widest text-emerald-300/60">0{idx + 1}</div>

                          <p className="text-[11px] uppercase tracking-[0.22em] text-emerald-300/70">{it.sub}</p>
                          <p className="mt-1 text-sm font-medium text-emerald-50">{it.label}</p>

                          <div className="mt-5 flex items-baseline gap-2">
                            <span className="text-[2.0rem] font-bold leading-none tracking-tight bg-gradient-to-br from-white via-emerald-100 to-emerald-300 bg-clip-text text-transparent">
                              {it.value}
                            </span>
                            {it.unit && <span className="text-xs text-emerald-200/70">{it.unit}</span>}
                          </div>

                          <div className="mt-5 flex items-center justify-between text-[11px] text-emerald-200/60">
                            <span className="font-mono truncate" title={it.hint}>{it.hint}</span>
                            <span className="inline-flex items-center gap-1 text-emerald-300 shrink-0">
                              <span className="h-1 w-1 rounded-full bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.9)]"></span>
                              ONLINE
                            </span>
                          </div>

                          <div className="mt-4 h-1 rounded-full bg-emerald-900/40 overflow-hidden">
                            <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-emerald-400 via-teal-300 to-emerald-200 group-hover:w-full transition-all duration-700"></div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="relative mt-6 flex flex-wrap items-center justify-between gap-3 text-[11px] text-emerald-200/50 font-mono">
                      <span>// SOURCE: capacity-lease-engine v1.0 · 实时演算</span>
                      <span>SYS: P {params.capacityMW} MW · 出租率 {params.leaseRatio}% · 单价 {params.leasePrice} 元/(kW·年) · 年限 {params.lifeSpan}</span>
                    </div>
                  </section>

                  {/* 参数 + 概要 + 图表 */}
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                    <div className="lg:col-span-5 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                      <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                        <Building2 size={16} className="text-green-600" />
                        <h3 className="font-semibold text-gray-800">容量租赁参数</h3>
                      </div>
                      <div className="p-4">
                        <div className="grid grid-cols-2 gap-4">
                          <InputField label="租赁单价" unit="元/kW·年" value={params.leasePrice} onChange={(v:any)=>setParams({...params, leasePrice:v})} tooltip="容量租赁单价，示例：250 元/kW·年" />
                          <InputField label="出租率" unit="%" step={1} value={params.leaseRatio} onChange={(v:any)=>setParams({...params, leaseRatio:v})} tooltip="百分比口径，例如 50 表示 50% 出租" />
                        </div>
                        <div className="bg-green-50 border border-green-100 rounded-md p-3 text-xs text-green-900 mt-2">
                          年租赁收入 = 装机功率(kW) × 出租率 × 租赁单价
                        </div>
                      </div>
                    </div>
                    <div className="lg:col-span-7 space-y-3">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                          <p className="text-xs text-gray-500">首年租赁收入</p>
                          <p className="text-xl font-bold text-green-600 mt-1">{formatNumber(firstYearLease)} <span className="text-sm font-normal text-gray-500">万元</span></p>
                          <p className="text-xs text-gray-400 mt-1">占总收入 {((firstYearLease / totalRev0)*100).toFixed(1)}%</p>
                        </div>
                        <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                          <p className="text-xs text-gray-500">出租容量</p>
                          <p className="text-xl font-bold text-gray-900 mt-1">{leaseMW.toFixed(2)} <span className="text-sm font-normal text-gray-500">MW</span></p>
                          <p className="text-xs text-gray-400 mt-1">出租率 {params.leaseRatio}%</p>
                        </div>
                      </div>
                      <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                        <h3 className="text-sm font-bold text-gray-800 mb-3">逐年租赁收入</h3>
                        <div className="h-[220px] w-full">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={results.yearlyData}>
                              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                              <XAxis dataKey="year" tickLine={false} axisLine={false} tick={{fontSize: 12}} />
                              <YAxis tickLine={false} axisLine={false} tick={{fontSize: 12}} />
                              <RechartsTooltip formatter={(v: number) => formatNumber(v) + ' 万元'} />
                              <Bar dataKey="breakdown.lease" fill="#10b981" radius={[4,4,0,0]} name="容量租赁" />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* ==================== 5.5 电池退役 / 全生命周期衰减 ==================== */}
            {activeSection === 'retirement' && (() => {
              const rows: YearResult[] = lifeCycleSim.rows;
              const totalEnergyMWh = lifeCycleSim.totalEnergyMWh;
              const replacementYears = lifeCycleSim.replacementYears;
              const avgAnnualEnergyMWh = params.lifeSpan > 0 ? totalEnergyMWh / params.lifeSpan : 0;
              // 每次更换详情：第 N 次更换发生在第 X 年，触发时累计循环 Y 次
              const replacementDetails = replacementYears.map((yr, idx) => {
                const row = rows.find(r => r.year === yr);
                return {
                  no: idx + 1,
                  year: yr,
                  cumCycles: row?.cumulativeCyclesSinceReplacement ?? 0,
                };
              });
              const formatPct = (v: number): string => {
                if (!Number.isFinite(v)) return '-';
                return `${(v * 100).toFixed(1)}%`;
              };
              const finalSoh = rows.length > 0 ? rows[rows.length - 1].sohEnd : 1;
              const avgSoh = rows.length > 0 ? rows.reduce((s, r) => s + (r.sohStart + r.sohEnd) / 2, 0) / rows.length : 1;
              const totalCycles = rows.reduce((s, r) => s + (r.annualCycles || 0), 0);
              return (
                <div className="space-y-5">
                {/* —— 数据实时展示舱（科技绿 · 海报风）· 置顶 —— */}
                <section className="relative overflow-hidden rounded-[28px] border border-emerald-400/15 bg-[linear-gradient(135deg,_#03140d_0%,_#062b1f_45%,_#03140d_100%)] p-6 md:p-10 shadow-[0_24px_80px_rgba(5,46,33,0.45)]">
                  <div className="pointer-events-none absolute inset-0 opacity-60">
                    <div className="absolute -left-20 top-10 h-64 w-64 rounded-full bg-emerald-400/15 blur-[100px]"></div>
                    <div className="absolute right-0 bottom-0 h-72 w-72 rounded-full bg-teal-300/10 blur-[120px]"></div>
                    <div className="absolute inset-0 bg-[linear-gradient(rgba(16,185,129,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(16,185,129,0.06)_1px,transparent_1px)] bg-[size:48px_48px]"></div>
                    <div className="absolute inset-x-10 top-24 h-px bg-gradient-to-r from-transparent via-emerald-300/40 to-transparent"></div>
                  </div>

                  <div className="relative flex flex-col gap-3 md:flex-row md:items-end md:justify-between mb-8">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-emerald-300/80">REAL-TIME DATA HUB</p>
                      <h3 className="mt-2 text-2xl md:text-3xl font-bold text-white tracking-wide">数据实时展示舱 <span className="text-emerald-300">// 容量租赁全周期衰减模拟</span></h3>
                      <p className="mt-2 max-w-xl text-sm text-emerald-100/70">基于 SOH 衰减模型实时演算的全生命周期核心指标，可直接作为路演 / 海报展示。</p>
                    </div>
                    <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/30 bg-emerald-400/10 px-4 py-2 text-xs text-emerald-100 backdrop-blur-sm">
                      <span className="relative flex h-2 w-2">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-70"></span>
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.9)]"></span>
                      </span>
                      LIVE · {new Date().toLocaleTimeString('zh-CN', { hour12: false })}
                    </div>
                  </div>

                  <div className="relative grid grid-cols-2 lg:grid-cols-5 gap-5">
                    {[
                      {
                        key: 'totalEnergy',
                        label: '全周期总放电量',
                        sub: 'Lifecycle Discharge',
                        value: formatNumber(totalEnergyMWh),
                        unit: 'MWh',
                        hint: `≈ ${(totalEnergyMWh / 100000).toFixed(2)} 亿 kWh`,
                      },
                      {
                        key: 'avgEnergy',
                        label: '年均放电量',
                        sub: 'Avg Annual Discharge',
                        value: formatNumber(avgAnnualEnergyMWh),
                        unit: 'MWh/年',
                        hint: `${(avgAnnualEnergyMWh / 100000).toFixed(2)} 亿 kWh/年`,
                      },
                      {
                        key: 'finalSoh',
                        label: '末年 SOH',
                        sub: 'Final-Year SOH',
                        value: formatPct(finalSoh),
                        unit: '',
                        hint: `周期均值 ${formatPct(avgSoh)}`,
                      },
                      {
                        key: 'totalCycles',
                        label: '全周期循环次数',
                        sub: 'Total Cycles',
                        value: formatNumber(totalCycles),
                        unit: '次',
                        hint: `${(params.cyclesPerDay * params.runDays).toFixed(0)} 次/年 × ${params.lifeSpan} 年`,
                      },
                      {
                        key: 'replace',
                        label: '电池更换次数',
                        sub: 'Replacements',
                        value: `${replacementYears.length}`,
                        unit: '次',
                        hint: replacementYears.length === 0 ? '未触发阈值更换' : `年份: ${replacementYears.join('/')}`,
                        details: replacementDetails,
                      },
                    ].map((it, idx) => (
                      <div
                        key={it.key}
                        className="group relative overflow-hidden rounded-2xl border border-emerald-300/15 bg-[linear-gradient(160deg,rgba(6,78,59,0.55)_0%,rgba(2,20,14,0.85)_100%)] p-5 backdrop-blur-md transition-all duration-300 hover:-translate-y-1 hover:border-emerald-300/40 hover:shadow-[0_18px_60px_rgba(16,185,129,0.25)]"
                      >
                        <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-emerald-300 to-transparent opacity-70"></div>
                        <div className="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-emerald-400/10 blur-2xl transition-opacity duration-300 group-hover:opacity-80"></div>
                        <div className="absolute right-3 top-3 font-mono text-[10px] tracking-widest text-emerald-300/60">0{idx + 1}</div>

                        <p className="text-[11px] uppercase tracking-[0.22em] text-emerald-300/70">{it.sub}</p>
                        <p className="mt-1 text-sm font-medium text-emerald-50">{it.label}</p>

                        <div className="mt-5 flex items-baseline gap-2">
                          <span className="text-[2.2rem] font-bold leading-none tracking-tight bg-gradient-to-br from-white via-emerald-100 to-emerald-300 bg-clip-text text-transparent">
                            {it.value}
                          </span>
                          {it.unit && <span className="text-xs text-emerald-200/70">{it.unit}</span>}
                        </div>

                        {/* 更换明细：仅 REPLACEMENTS 卡显示「第 N 次 · 第 X 年 · 触发循环 Y 次」 */}
                        {(it as any).details && (
                          <div className="mt-4 space-y-1.5">
                            {(it as any).details.length === 0 ? (
                              <div className="rounded-md border border-emerald-300/15 bg-emerald-950/40 px-2.5 py-1.5 text-[11px] text-emerald-200/70">
                                运行 {params.lifeSpan} 年内 SOH 未触及阈值 {(params.replaceThreshold * 100).toFixed(0)}%
                              </div>
                            ) : (
                              (it as any).details.map((d: { no: number; year: number; cumCycles: number }) => (
                                <div key={d.no} className="flex items-center justify-between gap-2 rounded-md border border-emerald-300/20 bg-emerald-900/30 px-2.5 py-1.5 text-[11px]">
                                  <span className="inline-flex items-center gap-1.5">
                                    <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-emerald-400/30 px-1.5 text-[10px] font-bold text-emerald-100">{d.no}</span>
                                    <span className="text-emerald-200/80">第 <span className="font-bold text-white">{d.year}</span> 年</span>
                                  </span>
                                  <span className="font-mono text-emerald-200/90">循环 <span className="font-bold text-white">{formatNumber(d.cumCycles)}</span> 次</span>
                                </div>
                              ))
                            )}
                          </div>
                        )}

                        {!(it as any).details && (
                          <div className="mt-5 flex items-center justify-between text-[11px] text-emerald-200/60">
                            <span className="font-mono truncate">{it.hint}</span>
                            <span className="inline-flex items-center gap-1 text-emerald-300 shrink-0">
                              <span className="h-1 w-1 rounded-full bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.9)]"></span>
                              ONLINE
                            </span>
                          </div>
                        )}

                        <div className="mt-4 h-1 rounded-full bg-emerald-900/40 overflow-hidden">
                          <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-emerald-400 via-teal-300 to-emerald-200 group-hover:w-full transition-all duration-700"></div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="relative mt-6 flex flex-wrap items-center justify-between gap-3 text-[11px] text-emerald-200/50 font-mono">
                    <span>// SOURCE: lifecycle-degradation-engine v2.6 · 实时演算</span>
                    <span>SYS: 运营 {params.lifeSpan} 年 · 容量 {formatNumber(params.capacityMWh)} MWh · 首年衰减 {(params.firstYearDeg*100).toFixed(2)}% · 年衰减 {(params.degradation*100).toFixed(2)}% · 阈值 {(params.replaceThreshold*100).toFixed(0)}%</span>
                  </div>
                </section>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                  {/* 左：核心参数（与基础数据联动） */}
                  <div className="lg:col-span-7 space-y-4">
                    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                      <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                        <BatteryWarning size={16} className="text-amber-600" />
                        <h3 className="font-semibold text-gray-800">衰减与更换参数</h3>
                        <span className="ml-auto text-[11px] text-gray-500">与「基础数据」实时同步</span>
                      </div>
                      <div className="p-4 space-y-4">
                        <div className="grid grid-cols-3 gap-3">
                          <InputField label="运营年限" unit="年" value={params.lifeSpan}
                            onChange={(v: any) => setParams({ ...params, lifeSpan: v })} />
                          <InputField label="装机容量" unit="MWh" step={1} value={params.capacityMWh}
                            onChange={(v: number) => {
                              const newDuration = params.capacityMW > 0 ? +(v / params.capacityMW).toFixed(3) : params.systemDuration;
                              setParams({ ...params, capacityMWh: v, systemDuration: newDuration, kFactor: Math.min(params.kFactor, newDuration) });
                            }}
                            tooltip="与基础数据中的装机容量同步"
                          />
                          <InputField label="综合效率" unit="%" step={0.01} value={params.efficiency}
                            onChange={(v: any) => setParams({ ...params, efficiency: v })} />
                        </div>
                        <div className="grid grid-cols-3 gap-3">
                          <InputField label="DOD充放深度" unit="%" step={0.01} value={params.dodDepth}
                            onChange={(v: any) => setParams({ ...params, dodDepth: v })} />
                          <InputField label="日均循环次数" unit="次/天" step={0.1} value={params.cyclesPerDay}
                            onChange={(v: any) => setParams({ ...params, cyclesPerDay: v })} />
                          <InputField label="年运行天数" unit="天" step={1} value={params.runDays}
                            onChange={(v: any) => setParams({ ...params, runDays: v })} />
                        </div>
                        <div className="grid grid-cols-3 gap-3">
                          <InputField label="首年衰减率" unit="%" step={0.001} value={params.firstYearDeg}
                            onChange={(v: any) => setParams({ ...params, firstYearDeg: v })}
                            tooltip="首年累计衰减，常用 0% 或 1%~3%"
                          />
                          <InputField label="第2年起年衰减" unit="%" step={0.001} value={params.degradation}
                            onChange={(v: any) => setParams({ ...params, degradation: v })}
                            tooltip="第二年起按线性年衰减；与基础数据「年容量衰减率」同源"
                          />
                          <InputField label="更换阈值SOH" unit="%" step={0.01} value={params.replaceThreshold}
                            onChange={(v: any) => setParams({ ...params, replaceThreshold: v })}
                            tooltip="年末 SOH 低于此阈值则下一年初更换电池，重置为 100%"
                          />
                        </div>
                        <label className="flex items-center gap-2 text-xs text-gray-600 pt-1">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600"
                            checked={params.enableReplacement}
                            onChange={(e) => setParams({ ...params, enableReplacement: e.target.checked })}
                          />
                          <span>启用「衰减达阈值后更换电池」逻辑（更换后 SOH 回到 100%，并按相同衰减规律重新推演）</span>
                        </label>
                      </div>
                    </div>

                    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-xs text-gray-600">
                      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-800">
                        <Info size={14} className="text-blue-600" /> 勾稽关系与联动说明
                      </h3>
                      <ul className="list-disc pl-5 space-y-1.5">
                        <li>本板块的运营年限、装机容量、综合效率、DOD、日均循环、运行天数、年衰减均与「基础数据」共用同一组参数；任一处修改会实时影响所有板块。</li>
                        <li>年循环次数 = 日均循环次数 × 年运行天数（{params.cyclesPerDay} × {params.runDays} ≈ {(params.cyclesPerDay * params.runDays).toFixed(0)} 次/年）。</li>
                        <li>SOH 推演：第 1 年末衰减 = 首年衰减率；第 i 年末衰减 = 首年衰减率 + 年衰减率 × (i-1)。</li>
                        <li>当年末 SOH &lt; 更换阈值，则下一年初完成更换，电池役龄归零、SOH 恢复至 100%，并按相同规律继续衰减。</li>
                        <li><strong>收益联动：</strong>现货套利的年放电量 = 装机容量 × 当年平均 SOH × DOD × 综合效率 × 年循环次数；调频/辅助服务收益按 SOH 折算；容量补偿与租赁按合同口径，不随 SOH 折算。</li>
                      </ul>
                    </div>
                  </div>

                  {/* 右：结果概览 */}
                  <div className="lg:col-span-5 space-y-4">
                    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                      <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                        <TrendingUp size={16} className="text-emerald-600" />
                        <h3 className="font-semibold text-gray-800">全周期结果概览</h3>
                      </div>
                      <div className="p-4 space-y-3 text-sm">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="rounded-md bg-blue-50 border border-blue-100 p-3">
                            <div className="text-xs text-gray-500">全周期总放电量</div>
                            <div className="mt-1 text-base font-bold text-gray-800 font-mono">
                              {totalEnergyMWh.toLocaleString(undefined, { maximumFractionDigits: 0 })} MWh
                            </div>
                            <div className="text-xs text-gray-500">折算约 {(totalEnergyMWh / 100000).toFixed(2)} 亿 kWh</div>
                          </div>
                          <div className="rounded-md bg-emerald-50 border border-emerald-100 p-3">
                            <div className="text-xs text-gray-500">年均放电量</div>
                            <div className="mt-1 text-base font-bold text-gray-800 font-mono">
                              {avgAnnualEnergyMWh.toLocaleString(undefined, { maximumFractionDigits: 0 })} MWh/年
                            </div>
                            <div className="text-xs text-gray-500">{(avgAnnualEnergyMWh / 100000).toFixed(2)} 亿 kWh/年</div>
                          </div>
                        </div>
                        <div className="rounded-md bg-red-50 border-2 border-red-300 p-3 shadow-[0_4px_18px_rgba(239,68,68,0.15)] relative overflow-hidden">
                          <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-red-500 via-red-600 to-red-500"></div>
                          <div className="flex items-center gap-1.5">
                            <BatteryWarning size={14} className="text-red-600" />
                            <span className="text-xs font-semibold text-red-700 uppercase tracking-wider">电池更换年份</span>
                          </div>
                          <p className="text-[10px] text-red-500/70 mt-0.5">年末判定 · 下一年初更换</p>
                          {replacementYears.length === 0 ? (
                            <div className="mt-2 text-sm font-semibold text-gray-600">全周期内未触发 SOH 阈值更换</div>
                          ) : (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {replacementDetails.map(d => (
                                <span
                                  key={d.no}
                                  className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2.5 py-1 text-xs font-bold text-white shadow-[0_2px_8px_rgba(220,38,38,0.4)]"
                                  title={`第 ${d.no} 次更换 · 累计循环 ${formatNumber(d.cumCycles)} 次`}
                                >
                                  <span className="opacity-80">第{d.no}次</span>
                                  <span>·</span>
                                  <span>第 {d.year} 年</span>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="rounded-md bg-red-50 border border-red-200 p-3">
                          <div className="flex items-center justify-between">
                            <div className="text-xs text-red-700/80 font-medium">更换次数</div>
                            <div className="text-[10px] text-red-500/60 font-mono">阈值 SOH ≤ {(params.replaceThreshold*100).toFixed(0)}%</div>
                          </div>
                          <div className="mt-1 flex items-baseline gap-1">
                            <span className="text-2xl font-bold text-red-600 font-mono">{replacementYears.length}</span>
                            <span className="text-sm font-medium text-red-700/80">次</span>
                          </div>
                          {replacementDetails.length > 0 && (
                            <div className="mt-2 space-y-1">
                              {replacementDetails.map(d => (
                                <div key={d.no} className="flex items-center justify-between text-[11px] border-t border-red-100 pt-1">
                                  <span className="text-red-700">
                                    <span className="font-bold">第 {d.no} 次</span>
                                    <span className="text-red-500/80"> · 第 {d.year} 年</span>
                                  </span>
                                  <span className="font-mono text-red-700">触发时循环 <span className="font-bold">{formatNumber(d.cumCycles)}</span> 次</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                      <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                        <Activity size={16} className="text-blue-600" />
                        <h3 className="font-semibold text-gray-800">SOH 与年放电量曲线</h3>
                      </div>
                      <div className="p-4">
                        <div className="h-[260px] w-full">
                          <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart data={rows.map(r => ({
                              year: r.year,
                              sohEnd: +(r.sohEnd * 100).toFixed(2),
                              annualEnergyMWh: Math.round(r.annualEnergyMWh),
                            }))}>
                              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                              <XAxis dataKey="year" tick={{ fontSize: 11 }} />
                              <YAxis yAxisId="left" tick={{ fontSize: 11 }} domain={[0, 100]} unit="%" />
                              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                              <RechartsTooltip />
                              <Legend wrapperStyle={{ fontSize: 11 }} />
                              <Bar yAxisId="right" dataKey="annualEnergyMWh" name="年放电量(MWh)" fill="#10b981" radius={[3, 3, 0, 0]} />
                              <Line yAxisId="left" type="monotone" dataKey="sohEnd" name="年末SOH(%)" stroke="#f59e0b" strokeWidth={2} dot={{ r: 2 }} />
                            </ComposedChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 下：逐年明细 */}
                  <div className="lg:col-span-12">
                    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                      <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <FileText size={16} className="text-blue-600" />
                          <h3 className="font-semibold text-gray-800">逐年结果明细</h3>
                        </div>
                        <span className="text-xs text-gray-500">列：年份 / 役龄 / 年初 SOH / 年末 SOH / 是否更换 / 循环次数 / 放电量 / 现货收入</span>
                      </div>
                      <div className="p-4">
                        <div className="max-h-[420px] overflow-auto rounded-md border border-gray-200">
                          <table className="min-w-full border-collapse text-xs">
                            <thead className="bg-gray-50 text-gray-700 sticky top-0">
                              <tr>
                                <th className="border-b border-gray-200 px-3 py-2 text-left font-semibold">年份</th>
                                <th className="border-b border-gray-200 px-3 py-2 text-left font-semibold">电池役龄</th>
                                <th className="border-b border-gray-200 px-3 py-2 text-left font-semibold">年初 SOH</th>
                                <th className="border-b border-gray-200 px-3 py-2 text-left font-semibold">年末 SOH</th>
                                <th className="border-b border-gray-200 px-3 py-2 text-left font-semibold">是否更换</th>
                                <th className="border-b border-gray-200 px-3 py-2 text-left font-semibold">当年循环次数</th>
                                <th className="border-b border-gray-200 px-3 py-2 text-left font-semibold">当年放电量 (MWh)</th>
                                <th className="border-b border-gray-200 px-3 py-2 text-left font-semibold">现货收入 (万元)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((row) => {
                                const yr = results.yearlyData.find(y => y.year === row.year);
                                return (
                                  <tr key={row.year} className={row.replaced ? 'bg-red-50 border-l-4 border-l-red-500' : 'odd:bg-white even:bg-gray-50/60'}>
                                    <td className={`border-b border-gray-100 px-3 py-1.5 font-mono ${row.replaced ? 'font-bold text-red-700' : ''}`}>{row.year}</td>
                                    <td className="border-b border-gray-100 px-3 py-1.5 font-mono">{row.batteryAge}</td>
                                    <td className="border-b border-gray-100 px-3 py-1.5 font-mono">{formatPct(row.sohStart)}</td>
                                    <td className={`border-b border-gray-100 px-3 py-1.5 font-mono ${row.replaced ? 'font-bold text-red-700' : ''}`}>{formatPct(row.sohEnd)}</td>
                                    <td className="border-b border-gray-100 px-3 py-1.5">
                                      {row.replaced
                                        ? <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-600 text-white text-[11px] font-bold shadow-sm">⚠ 是</span>
                                        : <span className="text-gray-400">否</span>}
                                    </td>
                                    <td className="border-b border-gray-100 px-3 py-1.5 font-mono">{row.annualCycles.toFixed(1)}</td>
                                    <td className="border-b border-gray-100 px-3 py-1.5 font-mono">{row.annualEnergyMWh.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                                    <td className="border-b border-gray-100 px-3 py-1.5 font-mono text-blue-700">{yr ? formatNumber(yr.breakdown.spot) : '-'}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                </div>
              );
            })()}

            {/* ==================== 8. 基础数据 ==================== */}
            {activeSection === 'basics' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                {/* —— 数据实时展示舱 // 基础数据与参数（科技绿 · 海报风） —— */}
                <div className="lg:col-span-12">
                  <section className="relative overflow-hidden rounded-[28px] border border-emerald-400/15 bg-[linear-gradient(135deg,_#03140d_0%,_#062b1f_45%,_#03140d_100%)] p-6 md:p-10 shadow-[0_24px_80px_rgba(5,46,33,0.45)]">
                    <div className="pointer-events-none absolute inset-0 opacity-60">
                      <div className="absolute -left-20 top-10 h-64 w-64 rounded-full bg-emerald-400/15 blur-[100px]"></div>
                      <div className="absolute right-0 bottom-0 h-72 w-72 rounded-full bg-teal-300/10 blur-[120px]"></div>
                      <div className="absolute inset-0 bg-[linear-gradient(rgba(16,185,129,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(16,185,129,0.06)_1px,transparent_1px)] bg-[size:48px_48px]"></div>
                      <div className="absolute inset-x-10 top-24 h-px bg-gradient-to-r from-transparent via-emerald-300/40 to-transparent"></div>
                    </div>

                    <div className="relative flex flex-col gap-3 md:flex-row md:items-end md:justify-between mb-8">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-emerald-300/80">REAL-TIME DATA HUB</p>
                        <h3 className="mt-2 text-2xl md:text-3xl font-bold text-white tracking-wide">数据实时展示舱 <span className="text-emerald-300">// 基础数据与参数</span></h3>
                        <p className="mt-2 max-w-xl text-sm text-emerald-100/70">基于当前参数实时演算的项目核心规模指标，可直接作为路演 / 海报展示。</p>
                      </div>
                      <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/30 bg-emerald-400/10 px-4 py-2 text-xs text-emerald-100 backdrop-blur-sm">
                        <span className="relative flex h-2 w-2">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-70"></span>
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.9)]"></span>
                        </span>
                        LIVE · {new Date().toLocaleTimeString('zh-CN', { hour12: false })}
                      </div>
                    </div>

                    <div className="relative grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-5">
                      {[
                        { label: '装机功率', sub: 'Rated Power',       value: params.capacityMW.toFixed(1),                   unit: 'MW',   hint: `系统时长 ${params.systemDuration} h` },
                        { label: '系统时长', sub: 'Duration',          value: params.systemDuration.toFixed(1),               unit: 'h',    hint: `= 容量 / 功率` },
                        { label: '装机容量', sub: 'Energy Capacity',   value: params.capacityMWh.toFixed(1),                  unit: 'MWh',  hint: `${(params.capacityMWh/1000).toFixed(2)} GWh` },
                        { label: '综合效率', sub: 'Round-Trip Eff.',   value: (params.efficiency*100).toFixed(1),             unit: '%',    hint: `DOD ${(params.dodDepth*100).toFixed(1)}%` },
                        { label: '运营年限', sub: 'Operation Years',   value: params.lifeSpan.toFixed(0),                     unit: '年',   hint: `年衰减 ${(params.degradation*100).toFixed(1)}%` },
                        { label: '总投资',   sub: 'Total CAPEX',       value: (results.totalInvestment/10000).toFixed(0),     unit: '万元', hint: `单价 ${params.epcPrice.toFixed(2)} 元/Wh` },
                      ].map((it, idx) => (
                        <div
                          key={it.label}
                          className="group relative overflow-hidden rounded-2xl border border-emerald-300/15 bg-[linear-gradient(160deg,rgba(6,78,59,0.55)_0%,rgba(2,20,14,0.85)_100%)] p-5 backdrop-blur-md transition-all duration-300 hover:-translate-y-1 hover:border-emerald-300/40 hover:shadow-[0_18px_60px_rgba(16,185,129,0.25)]"
                        >
                          <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-emerald-300 to-transparent opacity-70"></div>
                          <div className="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-emerald-400/10 blur-2xl transition-opacity duration-300 group-hover:opacity-80"></div>
                          <div className="absolute right-3 top-3 font-mono text-[10px] tracking-widest text-emerald-300/60">0{idx + 1}</div>

                          <p className="text-[11px] uppercase tracking-[0.22em] text-emerald-300/70">{it.sub}</p>
                          <p className="mt-1 text-sm font-medium text-emerald-50">{it.label}</p>

                          <div className="mt-5 flex items-baseline gap-2">
                            <span className="text-[2.4rem] font-bold leading-none tracking-tight bg-gradient-to-br from-white via-emerald-100 to-emerald-300 bg-clip-text text-transparent">
                              {it.value}
                            </span>
                            <span className="text-xs text-emerald-200/70">{it.unit}</span>
                          </div>

                          <div className="mt-5 flex items-center justify-between text-[11px] text-emerald-200/60">
                            <span className="font-mono">{it.hint}</span>
                            <span className="inline-flex items-center gap-1 text-emerald-300">
                              <span className="h-1 w-1 rounded-full bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.9)]"></span>
                              ONLINE
                            </span>
                          </div>

                          <div className="mt-4 h-1 rounded-full bg-emerald-900/40 overflow-hidden">
                            <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-emerald-400 via-teal-300 to-emerald-200 group-hover:w-full transition-all duration-700"></div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="relative mt-6 flex flex-wrap items-center justify-between gap-3 text-[11px] text-emerald-200/50 font-mono">
                      <span>// SOURCE: project-baseline-engine v1.0 · 实时演算</span>
                      <span>SYS: 装机 {params.capacityMW} MW / {params.capacityMWh} MWh · 时长 {params.systemDuration} h · 综合效率 {(params.efficiency*100).toFixed(1)}% · DOD {(params.dodDepth*100).toFixed(1)}%</span>
                    </div>
                  </section>
                </div>

                <div className="lg:col-span-6 space-y-4">
                  <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                    <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                      <Settings size={16} className="text-blue-600" />
                      <h3 className="font-semibold text-gray-800">项目基础参数</h3>
                    </div>
                    <div className="p-4">
                      <div className="grid grid-cols-3 gap-3">
                        <InputField 
                          label="装机功率" 
                          unit="MW" 
                          value={params.capacityMW} 
                          onChange={(v:any)=>setParams({
                            ...params, 
                            capacityMW:v,
                            capacityMWh: +(v * params.systemDuration).toFixed(2)
                          })} 
                          tooltip="功率改变时，按当前时长同步重算容量(MWh)"
                        />
                        <InputField 
                          label="系统时长" 
                          unit="小时" 
                          step={0.1}
                          value={params.systemDuration} 
                          onChange={(v:number)=>setParams({
                            ...params, 
                            systemDuration:v,
                            capacityMWh: +(params.capacityMW * v).toFixed(2),
                            kFactor: Math.min(params.kFactor, v)
                          })} 
                          tooltip="独立参数：储能系统的额定放电时长 = 容量(MWh) / 功率(MW)"
                        />
                        <InputField 
                          label="装机容量" 
                          unit="MWh" 
                          step={1}
                          value={params.capacityMWh} 
                          onChange={(v:number)=>{
                            const newDuration = params.capacityMW > 0 ? +(v / params.capacityMW).toFixed(3) : params.systemDuration;
                            setParams({
                              ...params, 
                              capacityMWh:v,
                              systemDuration: newDuration,
                              kFactor: Math.min(params.kFactor, newDuration)
                            });
                          }} 
                          tooltip="= 装机功率 × 系统时长，可直接编辑(将反推时长)"
                        />
                      </div>
                      <div className="grid grid-cols-3 gap-4 mt-3">
                        <InputField label="综合效率" unit="%" step={0.01} value={params.efficiency} onChange={(v:any)=>setParams({...params, efficiency:v})} />
                        <InputField label="DOD充放深度" unit="%" step={0.01} value={params.dodDepth} onChange={(v:any)=>setParams({...params, dodDepth:v})} tooltip="单次循环可释放的容量比例，常用 0.85 ~ 0.95" />
                        <InputField label="运营年限" unit="年" value={params.lifeSpan} onChange={(v:any)=>setParams({...params, lifeSpan:v})} />
                      </div>
                      <InputField label="年容量衰减率" unit="%" step={0.001} value={params.degradation} onChange={(v:any)=>setParams({...params, degradation:v})} tooltip="影响全周期收入，默认2%" />
                      <InputField label="单位造价(EPC)" unit="元/Wh" step={0.01} value={params.epcPrice} onChange={(v:any)=>setParams({...params, epcPrice:v})} tooltip="建议输入 0.98 ~ 1.60" />
                      <InputField label="其他成本系数" unit="%" step={0.01} value={params.otherCostRatio} onChange={(v:any)=>setParams({...params, otherCostRatio:v})} tooltip="管理费、土地等" />

                      {/* 功率分配：现货 vs 调频 —— 纯色深绿背景高亮 */}
                      <div className="mt-3 relative overflow-hidden rounded-xl border-2 border-emerald-400/60 ring-2 ring-emerald-300/30 ring-offset-2 ring-offset-white p-4 shadow-[0_8px_30px_rgba(5,150,105,0.35)] bg-[#14594f]">
                        {/* 动效背景层 */}
                        <div className="pointer-events-none absolute inset-0 opacity-90">
                          <div className="absolute -left-10 -top-10 h-40 w-40 rounded-full bg-emerald-400/25 blur-3xl animate-pulse"></div>
                          <div className="absolute -right-12 -bottom-12 h-44 w-44 rounded-full bg-teal-300/20 blur-3xl animate-pulse [animation-delay:1.2s]"></div>
                          <div className="absolute inset-x-6 top-10 h-px bg-gradient-to-r from-transparent via-emerald-300/60 to-transparent"></div>
                          <div className="absolute inset-x-6 bottom-10 h-px bg-gradient-to-r from-transparent via-teal-300/50 to-transparent"></div>
                        </div>
                        {/* 流光顶边 */}
                        <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-transparent via-emerald-400 to-transparent opacity-90"></div>

                        <div className="relative">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs font-bold text-emerald-100 flex items-center gap-1.5 tracking-wide">
                              <span className="relative flex h-2 w-2">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70"></span>
                                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.9)]"></span>
                              </span>
                              <span className="uppercase text-[10px] tracking-[0.22em] text-emerald-300/90">CRITICAL</span>
                              <span className="text-emerald-50">功率分配（现货 vs 调频 vs 调峰）</span>
                            </p>
                            <p className={`text-[11px] font-mono px-2 py-0.5 rounded-full border ${Math.abs(params.spotRatio + params.frRatio + params.peakRatio - 1) < 0.001 ? 'text-emerald-200 border-emerald-300/60 bg-emerald-500/15' : 'text-rose-200 border-rose-300/60 bg-rose-500/15'}`}>
                              合计 {((params.spotRatio + params.frRatio + params.peakRatio) * 100).toFixed(1)}%
                            </p>
                          </div>
                          <div className="grid grid-cols-3 gap-3 [&_label]:!text-emerald-100 [&_input]:!bg-emerald-950/40 [&_input]:!border-emerald-400/30 [&_input]:!text-emerald-50">
                            <InputField
                              label="参与现货比例"
                              unit="0~1"
                              step={0.05}
                              value={params.spotRatio}
                              onChange={(v:number)=>{
                                const sv = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
                                // 保留 调峰比例 不变，自动用调频比例补足到 1
                                const fr = Math.max(0, +(1 - sv - params.peakRatio).toFixed(4));
                                setParams({...params, spotRatio: sv, frRatio: fr});
                              }}
                              tooltip="参与现货市场的功率占比；调整后自动用调频比例补足合计=1（保留调峰比例不变）"
                            />
                            <InputField
                              label="参与调频比例"
                              unit="0~1"
                              step={0.05}
                              value={params.frRatio}
                              onChange={(v:number)=>{
                                const fv = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
                                // 保留 调峰比例 不变，自动用现货比例补足到 1
                                const sp = Math.max(0, +(1 - fv - params.peakRatio).toFixed(4));
                                setParams({...params, frRatio: fv, spotRatio: sp});
                              }}
                              tooltip="参与调频(辅助服务)的功率占比；调整后自动用现货比例补足合计=1（保留调峰比例不变）"
                            />
                            <InputField
                              label="参与调峰比例"
                              unit="0~1"
                              step={0.05}
                              value={params.peakRatio}
                              onChange={(v:number)=>{
                                const pv = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
                                // 调整调峰比例：在保持现货:调频原比例下，由二者合计补足到 (1 - 调峰)
                                const remain = Math.max(0, +(1 - pv).toFixed(4));
                                const oldSum = params.spotRatio + params.frRatio;
                                let newSpot: number;
                                let newFr: number;
                                if (oldSum > 0) {
                                  newSpot = +(remain * (params.spotRatio / oldSum)).toFixed(4);
                                  newFr = +(remain - newSpot).toFixed(4);
                                } else {
                                  newSpot = remain;
                                  newFr = 0;
                                }
                                setParams({...params, peakRatio: pv, spotRatio: newSpot, frRatio: newFr});
                              }}
                              tooltip="参与调峰（迎峰期顶峰补贴）的功率占比；调整后按现货:调频原比例自动重分配剩余 (1 - 调峰)"
                            />
                          </div>
                          <p className="text-[11px] text-emerald-200/90 mt-1">
                            现货板块按 装机功率×现货比例 计算放电量；调频板块按 装机功率×调频比例 作为中标容量；调峰板块按 装机容量×调峰比例 计入江苏迎峰期月度收益。
                        </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-6 space-y-4">
                  <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                    <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                      <DollarSign size={16} className="text-purple-600" />
                      <h3 className="font-semibold text-gray-800">融资与税务</h3>
                    </div>
                    <div className="p-4">
                      <div className="grid grid-cols-2 gap-4">
                        <InputField label="贷款比例" unit="%" step={0.01} value={params.debtRatio} onChange={(v:any)=>setParams({...params, debtRatio:v})} />
                        <InputField label="贷款利率" unit="%" step={0.001} value={params.interestRate} onChange={(v:any)=>setParams({...params, interestRate:v})} />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <InputField label="贷款期限" unit="年" step={1} value={params.loanTerm} onChange={(v:any)=>setParams({...params, loanTerm:v})} />
                        <InputField label="残值率" unit="%" step={0.01} value={params.residualValue} onChange={(v:any)=>setParams({...params, residualValue:v})} />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <InputField label="所得税率" unit="%" step={0.01} value={params.incomeTaxRate} onChange={(v:any)=>setParams({...params, incomeTaxRate:v})} />
                        <InputField label="折现率" unit="%" step={0.01} value={params.discountRate} onChange={(v:any)=>setParams({...params, discountRate:v})} />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <InputField label="运维费率" unit="%/CAPEX" step={0.001} value={params.opexRate} onChange={(v:any)=>setParams({...params, opexRate:v})} />
                        <InputField label="增值税即征即退" unit="%" step={0.01} value={params.vatRefundRatio} onChange={(v:any)=>setParams({...params, vatRefundRatio:v})} />
                      </div>
                    </div>
                  </div>

                  <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                    <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                      <Database size={16} className="text-green-600" />
                      <h3 className="font-semibold text-gray-800">投资概算 (实时)</h3>
                    </div>
                    <div className="p-4 space-y-2 text-sm">
                      <div className="flex justify-between"><span className="text-gray-500">总投资 (CAPEX)</span><span className="font-mono">{(results.totalInvestment / 10000).toFixed(0)} 万元</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">自有资金</span><span className="font-mono text-blue-600">{(results.equityAmount / 10000).toFixed(0)} 万元</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">银行贷款</span><span className="font-mono">{(results.debtAmount / 10000).toFixed(0)} 万元</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">单位投资</span><span className="font-mono">{params.epcPrice.toFixed(2)} 元/Wh</span></div>
                    </div>
                  </div>
                </div>
              </div>
            )}

          </main>
        </div>
      </div>
    </div>
  );
}

