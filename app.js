'use strict';

// ---------- 共用數值工具 ----------
const round2 = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const clamp = (value, min, max = Infinity) => Math.min(max, Math.max(min, Number(value) || 0));
const applyCap = (value, cap) => cap === null || cap === '' || cap === undefined ? value : Math.min(value, clamp(cap, 0));
const money = value => `$${round2(value).toLocaleString('zh-TW', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const numberText = value => round2(value).toLocaleString('zh-TW', { maximumFractionDigits: 2 });

// 商品折扣：未湊成活動組數的商品維持原價。
function calculateProductDiscount(unitPrice, quantity, discount) {
  const price = clamp(unitPrice, 0);
  const qty = Math.max(1, Math.floor(clamp(quantity, 1)));
  const original = price * qty;
  let discounted = original;
  const rate = clamp(discount.rate, 0, 10) / 10;

  switch (discount.type) {
    case 'percent': discounted = original * rate; break;
    case 'bogo': discounted = Math.ceil(qty / 2) * price; break;
    case 'secondPercent': // 相容舊版紀錄：視同第 2 件優惠
    case 'nthPercent': {
      const nth = discount.type === 'secondPercent' ? 2 : Math.max(1, Math.floor(clamp(discount.itemNumber, 1)));
      const groups = Math.floor(qty / nth), remainder = qty % nth;
      discounted = groups * price * ((nth - 1) + rate) + remainder * price; break;
    }
    case 'pairPercent': {
      const pairs = Math.floor(qty / 2), remainder = qty % 2;
      discounted = pairs * price * 2 * rate + remainder * price; break;
    }
    case 'bundleFixed': {
      const size = Math.max(1, Math.floor(clamp(discount.bundleSize, 1)));
      discounted = Math.floor(qty / size) * clamp(discount.bundlePrice, 0) + (qty % size) * price; break;
    }
    case 'thresholdOff': {
      const threshold = clamp(discount.threshold, 0), off = clamp(discount.off, 0);
      const times = threshold > 0 && original >= threshold ? (discount.repeat ? Math.floor(original / threshold) : 1) : 0;
      discounted = Math.max(0, original - times * off); break;
    }
    case 'customOff': discounted = Math.max(0, original - clamp(discount.off, 0)); break;
  }
  discounted = Math.min(original, discounted);
  return { original: round2(original), discounted: round2(discounted), saving: round2(original - discounted) };
}

// 滿額活動先判斷最低門檻；instantOff 會影響實際付款，其餘屬額外回饋。
function calculateThresholdActivity(base, activity) {
  const threshold = clamp(activity.threshold, 0), reward = clamp(activity.reward, 0);
  const eligible = base >= clamp(activity.minimum, 0) && threshold > 0 && base >= threshold;
  if (!eligible || activity.type === 'none') return { discount: 0, points: 0, cash: 0, times: 0 };
  const repeatType = activity.type.startsWith('repeat') || activity.repeat;
  const times = repeatType ? Math.floor(base / threshold) : 1;
  const total = applyCap(times * reward, activity.cap);
  return {
    discount: activity.type === 'instantOff' ? round2(total) : 0,
    points: activity.type.endsWith('Points') ? round2(total) : 0,
    cash: activity.type.endsWith('Cash') ? round2(total) : 0,
    times
  };
}

// 店家點數支援「消費回饋率」與「每 X 元給 Y 點」兩種算法。
function calculateStorePoints(paid, config) {
  if (paid < clamp(config.minimum, 0)) return { base: 0, total: 0, value: 0 };
  let base;
  if (config.method === 'rate') {
    // OPENPOINT 規則：計算至小數點後 2 位，第 3 位四捨五入。
    base = round2(paid * clamp(config.rate, 0, 100) / 100);
  } else {
    const spendUnit = clamp(config.spendUnit, 0.01);
    base = round2(Math.floor(paid / spendUnit) * clamp(config.pointsUnit, 0));
  }
  const multiplier = clamp(config.multiplier, 0);
  return { base: round2(base), total: round2(base * multiplier), value: round2(base * multiplier * clamp(config.pointValue, 0)) };
}

// 信用卡回饋一律以實際付款金額計算。
function calculateCardReward(paid, card) {
  if (card.type === 'cash') {
    const cash = applyCap(paid * clamp(card.rate, 0, 100) / 100, card.cap);
    return { cash: round2(cash), points: 0, value: round2(cash) };
  }
  if (card.type === 'points') {
    const unit = clamp(card.spendUnit, 0.01);
    const points = applyCap(Math.floor(paid / unit) * clamp(card.pointsUnit, 0), card.cap);
    return { cash: 0, points: round2(points), value: round2(points * clamp(card.pointValue, 0)) };
  }
  return { cash: 0, points: 0, value: 0 };
}

function calculatePaymentReward(paid, payment) {
  if (!payment.type || payment.type === 'none' || paid < clamp(payment.minimum,0)) return 0;
  return round2(applyCap(paid * clamp(payment.rate, 0, 100) / 100, payment.cap));
}

// 統一依規格順序彙總所有優惠。
function calculateAll(data) {
  const product = calculateProductDiscount(data.unitPrice, data.quantity, data.discount);
  const threshold = calculateThresholdActivity(product.discounted, data.threshold);
  threshold.discount = Math.min(product.discounted, threshold.discount);
  const paid = round2(Math.max(0, product.discounted - threshold.discount));
  const store = calculateStorePoints(paid, data.storePoints);
  const thresholdPointValue = round2(threshold.points * clamp(data.threshold.pointValue, 0));
  const card = calculateCardReward(paid, data.card);
  const payment = calculatePaymentReward(paid, data.payment);
  const thresholdValue = round2(thresholdPointValue + threshold.cash);
  const totalReward = round2(product.saving + threshold.discount + store.value + thresholdValue + card.value + payment);
  const effectiveCost = round2(product.original - totalReward);
  const rewardRate = product.original ? round2(totalReward / product.original * 100) : 0;
  const effectiveDiscount = product.original ? round2(effectiveCost / product.original * 10) : 0;
  return { product, threshold, paid, store, thresholdValue, card, payment, totalReward, effectiveCost, rewardRate, effectiveDiscount };
}

// ---------- 畫面控制 ----------
function field(id, fallback = '') { const el = document.getElementById(id); return el ? el.value : fallback; }
function nullableNumber(id) { const value = field(id).trim(); return value === '' ? null : clamp(value, 0); }

function renderDiscountFields() {
  const type = field('discountType');
  const box = document.getElementById('discountFields');
  const rate = '<label>折數（例如 5 代表 5 折）<input id="discountRate" type="number" min="0" max="10" step="0.01" value="5" inputmode="decimal"></label>';
  const map = {
    percent: rate, pairPercent: rate,
    nthPercent: '<label>第幾件 X<input id="discountItemNumber" type="number" min="1" step="1" value="2" inputmode="numeric"></label><label>該件折數 Y（例如 5 代表 5 折）<input id="discountRate" type="number" min="0" max="10" step="0.01" value="5" inputmode="decimal"></label>',
    bundleFixed: '<label>活動件數 X<input id="bundleSize" type="number" min="1" step="1" value="3"></label><label>X 件固定價格（元）<input id="bundlePrice" type="number" min="0" step="0.01" value="999"></label>',
    thresholdOff: '<label>每滿金額（元）<input id="productThreshold" type="number" min="0.01" step="0.01" value="1000"></label><label>折抵金額（元）<input id="productOff" type="number" min="0" step="0.01" value="100"></label><label>是否累折<select id="productRepeat"><option value="no">否</option><option value="yes">是</option></select></label>',
    customOff: '<label>自訂折扣金額（元）<input id="productOff" type="number" min="0" step="0.01" value="100"></label>'
  };
  box.innerHTML = map[type] || '';
}

function renderCardFields() {
  const type = field('cardType'), box = document.getElementById('cardFields');
  if (type === 'cash') box.innerHTML = '<label>現金回饋（%）<input id="cardRate" type="number" min="0" max="100" step="0.01" value="5"></label><label>回饋上限（元，留空＝無）<input id="cardCap" type="number" min="0" step="0.01" placeholder="無上限"></label>';
  else if (type === 'points') box.innerHTML = '<label>每多少元獲得點數<input id="cardSpendUnit" type="number" min="0.01" step="0.01" value="20"></label><label>每單位獲得幾點<input id="cardPointsUnit" type="number" min="0" step="0.01" value="1"></label><label>1 點價值（元）<input id="cardPointValue" type="number" min="0" step="0.01" value="0.5"></label><label>點數上限（留空＝無）<input id="cardCap" type="number" min="0" step="0.01" placeholder="無上限"></label>';
  else box.innerHTML = '';
}

function readForm() {
  return {
    unitPrice: clamp(field('unitPrice'), 0), quantity: Math.max(1, Math.floor(clamp(field('quantity'), 1))),
    discount: { type: field('discountType'), rate: field('discountRate'), itemNumber: field('discountItemNumber'), bundleSize: field('bundleSize'), bundlePrice: field('bundlePrice'), threshold: field('productThreshold'), off: field('productOff'), repeat: field('productRepeat') === 'yes' },
    storePoints: { system: field('pointSystem'), method: field('storePointMethod'), rate: field('storeRate'), spendUnit: field('storeSpendUnit'), pointsUnit: field('storePointsUnit'), minimum: field('storeMinimum'), multiplier: field('storeMultiplier'), mode: field('multiplierMode'), pointValue: field('storePointValue') },
    threshold: { type: field('thresholdType'), threshold: field('thresholdAmount'), reward: field('thresholdReward'), repeat: field('thresholdRepeat') === 'yes', cap: nullableNumber('thresholdCap'), minimum: field('thresholdMinimum'), pointValue: field('thresholdPointValue') },
    card: { type: field('cardType'), rate: field('cardRate'), cap: nullableNumber('cardCap'), spendUnit: field('cardSpendUnit'), pointsUnit: field('cardPointsUnit'), pointValue: field('cardPointValue') },
    payment: { type: field('paymentType'), rate: field('paymentRate'), minimum: field('paymentMinimum'), cap: nullableNumber('paymentCap') }
  };
}

function validateForm() {
  let valid = true;
  document.querySelectorAll('input[type="number"]').forEach(input => {
    const value = input.value === '' ? null : Number(input.value);
    const bad = (input.required && value === null) || (value !== null && (!Number.isFinite(value) || value < Number(input.min || -Infinity) || value > Number(input.max || Infinity)));
    input.classList.toggle('invalid', bad); if (bad) valid = false;
  });
  const error = document.getElementById('formError');
  error.hidden = valid; error.textContent = valid ? '' : '請修正標示的欄位：金額不可為負數，百分比須介於 0～100。';
  return valid;
}

function addResult(label, value, className = '') { return `<div class="${className}"><dt>${label}</dt><dd>${value}</dd></div>`; }

function renderResults(result, data) {
  document.getElementById('effectiveCost').textContent = `等效成本 ${money(result.effectiveCost)}`;
  document.getElementById('effectiveDiscount').textContent = `約 ${numberText(result.effectiveDiscount)} 折`;
  document.getElementById('totalSaved').textContent = `總共省 ${money(result.totalReward)}`;
  document.getElementById('rewardRate').textContent = `總回饋率 ${numberText(result.rewardRate)}%`;
  document.getElementById('resultList').innerHTML =
    addResult('原始總價', money(result.product.original)) + addResult('商品折扣', `-${money(result.product.saving)}`) +
    addResult('滿額折扣', `-${money(result.threshold.discount)}`) + addResult('實際付款', money(result.paid)) +
    addResult('店家點數', `${numberText(result.store.total)} 點<small>價值 ${money(result.store.value)}</small>`) +
    addResult('滿額活動', `${result.threshold.points ? numberText(result.threshold.points) + ' 點 · ' : ''}價值 ${money(result.thresholdValue)}`) +
    addResult('信用卡回饋', result.card.points ? `${numberText(result.card.points)} 點<small>價值 ${money(result.card.value)}</small>` : money(result.card.value)) +
    addResult('支付回饋', money(result.payment)) + addResult('總回饋價值', money(result.totalReward), 'total-row') +
    addResult('等效成本', money(result.effectiveCost), 'total-row');

  const baseRuleText = data.storePoints.method === 'rate' ? `${money(result.paid)} × ${numberText(data.storePoints.rate)}%` : `每 ${numberText(data.storePoints.spendUnit)} 元給 ${numberText(data.storePoints.pointsUnit)} 點`;
  const multiplierText = data.storePoints.mode === 'extra' ? `${baseRuleText}，基礎 ${numberText(result.store.base)} 點＋額外 ${numberText(result.store.total - result.store.base)} 點` : `${baseRuleText}＝${numberText(result.store.base)} 點，再 × ${numberText(data.storePoints.multiplier)}`;
  const cardText = data.card.type === 'cash' ? `${money(result.paid)} × ${numberText(data.card.rate)}%（套用上限後）＝ ${money(result.card.value)}` : data.card.type === 'points' ? `每 ${numberText(data.card.spendUnit)} 元給 ${numberText(data.card.pointsUnit)} 點，共 ${numberText(result.card.points)} 點，價值 ${money(result.card.value)}` : '未使用信用卡回饋';
  const thresholdText = result.threshold.times ? `達成 ${result.threshold.times} 次，折抵 ${money(result.threshold.discount)}、額外回饋價值 ${money(result.thresholdValue)}` : '未達門檻或未設定活動';
  document.getElementById('breakdown').innerHTML = [
    `原價 ${money(data.unitPrice)} × ${data.quantity} 件＝${money(result.product.original)}`,
    `商品活動折省 ${money(result.product.saving)}，折後為 ${money(result.product.discounted)}`,
    `滿額活動：${thresholdText}`,
    `實際付款＝${money(result.product.discounted)}－${money(result.threshold.discount)}＝${money(result.paid)}`,
    `${data.storePoints.system || '店家點數'}：${multiplierText}＝${numberText(result.store.total)} 點，價值 ${money(result.store.value)}`,
    `信用卡：${cardText}`,
    `行動支付：${money(result.paid)} × ${numberText(data.payment.rate)}%（套用上限後）＝${money(result.payment)}`,
    `總回饋＝商品折扣＋滿額折扣＋各項回饋＝${money(result.totalReward)}`,
    `等效成本＝${money(result.product.original)}－${money(result.totalReward)}＝${money(result.effectiveCost)}`
  ].map(text => `<li>${text}</li>`).join('');
}

function loadExample() {
  const values = { unitPrice:1000, quantity:2, discountType:'percent', store:'cosmed', storeMultiplier:1, multiplierMode:'total', thresholdType:'instantOff', thresholdAmount:1500, thresholdReward:100, thresholdRepeat:'no', thresholdMinimum:0, thresholdPointValue:1, cardType:'cash', paymentType:'LINE Pay', paymentRate:2 };
  Object.entries(values).forEach(([id,value]) => { const el=document.getElementById(id); if(el) el.value=value; });
  applyStorePreset();
  renderDiscountFields(); document.getElementById('discountRate').value=8;
  renderCardFields(); document.getElementById('cardRate').value=5; document.getElementById('cardCap').value=200;
  document.getElementById('paymentCap').value=100;
  submitCalculation();
}

const RULES_STORAGE_KEY = 'discount-calculator-rules-v2';
const PROMOTIONS = [
  {id:'cosmed-easycard-mon',storeId:'cosmed',title:'週一嗶悠遊卡／悠遊聯名卡滿額券',start:'2026-07-01',end:'2026-12-31',weekdays:[1],provider:'悠遊卡',payment:'悠遊卡',kind:'coupon',threshold:299,value:30,repeat:true,cap:60,rewardText:'每滿 $299 送 $30',note:'每日每卡限一次；折價券下次消費使用。'},
  {id:'cosmed-ctbc-tue',storeId:'cosmed',title:'中信卡週二滿額券',start:'2026-07-01',end:'2026-12-31',weekdays:[2],provider:'中國信託',payment:'實體信用卡',kind:'coupon',threshold:988,value:100,repeat:true,cap:200,rewardText:'每滿 $988 送 $100',note:'排除第三方支付；每日每卡限一次。'},
  {id:'cosmed-ubot-wed',storeId:'cosmed',title:'聯邦信用卡週三滿額券',start:'2026-07-01',end:'2026-12-31',weekdays:[3],provider:'聯邦銀行',payment:'實體信用卡',kind:'coupon',threshold:988,value:100,repeat:true,cap:200,rewardText:'每滿 $988 送 $100',note:'排除第三方支付；每日每卡限一次。'},
  {id:'cosmed-first-thu',storeId:'cosmed',title:'一銀卡週四滿額券',start:'2026-07-01',end:'2026-12-31',weekdays:[4],provider:'第一銀行',payment:'實體信用卡',kind:'coupon',threshold:988,value:100,repeat:false,cap:100,rewardText:'滿 $988 送 $100',note:'排除第三方支付；每日每卡限一次。'},
  {id:'cosmed-esun-fri',storeId:'cosmed',title:'玉山信用卡週五滿額券',start:'2026-07-01',end:'2026-12-31',weekdays:[5],provider:'玉山銀行',payment:'實體信用卡',kind:'coupon',threshold:988,value:100,repeat:false,cap:100,rewardText:'滿 $988 送 $100',note:'可搭配符合資格的 Unicard 回饋。'},
  {id:'cosmed-cathay-sat',storeId:'cosmed',title:'國泰世華週六滿額券',start:'2026-07-01',end:'2026-12-31',weekdays:[6],provider:'國泰世華',payment:'實體信用卡',kind:'coupon',threshold:988,value:100,repeat:false,cap:100,rewardText:'滿 $988 送 $100',note:'可搭配 CUBE 卡符合資格方案。'},
  {id:'cosmed-ctbc-sun',storeId:'cosmed',title:'uniopen 聯名卡週日滿額券',start:'2026-07-01',end:'2026-12-31',weekdays:[0],provider:'中國信託',payment:'實體信用卡',kind:'coupon',threshold:988,value:120,repeat:false,cap:120,rewardText:'滿 $988 送 $120',note:'限 uniopen 聯名卡；排除第三方支付。'},
  {id:'cosmed-cube-daily',storeId:'cosmed',title:'CUBE 卡樂饗購方案',start:null,end:null,weekdays:null,provider:'國泰世華 CUBE',payment:'實體信用卡',kind:'cardRate',value:2,rewardText:'2%～3.3% 小樹點',note:'依會員等級；目前安全預設套用 2%，排除第三方支付。'},
  {id:'cosmed-icash-mon',storeId:'cosmed',title:'icash Pay 週一不限金額回饋',start:'2026-07-01',end:'2026-12-31',weekdays:[1],provider:'icash Pay',payment:'icash Pay',kind:'paymentRate',value:5,rewardText:'5% OPENPOINT',note:'每戶每月上限 200 點，須自行確認剩餘額度。'},
  {id:'cosmed-icash-double',storeId:'cosmed',title:'icash Pay 月月雙喜日',start:'2026-07-01',end:'2026-12-31',days:[11,22],provider:'icash Pay',payment:'icash Pay',kind:'points',threshold:1111,value:100,repeat:false,cap:100,rewardText:'滿 $1,111 送 100 點',note:'限每月 11、22 日；每戶每日上限 200 點。'},
  {id:'seven-pickup-max20',storeId:'7-eleven',title:'行動隨時取綁指定銀行卡',start:'2026-07-01',end:'2026-09-30',provider:'行動隨時取',payment:'行動隨時取',kind:'paymentRate',value:20,rewardText:'最高 20% OPENPOINT',note:'指定銀行、組成與門檻尚待確認，不直接帶入計算。',infoOnly:true},
  {id:'seven-openwallet-300',storeId:'7-eleven',title:'OPEN錢包綁中信／國泰／玉山卡',start:'2026-07-01',end:'2026-09-30',provider:'OPEN錢包',payment:'OPEN錢包',kind:'paymentRate',threshold:300,value:10,rewardText:'滿 $300 回饋 10%',note:'各銀行每月上限 60～80 點；2026 年 8 月名額已額滿。',unavailableMonths:['2026-08']},
  {id:'seven-openwallet-200',storeId:'7-eleven',title:'OPEN錢包綁北富銀／兆豐卡',start:'2026-07-01',end:'2026-09-30',provider:'OPEN錢包',payment:'OPEN錢包',kind:'paymentRate',threshold:200,value:10,rewardText:'滿 $200 回饋 10%',note:'每戶每月上限 50 點；2026 年 8 月名額已額滿。',unavailableMonths:['2026-08']},
  {id:'seven-openwallet-ubot',storeId:'7-eleven',title:'OPEN錢包綁聯邦卡',start:'2026-07-01',end:'2026-09-30',provider:'OPEN錢包',payment:'OPEN錢包',kind:'paymentRate',threshold:100,value:10,rewardText:'滿 $100 回饋 10%',note:'每戶每月上限 100 點；2026 年 8 月名額已額滿。',unavailableMonths:['2026-08']},
  {id:'seven-openwallet-line100',storeId:'7-eleven',title:'OPEN錢包綁 LINE Bank 卡',start:'2026-07-01',end:'2026-09-30',provider:'OPEN錢包',payment:'OPEN錢包',kind:'points',threshold:100,value:10,repeat:false,cap:10,rewardText:'滿 $100 送 10 點',note:'不累贈；每戶每月上限 30 點。'},
  {id:'seven-openwallet-line300',storeId:'7-eleven',title:'OPEN錢包綁 LINE Bank 卡活動二',start:'2026-07-01',end:'2026-09-30',provider:'OPEN錢包',payment:'OPEN錢包',kind:'points',threshold:300,value:50,repeat:false,cap:50,rewardText:'滿 $300 送 50 點',note:'累贈規則待確認；2026 年 8 月名額已額滿。',unavailableMonths:['2026-08']},
  {id:'seven-icash2-tcb3',storeId:'7-eleven',title:'合庫指定 icash 聯名卡',start:'2026-07-01',end:'2026-12-31',provider:'icash2.0',payment:'icash2.0',kind:'paymentRate',value:3,rewardText:'3% OPENPOINT',note:'當期帳單消費門檻待確認，不直接帶入計算。',infoOnly:true},
  {id:'seven-icash2-uniauto10',storeId:'7-eleven',title:'uniopen 聯名卡 icash 自動加值',start:'2026-07-01',end:'2026-12-31',provider:'icash2.0',payment:'icash2.0',kind:'paymentRate',value:10,rewardText:'10% OPENPOINT',note:'須每月登錄且限自動加值；每戶每月上限 50 點。'},
  {id:'seven-icashpay-bank10',storeId:'7-eleven',title:'icash Pay 綁指定銀行／帳戶',start:'2026-07-01',end:'2026-12-31',provider:'icash Pay',payment:'icash Pay',kind:'paymentRate',threshold:150,value:10,rewardText:'滿 $150 回饋 10%',note:'國泰、元大、滙豐、兆豐、一銀、合庫、陽信或台中銀行；每戶每月上限 100 點。'},
  {id:'seven-icashpay-uni4',storeId:'7-eleven',title:'icash Pay 綁中信 uniopen 聯名卡',start:'2026-07-01',end:'2026-08-31',provider:'icash Pay',payment:'icash Pay',kind:'paymentRate',threshold:199,value:4,rewardText:'滿 $199 加碼 4%',note:'每戶每月上限 150 點；最高 11% 尚含其他條件。'},
  {id:'seven-ctbc-max11',storeId:'7-eleven',title:'中信 uniopen 聯名卡組合活動',start:'2026-08-01',end:'2026-08-31',provider:'中國信託',payment:'icash Pay',kind:'paymentRate',value:11,rewardText:'最高 11% OPENPOINT',note:'含一般、統一加碼、踩點任務與 icash Pay 加碼，資格待確認。',infoOnly:true},
  {id:'seven-jcb-easy10',storeId:'7-eleven',title:'JCB 悠遊聯名晶緻卡自動加值',start:'2026-01-01',end:'2026-12-31',provider:'悠遊卡',payment:'悠遊卡',kind:'paymentRate',value:10,rewardText:'10% 現金回饋',note:'限自動加值，每卡每月上限 $50；計算基準待確認。',infoOnly:true},
  {id:'seven-pi-discount100',storeId:'7-eleven',title:'Pi 拍錢包指定銀行卡立折',start:'2026-08-19',end:'2026-08-23',provider:'Pi 拍錢包',payment:'Pi 拍錢包',kind:'instantDiscount',threshold:1111,value:100,repeat:false,cap:100,rewardText:'滿 $1,111 立折 $100',note:'玉山、台新、聯邦或中信卡；每戶限一次。'},
  {id:'seven-pi-allme3',storeId:'7-eleven',title:'Pi 拍錢包綁中信 ALL ME 卡',start:'2026-08-01',end:'2026-12-31',provider:'Pi 拍錢包',payment:'Pi 拍錢包',kind:'paymentRate',value:3,rewardText:'最高 3% 中信點',note:'每戶每月上限 300 點；實際回饋組成待確認，安全預設 3%。'},
  {id:'seven-easypay4',storeId:'7-eleven',title:'悠遊付筆筆回饋',start:'2026-07-01',end:'2026-09-30',provider:'悠遊付',payment:'悠遊付',kind:'paymentRate',value:4,rewardText:'筆筆 4% 回饋金',note:'每戶每月上限 $1,000；最高 12% 另含月級挑戰。'}
];
const DEFAULT_RULES = {
  stores: [
    { id:'cosmed', name:'康是美', icon:'康', system:'OPENPOINT', method:'rate', rate:.33, spendUnit:1, pointsUnit:1, minimum:2, pointValue:1, note:'一般會員實付滿 2 元起，回饋 0.33%。' },
    { id:'7-eleven', name:'7-ELEVEN', icon:'7', system:'OPENPOINT', method:'rate', rate:.33, spendUnit:1, pointsUnit:1, minimum:2, pointValue:1, note:'OPENPOINT 實付滿 2 元起，回饋 0.33%。' },
    { id:'family', name:'全家', icon:'全', system:'全家會員點數', method:'unit', rate:0, spendUnit:1, pointsUnit:1, minimum:1, pointValue:1/300, note:'預設為每 1 元 1 點、300 點折 1 元，可在後台調整。' },
    { id:'watsons', name:'屈臣氏', icon:'屈', system:'自訂點數', method:'unit', rate:0, spendUnit:1, pointsUnit:0, minimum:0, pointValue:1, note:'尚未設定官方規則，請由規則管理維護。' },
    { id:'poya', name:'寶雅', icon:'寶', system:'自訂點數', method:'unit', rate:0, spendUnit:1, pointsUnit:0, minimum:0, pointValue:1, note:'尚未設定官方規則，請由規則管理維護。' },
    { id:'pxmart', name:'全聯', icon:'聯', system:'自訂點數', method:'unit', rate:0, spendUnit:1, pointsUnit:0, minimum:0, pointValue:1, note:'尚未設定官方規則，請由規則管理維護。' },
    { id:'momo', name:'momo', icon:'m', system:'自訂點數', method:'unit', rate:0, spendUnit:1, pointsUnit:0, minimum:0, pointValue:1, note:'尚未設定官方規則，請由規則管理維護。' },
    { id:'shopee', name:'蝦皮', icon:'蝦', system:'自訂點數', method:'unit', rate:0, spendUnit:1, pointsUnit:0, minimum:0, pointValue:1, note:'尚未設定官方規則，請由規則管理維護。' },
    { id:'other', name:'其他', icon:'其', system:'自訂點數', method:'unit', rate:0, spendUnit:1, pointsUnit:0, minimum:0, pointValue:1, note:'可展開進階設定自行輸入。' }
  ],
  cards: [
    { id:'cube', bank:'國泰世華', name:'CUBE 卡', icon:'CUBE', color:'#176b5b', rate:0, cap:null, storeId:'', storeRate:null },
    { id:'unicard', bank:'玉山銀行', name:'Unicard', icon:'玉山', color:'#008d83', rate:0, cap:null, storeId:'', storeRate:null },
    { id:'richart', bank:'台新銀行', name:'Richart 卡', icon:'R', color:'#e6427a', rate:0, cap:null, storeId:'', storeRate:null }
  ]
};
let rules = loadRules();
let selectedCardId = 'none';

function cloneDefaults() { return JSON.parse(JSON.stringify(DEFAULT_RULES)); }
function loadRules() { if (typeof localStorage === 'undefined') return cloneDefaults(); try { const saved=JSON.parse(localStorage.getItem(RULES_STORAGE_KEY)); return saved?.stores?.length && saved?.cards ? saved : cloneDefaults(); } catch(error) { return cloneDefaults(); } }
function saveRules() { if (typeof localStorage !== 'undefined') localStorage.setItem(RULES_STORAGE_KEY,JSON.stringify(rules)); }

function updateStoreMethodFields() {
  const isRate = field('storePointMethod') === 'rate';
  document.getElementById('storeRateLabel').classList.toggle('is-hidden', !isRate);
  document.getElementById('storeSpendUnitLabel').classList.toggle('is-hidden', isRate);
  document.getElementById('storePointsUnitLabel').classList.toggle('is-hidden', isRate);
}

// 選擇已知店家時自動帶入點數制度；其他店家仍可自由修改。
function applyStorePreset() {
  const preset = rules.stores.find(item => item.id === field('store'));
  if (preset) {
    document.getElementById('pointSystem').value = preset.system;
    document.getElementById('storePointMethod').value = preset.method;
    document.getElementById('storeRate').value = preset.rate;
    document.getElementById('storeSpendUnit').value = preset.spendUnit;
    document.getElementById('storePointsUnit').value = preset.pointsUnit;
    document.getElementById('storeMinimum').value = preset.minimum;
    document.getElementById('storePointValue').value = preset.pointValue;
    document.getElementById('storeMultiplier').value = 1;
    document.getElementById('storeRuleNote').textContent = preset.note;
    const ruleText = preset.method === 'rate' ? `基本回饋 ${numberText(preset.rate)}%` : `每 ${numberText(preset.spendUnit)} 元 ${numberText(preset.pointsUnit)} 點`;
    const pointValueText=Number(preset.pointValue)<.01 ? `$${Number(preset.pointValue).toFixed(4)}` : money(preset.pointValue);
    document.getElementById('storePresetSummary').innerHTML = `<strong>${escapeHtml(preset.system)}</strong> · ${ruleText} · 1 點＝${pointValueText}`;
  } else {
    document.getElementById('pointSystem').value = '自訂點數';
    document.getElementById('storePointMethod').value = 'unit';
    document.getElementById('storeSpendUnit').value = 1;
    document.getElementById('storePointsUnit').value = 1;
    document.getElementById('storeMinimum').value = 0;
    document.getElementById('storePointValue').value = 1;
    document.getElementById('storeMultiplier').value = 1;
    document.getElementById('storeRuleNote').textContent = '可自行設定店家點數規則。';
  }
  updateStoreMethodFields(); updateMultiplierButtons(); renderCardPresets();
}

function renderStoreOptions() {
  const options = rules.stores.map(store => `<option value="${store.id}">${escapeHtml(store.name)}</option>`).join('');
  ['store','adminStoreSelect','adminCardStore'].forEach(id => {
    const select=document.getElementById(id), previous=select.value;
    select.innerHTML = id === 'adminCardStore' ? `<option value="">無指定店家</option>${options}` : options;
    if ([...select.options].some(option => option.value === previous)) select.value=previous;
  });
}

function updateMultiplierButtons() {
  const value=Number(field('storeMultiplier'));
  document.querySelectorAll('[data-multiplier]').forEach(button => button.classList.toggle('active', Number(button.dataset.multiplier) === value || (button.dataset.multiplier === 'custom' && ![1,2,5,10,30].includes(value))));
}

function effectiveCardRate(card, storeId) { return card.storeId === storeId && card.storeRate !== null && card.storeRate !== '' ? clamp(card.storeRate,0,100) : clamp(card.rate,0,100); }

function renderCardPresets() {
  const storeId=field('store');
  const none=`<button type="button" class="card-preset ${selectedCardId==='none'?'active':''}" data-card-id="none"><span class="card-icon" style="--card-color:#8a949c">無</span><strong>不使用信用卡</strong><small>0% 回饋</small></button>`;
  document.getElementById('cardPresetGrid').innerHTML = none + rules.cards.map(card => {
    const rate=effectiveCardRate(card,storeId), matched=card.storeId===storeId && card.storeRate!==null && card.storeRate!=='';
    return `<button type="button" class="card-preset ${selectedCardId===card.id?'active':''}" data-card-id="${card.id}"><span class="card-icon" style="--card-color:${card.color}">${escapeHtml(card.icon)}</span><strong>${escapeHtml(card.name)}</strong><small>${escapeHtml(card.bank)} · ${numberText(rate)}%${matched?' 店家加碼':''}</small></button>`;
  }).join('');
  const card=rules.cards.find(item=>item.id===selectedCardId);
  document.getElementById('selectedCardSummary').innerHTML=card ? `<strong>${escapeHtml(card.bank)} ${escapeHtml(card.name)}</strong> · 本次自動套用 ${numberText(effectiveCardRate(card,storeId))}%${card.cap!==null&&card.cap!==''?`，上限 ${money(card.cap)}`:''}` : '未使用信用卡回饋';
}

function selectCard(cardId) {
  selectedCardId=cardId;
  const card=rules.cards.find(item=>item.id===cardId);
  document.getElementById('cardType').value=card?'cash':'none';
  renderCardFields();
  if(card){ document.getElementById('cardRate').value=effectiveCardRate(card,field('store')); document.getElementById('cardCap').value=card.cap??''; }
  renderCardPresets(); submitCalculation();
}

function promotionMatchesDate(promotion,dateValue) {
  if(!dateValue)return false; const date=new Date(`${dateValue}T12:00:00`),time=date.getTime();
  if(promotion.start&&time<new Date(`${promotion.start}T00:00:00`).getTime())return false;
  if(promotion.end&&time>new Date(`${promotion.end}T23:59:59`).getTime())return false;
  if(promotion.weekdays&&!promotion.weekdays.includes(date.getDay()))return false;
  if(promotion.days&&!promotion.days.includes(date.getDate()))return false;
  return true;
}

function promotionEstimatedValue(promotion,paid) {
  if(paid<(promotion.threshold||0))return 0;
  if(promotion.kind==='paymentRate'||promotion.kind==='cardRate')return round2(paid*promotion.value/100);
  const times=promotion.repeat?Math.floor(paid/promotion.threshold):1;
  return round2(applyCap(times*promotion.value,promotion.cap));
}

function promotionUnavailable(promotion,dateValue) { return Boolean(promotion.unavailableMonths?.includes(String(dateValue).slice(0,7))); }

function renderPromotionRecommendations() {
  const container=document.getElementById('promotionRecommendations'); if(!container)return;
  const date=field('purchaseDate'),storeId=field('store');
  const paid=currentCalculation?.paid ?? round2(clamp(field('unitPrice'),0)*Math.max(1,Math.floor(clamp(field('quantity'),1))));
  const matches=PROMOTIONS.filter(promotion=>promotion.storeId===storeId&&promotionMatchesDate(promotion,date)).sort((a,b)=>Number(promotionUnavailable(a,date)||a.infoOnly)-Number(promotionUnavailable(b,date)||b.infoOnly)||promotionEstimatedValue(b,paid)-promotionEstimatedValue(a,paid));
  if(!matches.length){ container.innerHTML='<div class="promotion-empty">這個日期尚無已收錄的優惠。你仍可使用下方自訂欄位。</div>'; return; }
  container.innerHTML=matches.map((promotion,index)=>{
    const unavailable=promotionUnavailable(promotion,date),estimated=unavailable||promotion.infoOnly?0:promotionEstimatedValue(promotion,paid),meets=!promotion.threshold||paid>=promotion.threshold;
    const disabled=unavailable||promotion.infoOnly;
    return `<article class="promotion-item ${index===0&&!disabled?'recommended':''} ${unavailable?'unavailable':''}"><div class="promotion-top"><div><span class="promotion-provider">${escapeHtml(promotion.provider)}</span><h3>${escapeHtml(promotion.title)}</h3></div><div class="promotion-reward">${escapeHtml(promotion.rewardText)}</div></div><div class="promotion-meta"><span>${escapeHtml(promotion.payment)}</span><span>${promotion.start?`${promotion.start}～${promotion.end}`:'每日適用'}</span>${unavailable?'<span class="quota-full">本月額滿</span>':''}${promotion.infoOnly?'<span>資格待確認</span>':''}${promotion.threshold?`<span>${meets?'已達門檻':'差 '+money(promotion.threshold-paid)}</span>`:''}</div><div class="promotion-actions"><small>${escapeHtml(promotion.note)}${estimated?` 預估價值 ${money(estimated)}`:''}</small><button type="button" class="apply-promotion" data-promotion-id="${promotion.id}" ${disabled?'disabled':''}>${unavailable?'本月已額滿':promotion.infoOnly?'條件待確認':'一鍵套用'}</button></div></article>`;
  }).join('');
}

function applyPromotion(promotionId) {
  const promotion=PROMOTIONS.find(item=>item.id===promotionId); if(!promotion)return;
  // 一鍵套用以單一方案為準，先清除上一個推薦方案，避免不同支付工具被錯誤疊加。
  document.getElementById('thresholdType').value='none'; document.getElementById('thresholdAmount').value=0; document.getElementById('thresholdReward').value=0; document.getElementById('thresholdCap').value=''; document.getElementById('thresholdMinimum').value=0;
  document.getElementById('paymentType').value='none'; document.getElementById('paymentRate').value=0; document.getElementById('paymentMinimum').value=0; document.getElementById('paymentCap').value=''; selectCard('none');
  if(promotion.kind==='coupon'||promotion.kind==='points'||promotion.kind==='instantDiscount'){
    document.getElementById('thresholdType').value=promotion.kind==='points'?'oncePoints':promotion.kind==='instantDiscount'?'instantOff':(promotion.repeat?'repeatCash':'onceCash');
    document.getElementById('thresholdAmount').value=promotion.threshold; document.getElementById('thresholdReward').value=promotion.value;
    document.getElementById('thresholdRepeat').value=promotion.repeat?'yes':'no'; document.getElementById('thresholdCap').value=promotion.cap??''; document.getElementById('thresholdMinimum').value=promotion.threshold; document.getElementById('thresholdPointValue').value=1;
  }
  document.getElementById('paymentType').value=promotion.payment;
  if(promotion.kind==='paymentRate'){ document.getElementById('paymentRate').value=promotion.value; document.getElementById('paymentMinimum').value=promotion.threshold||0; document.getElementById('paymentCap').value=''; }
  else { document.getElementById('paymentRate').value=0; }
  const matchingCard=promotion.provider.includes('國泰')?rules.cards.find(card=>card.id==='cube'):promotion.provider.includes('玉山')?rules.cards.find(card=>card.id==='unicard'):null;
  if(promotion.kind==='cardRate'&&matchingCard){ selectCard(matchingCard.id); document.getElementById('cardRate').value=promotion.value; document.getElementById('selectedCardSummary').innerHTML=`<strong>${escapeHtml(matchingCard.bank)} ${escapeHtml(matchingCard.name)}</strong> · 已套用安全預設 ${numberText(promotion.value)}%`; }
  else if(matchingCard)selectCard(matchingCard.id);
  submitCalculation(); renderPromotionRecommendations();
  showRecordMessage(`已套用「${promotion.title}」，請確認名額與排除條件。`);
  document.getElementById('results').scrollIntoView({behavior:'smooth',block:'start'});
}

function refreshAdminSelects() {
  renderStoreOptions();
  const cardSelect=document.getElementById('adminCardSelect'), previous=cardSelect.value;
  cardSelect.innerHTML=rules.cards.map(card=>`<option value="${card.id}">${escapeHtml(card.bank)}｜${escapeHtml(card.name)}</option>`).join('');
  if(rules.cards.some(card=>card.id===previous)) cardSelect.value=previous;
  loadStoreAdminForm(); loadCardAdminForm();
}

function loadStoreAdminForm() {
  const store=rules.stores.find(item=>item.id===field('adminStoreSelect')) || rules.stores[0]; if(!store)return;
  const values={adminStoreName:store.name,adminStoreIcon:store.icon,adminPointSystem:store.system,adminStoreMethod:store.method,adminStoreRate:store.rate,adminSpendUnit:store.spendUnit,adminPointsUnit:store.pointsUnit,adminStoreMinimum:store.minimum,adminStorePointValue:store.pointValue};
  Object.entries(values).forEach(([id,value])=>document.getElementById(id).value=value);
}

function saveStoreAdminForm(event) {
  event.preventDefault(); const store=rules.stores.find(item=>item.id===field('adminStoreSelect')); if(!store)return;
  Object.assign(store,{name:field('adminStoreName').trim(),icon:field('adminStoreIcon').trim()||'店',system:field('adminPointSystem').trim()||'自訂點數',method:field('adminStoreMethod'),rate:clamp(field('adminStoreRate'),0,100),spendUnit:clamp(field('adminSpendUnit'),.01),pointsUnit:clamp(field('adminPointsUnit'),0),minimum:clamp(field('adminStoreMinimum'),0),pointValue:clamp(field('adminStorePointValue'),0),note:'由規則管理設定。'});
  saveRules(); refreshAdminSelects(); applyStorePreset(); alert('店家規則已儲存並套用。');
}

function loadCardAdminForm() {
  const card=rules.cards.find(item=>item.id===field('adminCardSelect')) || rules.cards[0];
  if(!card){ ['adminCardBank','adminCardName','adminCardIcon','adminCardRate','adminCardCap','adminCardStore','adminCardStoreRate'].forEach(id=>document.getElementById(id).value=''); return; }
  const values={adminCardBank:card.bank,adminCardName:card.name,adminCardIcon:card.icon,adminCardColor:card.color,adminCardRate:card.rate,adminCardCap:card.cap??'',adminCardStore:card.storeId||'',adminCardStoreRate:card.storeRate??''};
  Object.entries(values).forEach(([id,value])=>document.getElementById(id).value=value);
}

function saveCardAdminForm(event) {
  event.preventDefault(); let card=rules.cards.find(item=>item.id===field('adminCardSelect'));
  if(!card){ card={id:`card-${Date.now()}`}; rules.cards.push(card); }
  Object.assign(card,{bank:field('adminCardBank').trim(),name:field('adminCardName').trim(),icon:field('adminCardIcon').trim()||'卡',color:field('adminCardColor')||'#176b5b',rate:clamp(field('adminCardRate'),0,100),cap:nullableNumber('adminCardCap'),storeId:field('adminCardStore'),storeRate:nullableNumber('adminCardStoreRate')});
  saveRules(); refreshAdminSelects(); document.getElementById('adminCardSelect').value=card.id; renderCardPresets(); alert('信用卡規則已儲存並套用。');
}

function newCard() {
  const card={id:`card-${Date.now()}`,bank:'新銀行',name:'新信用卡',icon:'新',color:'#176b5b',rate:0,cap:null,storeId:'',storeRate:null}; rules.cards.push(card); saveRules(); refreshAdminSelects(); document.getElementById('adminCardSelect').value=card.id; loadCardAdminForm();
}

function deleteAdminCard() {
  const id=field('adminCardSelect'); if(!id||!confirm('確定刪除這張信用卡規則？'))return;
  rules.cards=rules.cards.filter(card=>card.id!==id); if(selectedCardId===id)selectedCardId='none'; saveRules(); refreshAdminSelects(); renderCardPresets();
}

function exportRules() {
  const blob=new Blob([JSON.stringify(rules,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a'); link.href=url; link.download='productcount-rules.json'; link.click(); URL.revokeObjectURL(url);
}

function importRules(event) {
  const file=event.target.files[0]; if(!file)return; const reader=new FileReader();
  reader.onload=()=>{ try { const incoming=JSON.parse(reader.result); if(!incoming.stores?.length||!Array.isArray(incoming.cards))throw new Error(); rules=incoming; saveRules(); refreshAdminSelects(); applyStorePreset(); alert('規則匯入完成。'); } catch(error){ alert('檔案格式不正確。'); } event.target.value=''; }; reader.readAsText(file);
}

const STORAGE_KEYS = { saved: 'discount-calculator-saved-v1', purchases: 'discount-calculator-purchases-v1' };
let currentCalculation = null;
let currentFormData = null;

function readRecords(key) {
  try { const value = JSON.parse(localStorage.getItem(key)); return Array.isArray(value) ? value : []; }
  catch (error) { return []; }
}

function writeRecords(key, records) {
  try { localStorage.setItem(key, JSON.stringify(records)); return true; }
  catch (error) { showRecordMessage('瀏覽器無法儲存資料，請確認未停用本機儲存。', true); return false; }
}

function recordId() { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function formatRecordDate(value) { return new Intl.DateTimeFormat('zh-TW', { dateStyle:'medium', timeStyle:'short' }).format(new Date(value)); }
function escapeHtml(value) { const div=document.createElement('div'); div.textContent=String(value); return div.innerHTML; }

function showRecordMessage(message, isError = false) {
  const element = document.getElementById('recordMessage');
  element.textContent = message;
  element.style.color = isError ? 'var(--danger)' : 'var(--brand)';
}

function createCurrentRecord() {
  if (!currentCalculation || !currentFormData) return null;
  const storeSelect = document.getElementById('store');
  const selectedCard=rules.cards.find(card=>card.id===selectedCardId);
  return {
    id: recordId(), createdAt: new Date().toISOString(),
    store: storeSelect.options[storeSelect.selectedIndex].text,
    card: selectedCard ? `${selectedCard.bank} ${selectedCard.name}` : '無信用卡',
    quantity: currentFormData.quantity,
    original: currentCalculation.product.original,
    paid: currentCalculation.paid,
    reward: currentCalculation.totalReward,
    effectiveCost: currentCalculation.effectiveCost,
    rewardRate: currentCalculation.rewardRate
  };
}

function saveCurrentResult(type) {
  const record = createCurrentRecord();
  if (!record) return showRecordMessage('請先完成一次計算。', true);
  const key = type === 'purchase' ? STORAGE_KEYS.purchases : STORAGE_KEYS.saved;
  const records = readRecords(key);
  records.unshift(record);
  if (writeRecords(key, records)) {
    renderHistory();
    showRecordMessage(type === 'purchase' ? `已記錄本次買單 ${money(record.paid)}` : '已儲存這次計算結果。');
  }
}

function historyItem(record, type, bestId = '') {
  const isPurchase = type === 'purchase';
  return `<article class="history-item">
    <div class="history-item-header"><div><h3>${escapeHtml(record.store)} · ${escapeHtml(record.card||'未記錄卡片')} · ${numberText(record.quantity)} 件${record.id===bestId?'<span class="best-badge">最划算</span>':''}</h3><time datetime="${record.createdAt}">${formatRecordDate(record.createdAt)}</time></div><button type="button" class="delete-record" data-delete-type="${type}" data-id="${record.id}" aria-label="刪除此筆紀錄">刪除</button></div>
    <div class="history-values">
      <div><span>${isPurchase ? '實際付款' : '原始總價'}</span><strong>${money(isPurchase ? record.paid : record.original)}</strong></div>
      ${isPurchase ? `<div><span>等效成本</span><strong>${money(record.effectiveCost)}</strong></div>` : `<div><span>實際付款</span><strong>${money(record.paid)}</strong></div><div><span>總回饋價值</span><strong>${money(record.reward)}</strong></div><div><span>總回饋率</span><strong>${numberText(record.rewardRate)}%</strong></div>`}
    </div>
    ${isPurchase ? '' : `<div class="history-item-actions"><button type="button" class="confirm-record" data-confirm-id="${record.id}">確認買單並記錄</button></div>`}
  </article>`;
}

function confirmSavedRecord(id) {
  const source = readRecords(STORAGE_KEYS.saved).find(item => item.id === id);
  if (!source) return;
  const purchases = readRecords(STORAGE_KEYS.purchases);
  purchases.unshift({ ...source, id:recordId(), createdAt:new Date().toISOString(), sourceRecordId:source.id });
  if (writeRecords(STORAGE_KEYS.purchases, purchases)) {
    renderHistory();
    showTab('purchasePage');
  }
}

function renderHistory() {
  const saved = readRecords(STORAGE_KEYS.saved), purchases = readRecords(STORAGE_KEYS.purchases);
  const bestId=saved.length ? saved.reduce((best,item)=>Number(item.rewardRate)>Number(best.rewardRate)?item:best).id : '';
  const sum = (records, property) => round2(records.reduce((total, item) => total + clamp(item[property], 0), 0));
  document.getElementById('savedCount').textContent = saved.length;
  document.getElementById('purchaseCount').textContent = purchases.length;
  document.getElementById('savedTotalCount').textContent = saved.length;
  document.getElementById('savedPaidTotal').textContent = money(sum(saved, 'paid'));
  document.getElementById('savedRewardTotal').textContent = money(sum(saved, 'reward'));
  document.getElementById('purchaseTotalCount').textContent = purchases.length;
  document.getElementById('purchasePaidTotal').textContent = money(sum(purchases, 'paid'));
  document.getElementById('savedList').innerHTML = saved.length ? saved.map(item => historyItem(item, 'saved', bestId)).join('') : '<div class="empty-state">尚無計算紀錄。<br>完成計算後按「儲存計算結果」即可加入。</div>';
  document.getElementById('purchaseList').innerHTML = purchases.length ? purchases.map(item => historyItem(item, 'purchase')).join('') : '<div class="empty-state">尚無買單紀錄。<br>確認購買時按「確認買單並記錄」。</div>';
}

function deleteRecord(type, id) {
  const key = type === 'purchase' ? STORAGE_KEYS.purchases : STORAGE_KEYS.saved;
  writeRecords(key, readRecords(key).filter(item => item.id !== id));
  renderHistory();
}

function clearRecords(type) {
  const label = type === 'purchase' ? '買單紀錄' : '計算紀錄';
  if (!readRecords(type === 'purchase' ? STORAGE_KEYS.purchases : STORAGE_KEYS.saved).length) return;
  if (!window.confirm(`確定要清除全部${label}嗎？此操作無法復原。`)) return;
  writeRecords(type === 'purchase' ? STORAGE_KEYS.purchases : STORAGE_KEYS.saved, []);
  renderHistory();
}

function showTab(id) {
  document.querySelectorAll('.tab-panel').forEach(panel => { panel.hidden = panel.id !== id; panel.classList.toggle('active', panel.id === id); });
  document.querySelectorAll('.tab-button').forEach(button => button.classList.toggle('active', button.dataset.tab === id));
  window.scrollTo({ top:0, behavior:'smooth' });
}

function submitFeedback(event) {
  event.preventDefault();
  const message = field('feedbackMessage').trim();
  const error = document.getElementById('feedbackError');
  if (!message) {
    error.hidden = false;
    error.textContent = '請先填寫回饋內容。';
    document.getElementById('feedbackMessage').focus();
    return;
  }
  error.hidden = true;
  const name = field('feedbackName').trim() || '未提供';
  const email = field('feedbackEmail').trim() || '未提供';
  const type = field('feedbackType');
  const subject = encodeURIComponent(`[優惠回饋計算 App] ${type}`);
  const body = encodeURIComponent(`意見類型：${type}\n稱呼：${name}\n聯絡 Email：${email}\n\n回饋內容：\n${message}\n\n---\n由「這筆到底幾折？」網站送出`);
  window.location.href = `mailto:fs7705417@gmail.com?subject=${subject}&body=${body}`;
}

function submitCalculation() {
  if (!validateForm()) return;
  currentFormData = readForm();
  currentCalculation = calculateAll(currentFormData);
  renderResults(currentCalculation,currentFormData); renderPromotionRecommendations();
}

function toggleAdvanced(kind, forceOpen) {
  const isStore=kind==='store', button=document.getElementById(isStore?'toggleStoreAdvanced':'toggleCardAdvanced');
  const ids=isStore ? ['pointSystem','storePointMethod','storeRate','storeSpendUnit','storePointsUnit','storeMinimum','storeMultiplier','multiplierMode','storePointValue'] : ['cardType','cardFields'];
  const open=forceOpen===undefined ? button.getAttribute('aria-expanded')!=='true' : forceOpen;
  button.setAttribute('aria-expanded',String(open)); button.textContent=open ? '收起進階設定' : (isStore?'⚙️ 自訂點數規則':'⚙️ 自訂信用卡回饋');
  ids.forEach(id=>{ const el=document.getElementById(id); const target=id==='cardFields'?el:el?.closest('label'); if(target)target.classList.toggle('advanced-field-hidden',!open); });
}

function init() {
  const today=new Date(),localDate=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`; document.getElementById('purchaseDate').value=localDate;
  renderStoreOptions(); renderDiscountFields(); renderCardFields(); updateStoreMethodFields(); refreshAdminSelects(); applyStorePreset(); renderCardPresets();
  document.getElementById('discountType').addEventListener('change',renderDiscountFields);
  document.getElementById('cardType').addEventListener('change',()=>{ selectedCardId='none'; renderCardFields(); renderCardPresets(); });
  document.getElementById('store').addEventListener('change',()=>{ applyStorePreset(); if(selectedCardId!=='none')selectCard(selectedCardId); else submitCalculation(); });
  document.getElementById('purchaseDate').addEventListener('change',renderPromotionRecommendations);
  document.getElementById('storePointMethod').addEventListener('change',updateStoreMethodFields);
  document.getElementById('multiplierOptions').addEventListener('click',event=>{ const button=event.target.closest('[data-multiplier]'); if(!button)return; if(button.dataset.multiplier==='custom'){ toggleAdvanced('store',true); document.getElementById('storeMultiplier').focus(); return; } document.getElementById('storeMultiplier').value=button.dataset.multiplier; updateMultiplierButtons(); submitCalculation(); });
  document.getElementById('storeMultiplier').addEventListener('input',updateMultiplierButtons);
  document.getElementById('cardPresetGrid').addEventListener('click',event=>{ const button=event.target.closest('[data-card-id]'); if(button)selectCard(button.dataset.cardId); });
  document.getElementById('promotionRecommendations').addEventListener('click',event=>{ const button=event.target.closest('[data-promotion-id]'); if(button)applyPromotion(button.dataset.promotionId); });
  document.getElementById('toggleStoreAdvanced').addEventListener('click',()=>toggleAdvanced('store'));
  document.getElementById('toggleCardAdvanced').addEventListener('click',()=>toggleAdvanced('card'));
  document.getElementById('calculatorForm').addEventListener('submit',event => { event.preventDefault(); submitCalculation(); document.getElementById('results').scrollIntoView({behavior:'smooth',block:'start'}); });
  document.getElementById('exampleBtn').addEventListener('click',loadExample);
  document.getElementById('saveResultBtn').addEventListener('click',() => saveCurrentResult('saved'));
  document.getElementById('clearSavedBtn').addEventListener('click',() => clearRecords('saved'));
  document.getElementById('clearPurchaseBtn').addEventListener('click',() => clearRecords('purchase'));
  document.querySelectorAll('.tab-button').forEach(button => button.addEventListener('click',() => showTab(button.dataset.tab)));
  document.getElementById('feedbackForm').addEventListener('submit',submitFeedback);
  document.getElementById('feedbackMessage').addEventListener('input',event => { document.getElementById('feedbackLength').textContent=event.target.value.length; });
  document.querySelectorAll('.history-list').forEach(list => list.addEventListener('click',event => {
    const deleteButton=event.target.closest('[data-delete-type]');
    const confirmButton=event.target.closest('[data-confirm-id]');
    if(deleteButton) deleteRecord(deleteButton.dataset.deleteType,deleteButton.dataset.id);
    else if(confirmButton) confirmSavedRecord(confirmButton.dataset.confirmId);
  }));
  document.getElementById('adminStoreSelect').addEventListener('change',loadStoreAdminForm);
  document.getElementById('adminCardSelect').addEventListener('change',loadCardAdminForm);
  document.getElementById('storeRuleForm').addEventListener('submit',saveStoreAdminForm);
  document.getElementById('cardRuleForm').addEventListener('submit',saveCardAdminForm);
  document.getElementById('newCardBtn').addEventListener('click',newCard);
  document.getElementById('deleteCardBtn').addEventListener('click',deleteAdminCard);
  document.getElementById('exportRulesBtn').addEventListener('click',exportRules);
  document.getElementById('importRulesInput').addEventListener('change',importRules);
  document.getElementById('resetRulesBtn').addEventListener('click',()=>{ if(!confirm('確定恢復所有預設規則？自訂內容將被取代。'))return; rules=cloneDefaults(); saveRules(); selectedCardId='none'; refreshAdminSelects(); applyStorePreset(); alert('已恢復預設規則。'); });
  document.getElementById('clearBtn').addEventListener('click',() => { document.getElementById('calculatorForm').reset(); selectedCardId='none'; renderDiscountFields(); renderCardFields(); applyStorePreset(); toggleAdvanced('store',false); toggleAdvanced('card',false); submitCalculation(); });
  toggleAdvanced('store',false); toggleAdvanced('card',false); renderHistory(); submitCalculation();
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded',init);
if (typeof module !== 'undefined') module.exports = { calculateProductDiscount, calculateThresholdActivity, calculateStorePoints, calculateCardReward, calculatePaymentReward, calculateAll, promotionMatchesDate, promotionEstimatedValue, promotionUnavailable, PROMOTIONS };
