
import React, { useState, useMemo, useCallback } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, LineChart, Line, ComposedChart, Area
} from 'recharts';
import { 
  TrendingUp, DollarSign, Activity, Settings, Info, 
  AlertTriangle, Save, RefreshCw, FileText, CheckCircle, FolderOpen, Trash2,
  LayoutDashboard, Zap, Gauge, Battery, BatteryWarning, Building2, BookOpen, ScrollText, Database
} from 'lucide-react';

type SectionKey =
  | 'overview'
  | 'spot'
  | 'frequency'
  | 'capacity'
  | 'lease'
  | 'retirement'
  | 'basics';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
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
    
    // 收益 - 辅助服务(调频)
    auxIncome: 504,        // 万元/年 (直接输入估算值，因计算复杂)

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
      // 年放电量 (MWh) = 容量(衰减后) * DOD * 次数 * 天数 * 效率
      const annualDischargeMWh = availableMWh * params.dodDepth * params.cyclesPerDay * params.runDays * params.efficiency;
      // 价差按年复合增长 (spotSpreadGrowth 为小数, 如 0.02 表示 +2%/年)
      const yearSpread = params.spotSpread * Math.pow(1 + params.spotSpreadGrowth, year - 1);
      // 理论收入
      const theoreticalSpotIncome = (annualDischargeMWh * 1000 * yearSpread) / 10000; 
      // 修正后实际收入 (考虑不确定性 & 损耗)
      const spotIncome = theoreticalSpotIncome * params.spotMarketUncertainty * params.tradingLossFactor;

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

      // (4) 辅助服务 (假设固定或微调)
      const auxIncome = params.auxIncome * degradFactor; // 随容量衰减

      const totalRevenue = spotIncome + compIncome + leaseIncome + auxIncome;

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
      const vatTaxes = totalRevenue / 1.13 * 0.085; 
      const surcharges = vatTaxes * 0.12; // 附加税
      
      // 5. 利润
      // 利润总额 = 不含税收入 - 不含税成本 - 财务费用 - 附加税
      // 简化：EBITDA - 折旧 - 利息
      // 这里为了快速计算，采用：
      // 净收入(不含税)
      const revenueExclTax = totalRevenue / 1.13;
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

      yearlyData.push({
        year,
        revenue: totalRevenue,
        netProfit,
        projectNCF,
        equityNCF,
        cost: opex + interest + incomeTax,
        sohStart: simRow?.sohStart ?? 1,
        sohEnd: simRow?.sohEnd ?? Math.pow(1 - params.degradation, year),
        replaced: simRow?.replaced ?? false,
        breakdown: {
          spot: spotIncome,
          comp: compIncome,
          lease: leaseIncome,
          aux: auxIncome
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
    let cumSum = -totalInvestment;
    for(let i=1; i<projectCashFlows.length; i++) {
      if (cumSum < 0) {
        cumSum += projectCashFlows[i];
        if (cumSum >= 0) {
          // 线性插值
          paybackPeriod = (i - 1) + (Math.abs(cumSum - projectCashFlows[i]) / projectCashFlows[i]);
          break;
        }
      }
    }

    return {
      totalInvestment,     // 元
      debtAmount,
      equityAmount,
      yearlyData,
      projectIRR,
      equityIRR,
      npv,
      paybackPeriod,
      avgRevenue: yearlyData.reduce((a, b) => a + b.revenue, 0) / params.lifeSpan,
      avgNetProfit: yearlyData.reduce((a, b) => a + b.netProfit, 0) / params.lifeSpan
    };
  }, [params, lifeCycleSim]);

  /**
   * 计算基准年放电量（不考虑衰减，用于现货收入展示）
   */
  const annualDischargeMWh = useMemo(() => {
    return params.capacityMWh * params.dodDepth * params.cyclesPerDay * params.runDays * params.efficiency;
  }, [params.capacityMWh, params.dodDepth, params.cyclesPerDay, params.runDays, params.efficiency]);

  // --- 通知状态 ---
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [isExporting, setIsExporting] = useState(false);
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

  // --- 导出报告 ---
  const handleExportReport = async () => {
    setIsExporting(true);
    try {
      const element = document.getElementById('main-report-content');
      if (!element) { showNotification('error', '未找到报告区域'); return; }

      // 等一帧，确保图表/字体已经渲染完成
      await new Promise(r => requestAnimationFrame(() => r(null)));
      if ((document as any).fonts?.ready) {
        try { await (document as any).fonts.ready; } catch {}
      }

      const canvas = await html2canvas(element, {
        scale: Math.min(window.devicePixelRatio || 1, 2),
        useCORS: true,
        allowTaint: true,
        logging: false,
        backgroundColor: '#f9fafb',
        windowWidth: element.scrollWidth,
        windowHeight: element.scrollHeight,
        // 在克隆的 DOM 上去除 html2canvas 不支持的样式（backdrop-filter / 渐变 / 滤镜 / oklch 等）
        onclone: (doc) => {
          const root = doc.getElementById('main-report-content');
          if (!root) return;
          const all = root.querySelectorAll<HTMLElement>('*');
          all.forEach(el => {
            const cs = doc.defaultView?.getComputedStyle(el);
            if (!cs) return;
            // 1) 去掉 backdrop-filter / filter（blur 等 html2canvas 不支持）
            el.style.backdropFilter = 'none';
            (el.style as any).webkitBackdropFilter = 'none';
            if (cs.filter && cs.filter !== 'none') el.style.filter = 'none';
            // 2) 任意 background-image（含 linear/radial/conic-gradient、url）一律清空
            //    避免 html2canvas 调用 createPattern 时遇到 0 尺寸图像报错
            if (cs.backgroundImage && cs.backgroundImage !== 'none') {
              el.style.backgroundImage = 'none';
              const isTransparent = !cs.backgroundColor || cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent';
              if (isTransparent) {
                // 深色主题（科技舱）→ 深色兜底；其余 → 透明
                const isDark = (el.closest('section')?.className || '').includes('bg-[radial-gradient') || /text-white|text-slate-(50|100|200|300)/.test(el.className);
                el.style.backgroundColor = isDark ? '#0f172a' : 'transparent';
              }
            }
            // 3) 兜底：替换不支持的现代颜色函数
            (['color','backgroundColor','borderColor'] as const).forEach(k => {
              const v = (cs as any)[k] as string;
              if (v && /oklch|lab\(|lch\(|color\(/.test(v)) {
                (el.style as any)[k] = k === 'color' ? '#0f172a' : '#ffffff';
              }
            });
          });
        },
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.92);
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const imgH = (canvas.height * pageW) / canvas.width;
      let remainH = imgH;
      let yPos = 0;
      pdf.addImage(imgData, 'JPEG', 0, yPos, pageW, imgH);
      remainH -= pageH;
      while (remainH > 0) {
        yPos -= pageH;
        pdf.addPage();
        pdf.addImage(imgData, 'JPEG', 0, yPos, pageW, imgH);
        remainH -= pageH;
      }
      const dateStr = new Date().toLocaleDateString('zh-CN').replace(/\//g, '-');
      pdf.save(`易储数智能源_储能测算报告_${dateStr}.pdf`);
      showNotification('success', 'PDF 报告已导出！');
    } catch (err) {
      console.error('[ExportPDF] 失败：', err);
      const msg = err instanceof Error ? err.message : String(err);
      showNotification('error', `导出失败：${msg.slice(0, 60)}`);
    } finally {
      setIsExporting(false);
    }
  };

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
      description: '价差套利 / 分时滚动交易',
    },
    {
      label: '容量补偿',
      shortLabel: '补偿',
      value: results.yearlyData[0]?.breakdown.comp ?? 0,
      color: 'from-violet-500 to-fuchsia-400',
      glow: 'shadow-violet-500/20',
      accent: 'bg-violet-400',
      description: '容量价值 / 政策补偿兑现',
    },
    {
      label: '容量租赁',
      shortLabel: '租赁',
      value: results.yearlyData[0]?.breakdown.lease ?? 0,
      color: 'from-emerald-500 to-lime-400',
      glow: 'shadow-emerald-500/20',
      accent: 'bg-emerald-400',
      description: '容量出租 / 长协收益锁定',
    },
    {
      label: '辅助服务',
      shortLabel: '辅助',
      value: results.yearlyData[0]?.breakdown.aux ?? 0,
      color: 'from-orange-500 to-amber-400',
      glow: 'shadow-orange-500/20',
      accent: 'bg-orange-400',
      description: '调频调峰 / AGC性能结算',
    },
  ].map(item => ({
    ...item,
    percent: firstYearRevenue > 0 ? (item.value / firstYearRevenue) * 100 : 0,
  }));

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
                <button
                  onClick={handleExportReport}
                  disabled={isExporting}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isExporting ? <RefreshCw size={16} className="animate-spin" /> : <FileText size={16} />}
                  {isExporting ? '导出中...' : '导出报告'}
                </button>
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
              <>
                <section className="relative overflow-hidden rounded-[28px] border border-slate-800 bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.16),_transparent_24%),radial-gradient(circle_at_bottom_right,_rgba(124,58,237,0.16),_transparent_24%),linear-gradient(135deg,_#07111f_0%,_#0b1830_45%,_#111827_100%)] p-6 md:p-8 shadow-[0_24px_80px_rgba(15,23,42,0.28)]">
                  <div className="pointer-events-none absolute inset-0 opacity-40">
                    <div className="absolute left-10 top-10 h-32 w-32 rounded-full bg-cyan-400/10 blur-3xl"></div>
                    <div className="absolute bottom-0 right-20 h-40 w-40 rounded-full bg-violet-500/10 blur-3xl"></div>
                    <div className="absolute inset-x-0 top-20 h-px bg-gradient-to-r from-transparent via-cyan-300/30 to-transparent"></div>
                  </div>

                  <div className="relative mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300/80">Revenue Structure Capsule</p>
                      <h3 className="mt-2 text-2xl font-bold text-white">收益结构科技舱</h3>
                      <p className="mt-2 max-w-2xl text-sm text-slate-300">
                        以首年收益为基准，将现货套利、容量补偿、容量租赁与辅助服务拆解为四条收益流。鼠标悬停卡片可查看收益强度与关键来源。
                      </p>
                    </div>
                    <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-white/5 px-4 py-2 text-sm text-cyan-100 backdrop-blur-sm">
                      <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_12px_rgba(103,232,249,0.9)]"></span>
                      首年总收益 {formatNumber(firstYearRevenue)} 万元
                    </div>
                  </div>

                  <div className="relative grid grid-cols-1 gap-8 lg:grid-cols-12 lg:items-stretch">
                    <div className="lg:col-span-6 space-y-5">
                      <div className="mx-auto grid w-full max-w-[560px] grid-cols-4 gap-3">
                        {revenueStructure.map(item => (
                          <div
                            key={item.label}
                            className={`group relative flex h-[92px] items-center justify-center rounded-[26px] border border-white/10 bg-white/8 backdrop-blur-md transition-all duration-300 hover:-translate-y-1 hover:scale-[1.03] hover:border-white/25`}
                          >
                            <div className={`absolute inset-0 rounded-[26px] bg-gradient-to-br ${item.color} opacity-20 blur-md transition-opacity duration-300 group-hover:opacity-40`}></div>
                            <div className="relative text-center">
                              <div className={`mx-auto mb-1.5 h-3 w-3 rounded-full ${item.accent} shadow-[0_0_12px_currentColor]`}></div>
                              <span className="block text-sm font-semibold text-slate-50">{item.shortLabel}</span>
                              <span className="mt-1 block text-xs font-medium text-slate-300">{item.percent.toFixed(1)}%</span>
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="relative mx-auto flex h-[360px] w-full max-w-[560px] items-center justify-center">
                        <div className="absolute inset-5 rounded-full border border-cyan-300/10"></div>
                        <div className="absolute inset-10 rounded-full border border-cyan-300/15 border-dashed animate-pulse"></div>
                        <div className="absolute inset-16 rounded-full border border-violet-300/10"></div>
                        <div className="absolute h-72 w-[22rem] rounded-[2.5rem] bg-[radial-gradient(circle,_rgba(34,211,238,0.35),_rgba(59,130,246,0.16)_45%,_rgba(15,23,42,0)_72%)] blur-sm"></div>
                        <div className="relative flex h-60 w-[25rem] flex-col items-center justify-center rounded-[2.25rem] border border-cyan-300/20 bg-slate-950/80 px-8 text-center shadow-[0_0_64px_rgba(34,211,238,0.24)] backdrop-blur-sm">
                          <span className="text-[11px] uppercase tracking-[0.28em] text-cyan-300/70">Core Revenue</span>
                          <strong className="mt-4 whitespace-nowrap text-[3.6rem] font-semibold leading-none tracking-tight text-white">{formatNumber(firstYearRevenue)}</strong>
                          <span className="mt-2 text-sm text-slate-400">万元 / 首年</span>
                        </div>
                      </div>

                      <div className="mx-auto w-full max-w-[560px] rounded-[28px] border border-white/10 bg-slate-950/40 px-6 py-5 backdrop-blur-md shadow-[0_12px_40px_rgba(8,15,30,0.35)]">
                        <div className="mb-3 flex items-center justify-between">
                          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-300/70">Background Params</p>
                          <span className="text-[11px] text-slate-500">收益驱动口径</span>
                        </div>
                        <div className="grid grid-cols-1 gap-x-6 gap-y-4 text-left text-[11px] text-slate-300 md:grid-cols-3">
                          <div>
                            <p className="text-slate-500">系统容量</p>
                            <p className="mt-0.5 font-mono text-cyan-100">{formatNumber(params.capacityMWh)} MWh</p>
                          </div>
                          <div>
                            <p className="text-slate-500">日循环次数</p>
                            <p className="mt-0.5 font-mono text-cyan-100">{formatNumber(params.cyclesPerDay)} 次/天</p>
                          </div>
                          <div>
                            <p className="text-slate-500">综合效率</p>
                            <p className="mt-0.5 font-mono text-cyan-100">{(params.efficiency * 100).toFixed(1)}%</p>
                          </div>
                          <div>
                            <p className="text-slate-500">系统时长</p>
                            <p className="mt-0.5 font-mono text-cyan-100">{formatNumber(params.systemDuration)} h</p>
                          </div>
                          <div>
                            <p className="text-slate-500">现货净价差</p>
                            <p className="mt-0.5 font-mono text-cyan-100">{params.spotSpread.toFixed(4)} 元/kWh</p>
                          </div>
                          <div>
                            <p className="text-slate-500">DOD 深度</p>
                            <p className="mt-0.5 font-mono text-cyan-100">{(params.dodDepth * 100).toFixed(1)}%</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="lg:col-span-6 grid grid-cols-1 gap-x-5 gap-y-6 md:grid-cols-2 md:auto-rows-fr lg:h-full">
                      {revenueStructure.map(item => (
                        <div
                          key={item.label}
                          className={`group relative min-h-[264px] overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-white/20 hover:bg-white/8 hover:shadow-2xl ${item.glow}`}
                        >
                          <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${item.color}`}></div>
                          <div className={`absolute -right-10 -top-10 h-24 w-24 rounded-full bg-gradient-to-br ${item.color} opacity-10 blur-2xl transition-opacity duration-300 group-hover:opacity-25`}></div>

                          <div className="relative flex items-start justify-between gap-3">
                            <div>
                              <p className="text-base font-semibold text-white">{item.label}</p>
                              <p className="mt-1 text-xs text-slate-400">{item.description}</p>
                            </div>
                            <div className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-200">
                              收益流
                            </div>
                          </div>

                          <div className="relative mt-7 flex items-end justify-between gap-3">
                            <div>
                              <p className="text-2xl font-semibold text-white">{formatNumber(item.value)}</p>
                              <p className="mt-1 text-xs text-slate-400">万元 / 首年贡献</p>
                            </div>
                            <div className="text-right text-xs text-slate-400">
                              <p>收益强度</p>
                              <p className="mt-1 font-mono text-slate-200">{(item.percent / 100 * 360).toFixed(0)} deg</p>
                            </div>
                          </div>

                          <div className="mt-7">
                            <div className="mb-2 flex justify-between text-[11px] text-slate-400">
                              <span>贡献强度</span>
                              <span>{item.label}</span>
                            </div>
                            <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                              <div
                                className={`h-2 rounded-full bg-gradient-to-r ${item.color} transition-all duration-500 group-hover:brightness-110`}
                                style={{ width: `${Math.max(item.percent, 2)}%` }}
                              ></div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-16 h-16 bg-blue-50 rounded-bl-full -mr-4 -mt-4"></div>
                    <p className="text-sm text-gray-500 font-medium relative z-10">全投资 IRR</p>
                    <p className={`text-2xl font-bold mt-1 relative z-10 ${results.projectIRR > 0.08 ? 'text-blue-600' : 'text-red-500'}`}>
                      {formatPercent(results.projectIRR)}
                    </p>
                    <p className="text-xs text-gray-400 mt-2">资本金IRR: <span className="text-gray-700 font-semibold">{formatPercent(results.equityIRR)}</span></p>
                  </div>
                  <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-16 h-16 bg-green-50 rounded-bl-full -mr-4 -mt-4"></div>
                    <p className="text-sm text-gray-500 font-medium relative z-10">总投资额</p>
                    <p className="text-2xl font-bold text-gray-900 mt-1 relative z-10">
                      {(results.totalInvestment / 10000 / 10000).toFixed(2)} <span className="text-sm font-normal text-gray-500">亿元</span>
                    </p>
                    <p className="text-xs text-gray-400 mt-2">单位投资: {params.epcPrice} 元/Wh</p>
                  </div>
                  <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-16 h-16 bg-purple-50 rounded-bl-full -mr-4 -mt-4"></div>
                    <p className="text-sm text-gray-500 font-medium relative z-10">静态回收期</p>
                    <p className="text-2xl font-bold text-gray-900 mt-1 relative z-10">
                      {results.paybackPeriod.toFixed(1)} <span className="text-sm font-normal text-gray-500">年</span>
                    </p>
                    <p className="text-xs text-gray-400 mt-2">项目NPV: {(results.npv / 10000).toFixed(0)} 万元</p>
                  </div>
                  <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-16 h-16 bg-orange-50 rounded-bl-full -mr-4 -mt-4"></div>
                    <p className="text-sm text-gray-500 font-medium relative z-10">首年总收入</p>
                    <p className="text-2xl font-bold text-gray-900 mt-1 relative z-10">
                      {formatNumber(results.yearlyData[0].revenue)} <span className="text-sm font-normal text-gray-500">万元</span>
                    </p>
                    <p className="text-xs text-gray-400 mt-2">净利润: {formatNumber(results.yearlyData[0].netProfit)} 万元</p>
                  </div>
                </div>

                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-lg font-bold text-gray-800">全生命周期现金流分析</h3>
                    <div className="flex items-center gap-3 text-xs text-gray-500">
                      <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-blue-500"></span>当年净现金流</span>
                      <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-green-500"></span>年收入</span>
                      <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-purple-400"></span>净利润</span>
                    </div>
                  </div>
                  <div className="h-[350px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={results.yearlyData}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                        <XAxis dataKey="year" tickLine={false} axisLine={false} tick={{fontSize: 12, fill: '#666'}} />
                        <YAxis yAxisId="left" orientation="left" tickLine={false} axisLine={false} tick={{fontSize: 12, fill: '#666'}} label={{ value: '万元', angle: -90, position: 'insideLeft', style: {fill: '#999'} }} />
                        <YAxis yAxisId="right" orientation="right" tickLine={false} axisLine={false} hide />
                        <RechartsTooltip 
                          contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
                          formatter={(value: number) => formatNumber(value)}
                        />
                        <Bar yAxisId="left" dataKey="projectNCF" fill="#3b82f6" radius={[4, 4, 0, 0]} barSize={20} name="当年净现金流" />
                        <Line yAxisId="left" type="monotone" dataKey="revenue" stroke="#10b981" strokeWidth={2} dot={false} name="年收入" />
                        <Area yAxisId="left" type="monotone" dataKey="netProfit" fill="#8b5cf6" stroke="#8b5cf6" fillOpacity={0.1} name="净利润" />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-lg font-bold text-gray-800">首年收入构成</h3>
                      <span className="text-sm font-bold text-blue-600 bg-blue-50 px-3 py-1 rounded-lg border border-blue-100">
                        合计 {formatNumber(results.yearlyData[0].revenue)} 万元
                      </span>
                    </div>
                    <div className="space-y-4">
                      {[
                        { label: '现货套利', value: results.yearlyData[0].breakdown.spot, color: 'bg-blue-500' },
                        { label: '容量补偿', value: results.yearlyData[0].breakdown.comp, color: 'bg-purple-500' },
                        { label: '容量租赁', value: results.yearlyData[0].breakdown.lease, color: 'bg-green-500' },
                        { label: '辅助服务', value: results.yearlyData[0].breakdown.aux, color: 'bg-orange-500' },
                      ].map((item, idx) => {
                        const total = results.yearlyData[0].revenue;
                        const percent = total > 0 ? (item.value / total) * 100 : 0;
                        return (
                          <div key={idx}>
                            <div className="flex justify-between text-sm mb-1">
                              <span className="text-gray-600">{item.label}</span>
                              <span className="font-medium">{formatNumber(item.value)}万 ({percent.toFixed(1)}%)</span>
                            </div>
                            <div className="w-full bg-gray-100 rounded-full h-2">
                              <div className={`h-2 rounded-full ${item.color}`} style={{ width: `${percent}%` }}></div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                    <h3 className="text-lg font-bold text-gray-800 mb-4">财务指标校验</h3>
                    <div className="space-y-3 text-sm">
                      <div className="flex justify-between border-b border-gray-100 pb-2">
                        <span className="text-gray-500">初始总投资 (CAPEX)</span>
                        <span className="font-mono">{(results.totalInvestment / 10000).toFixed(0)} 万元</span>
                      </div>
                      <div className="flex justify-between border-b border-gray-100 pb-2">
                        <span className="text-gray-500">自有资金 (Equity)</span>
                        <span className="font-mono text-blue-600">{(results.equityAmount / 10000).toFixed(0)} 万元</span>
                      </div>
                      <div className="flex justify-between border-b border-gray-100 pb-2">
                        <span className="text-gray-500">银行贷款 (Debt)</span>
                        <span className="font-mono">{(results.debtAmount / 10000).toFixed(0)} 万元</span>
                      </div>
                      <div className="flex justify-between border-b border-gray-100 pb-2">
                        <span className="text-gray-500">全生命周期总营收</span>
                        <span className="font-mono">{(results.yearlyData.reduce((a,b)=>a+b.revenue,0)).toFixed(0)} 万元</span>
                      </div>
                      <div className="flex justify-between border-b border-gray-100 pb-2">
                        <span className="text-gray-500">全生命周期总净利</span>
                        <span className="font-mono text-green-600">{(results.yearlyData.reduce((a,b)=>a+b.netProfit,0)).toFixed(0)} 万元</span>
                      </div>
                      <div className="flex justify-between pt-2">
                        <span className="text-gray-500 font-medium">净现值 (NPV @{(params.discountRate*100).toFixed(0)}%)</span>
                        <span className="font-bold text-gray-800">{(results.npv / 10000).toFixed(0)} 万元</span>
                      </div>
                    </div>
                  </div>
                </div>
              </>
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
                      label: '首年现货收益',
                      sub: 'First-Year Spot Revenue',
                      value: formatNumber(results.yearlyData[0].breakdown.spot),
                      unit: '万元',
                      hint: `占总收入 ${((results.yearlyData[0].breakdown.spot / results.yearlyData[0].revenue)*100).toFixed(1)}%`,
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
                    <div className="bg-blue-50 border border-blue-100 rounded-md p-3 text-xs text-blue-900 mb-3 space-y-1">
                      <div className="flex justify-between"><span>当前值（{(params.spotSpreadGrowth*100).toFixed(1)}%/年）</span><span className="font-mono">第1年 {params.spotSpread.toFixed(4)} 元/kWh</span></div>
                      <div className="flex justify-between"><span>第 5 年价差</span><span className="font-mono">{(params.spotSpread * Math.pow(1+params.spotSpreadGrowth, 4)).toFixed(4)}</span></div>
                      <div className="flex justify-between"><span>第 {params.lifeSpan} 年价差</span><span className="font-mono">{(params.spotSpread * Math.pow(1+params.spotSpreadGrowth, params.lifeSpan-1)).toFixed(4)}</span></div>
                    </div>
                    <div className="grid grid-cols-2 gap-4 bg-yellow-50 p-3 rounded-md border border-yellow-100">
                      <InputField label="市场不确定系数" unit="%" step={0.01} value={params.spotMarketUncertainty} onChange={(v:any)=>setParams({...params, spotMarketUncertainty:v})} tooltip="预测偏差修正 (默认0.9)" />
                      <InputField label="交易损耗系数" unit="%" step={0.01} value={params.tradingLossFactor} onChange={(v:any)=>setParams({...params, tradingLossFactor:v})} tooltip="调度/考核损耗 (默认0.95)" />
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
                      <p className="text-xs text-gray-500">首年现货收入(修正后)</p>
                      <p className="text-xl font-bold text-blue-600 mt-1">{formatNumber(results.yearlyData[0].breakdown.spot)} <span className="text-sm font-normal text-gray-500">万元</span></p>
                      <p className="text-xs text-gray-400 mt-1">占总收入 {((results.yearlyData[0].breakdown.spot / results.yearlyData[0].revenue)*100).toFixed(1)}%</p>
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
            {activeSection === 'frequency' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <div className="lg:col-span-5 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                  <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                    <Gauge size={16} className="text-orange-600" />
                    <h3 className="font-semibold text-gray-800">调频(辅助服务)参数</h3>
                  </div>
                  <div className="p-4">
                    <InputField label="调频年收入估算" unit="万元" value={params.auxIncome} onChange={(v:any)=>setParams({...params, auxIncome:v})} tooltip="AGC调频净收益 (中标里程电量×单价×K_settle×D)" />
                    <div className="bg-yellow-50 border border-yellow-100 rounded-md p-3 text-xs text-yellow-900 mt-2">
                      调频收益受 AGC 调用频次、性能折算系数 D、Ksettle 影响较大，建议直接输入经验估算值。
                    </div>
                  </div>
                </div>
                <div className="lg:col-span-7 space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                      <p className="text-xs text-gray-500">首年调频收入</p>
                      <p className="text-xl font-bold text-orange-600 mt-1">{formatNumber(results.yearlyData[0].breakdown.aux)} <span className="text-sm font-normal text-gray-500">万元</span></p>
                      <p className="text-xs text-gray-400 mt-1">占总收入 {((results.yearlyData[0].breakdown.aux / results.yearlyData[0].revenue)*100).toFixed(1)}%</p>
                    </div>
                    <div className="bg-white p-3.5 rounded-xl shadow-sm border border-gray-100">
                      <p className="text-xs text-gray-500">全周期调频累计</p>
                      <p className="text-xl font-bold text-gray-900 mt-1">{formatNumber(results.yearlyData.reduce((a,b)=>a+b.breakdown.aux,0))} <span className="text-sm font-normal text-gray-500">万元</span></p>
                    </div>
                  </div>
                  <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                    <h3 className="text-sm font-bold text-gray-800 mb-3">逐年调频收入</h3>
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
                </div>
              </div>
            )}

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

                        <div className="mt-5 flex items-center justify-between text-[11px] text-emerald-200/60">
                          <span className="font-mono truncate">{it.hint}</span>
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
                        <div className="rounded-md bg-amber-50 border border-amber-100 p-3">
                          <div className="text-xs text-gray-500">电池更换年份（年末判定、下一年初更换）</div>
                          <div className="mt-1 text-sm font-semibold text-gray-800">
                            {replacementYears.length === 0 ? '全周期内未触发 SOH 阈值更换' : replacementYears.join('、')}
                          </div>
                        </div>
                        <div className="rounded-md bg-gray-50 border border-gray-200 p-3">
                          <div className="text-xs text-gray-500 mb-1">更换次数</div>
                          <div className="text-sm font-semibold text-gray-800 font-mono">{replacementYears.length} 次</div>
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
                                  <tr key={row.year} className={row.replaced ? 'bg-amber-50' : 'odd:bg-white even:bg-gray-50/60'}>
                                    <td className="border-b border-gray-100 px-3 py-1.5 font-mono">{row.year}</td>
                                    <td className="border-b border-gray-100 px-3 py-1.5 font-mono">{row.batteryAge}</td>
                                    <td className="border-b border-gray-100 px-3 py-1.5 font-mono">{formatPct(row.sohStart)}</td>
                                    <td className="border-b border-gray-100 px-3 py-1.5 font-mono">{formatPct(row.sohEnd)}</td>
                                    <td className="border-b border-gray-100 px-3 py-1.5">
                                      {row.replaced
                                        ? <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[11px] font-medium">是</span>
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
                {/* 数据实时展示舱 // 基础数据与参数 */}
                <div className="lg:col-span-12">
                  <div className="rounded-xl shadow-sm border border-slate-700/40 overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white relative">
                    <div className="absolute inset-0 opacity-[0.07] pointer-events-none"
                      style={{ backgroundImage: 'radial-gradient(circle at 25% 30%, #38bdf8 0, transparent 40%), radial-gradient(circle at 75% 70%, #a78bfa 0, transparent 40%)' }} />
                    <div className="px-4 py-2.5 border-b border-white/10 flex items-center gap-2 relative">
                      <div className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400"></span>
                      </div>
                      <Activity size={14} className="text-emerald-400" />
                      <h3 className="font-semibold text-sm tracking-wide">数据实时展示舱</h3>
                      <span className="text-[11px] text-slate-400 ml-1">基础数据与参数 · LIVE</span>
                      <span className="ml-auto text-[11px] text-slate-400 font-mono">{new Date().toLocaleString('zh-CN', { hour12: false })}</span>
                    </div>
                    <div className="p-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 relative">
                      {[
                        { label: '装机功率', value: params.capacityMW.toFixed(1), unit: 'MW', color: 'text-sky-400', icon: Zap },
                        { label: '系统时长', value: params.systemDuration.toFixed(1), unit: 'h', color: 'text-cyan-400', icon: Gauge },
                        { label: '装机容量', value: params.capacityMWh.toFixed(1), unit: 'MWh', color: 'text-blue-400', icon: Battery },
                        { label: '综合效率', value: (params.efficiency*100).toFixed(1), unit: '%', color: 'text-emerald-400', icon: Activity },
                        { label: '运营年限', value: params.lifeSpan.toFixed(0), unit: '年', color: 'text-amber-400', icon: BookOpen },
                        { label: '总投资', value: (results.totalInvestment/10000).toFixed(0), unit: '万元', color: 'text-fuchsia-400', icon: DollarSign },
                      ].map((m, i) => {
                        const Ic = m.icon;
                        return (
                          <div key={i} className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-lg px-3 py-2.5 hover:bg-white/10 transition-colors">
                            <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
                              <Ic size={11} className={m.color} />
                              <span>{m.label}</span>
                            </div>
                            <div className="mt-1 flex items-baseline gap-1">
                              <span className={`font-mono font-bold text-lg ${m.color}`}>{m.value}</span>
                              <span className="text-[10px] text-slate-400">{m.unit}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
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

