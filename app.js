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
    case 'secondPercent': {
      const pairs = Math.floor(qty / 2), remainder = qty % 2;
      discounted = pairs * price * (1 + rate) + remainder * price; break;
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
  if (!payment.type || payment.type === 'none') return 0;
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
    percent: rate, secondPercent: rate, pairPercent: rate,
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
    discount: { type: field('discountType'), rate: field('discountRate'), bundleSize: field('bundleSize'), bundlePrice: field('bundlePrice'), threshold: field('productThreshold'), off: field('productOff'), repeat: field('productRepeat') === 'yes' },
    storePoints: { system: field('pointSystem'), method: field('storePointMethod'), rate: field('storeRate'), spendUnit: field('storeSpendUnit'), pointsUnit: field('storePointsUnit'), minimum: field('storeMinimum'), multiplier: field('storeMultiplier'), mode: field('multiplierMode'), pointValue: field('storePointValue') },
    threshold: { type: field('thresholdType'), threshold: field('thresholdAmount'), reward: field('thresholdReward'), repeat: field('thresholdRepeat') === 'yes', cap: nullableNumber('thresholdCap'), minimum: field('thresholdMinimum'), pointValue: field('thresholdPointValue') },
    card: { type: field('cardType'), rate: field('cardRate'), cap: nullableNumber('cardCap'), spendUnit: field('cardSpendUnit'), pointsUnit: field('cardPointsUnit'), pointValue: field('cardPointValue') },
    payment: { type: field('paymentType'), rate: field('paymentRate'), cap: nullableNumber('paymentCap') }
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
  document.getElementById('effectiveCost').textContent = money(result.effectiveCost);
  document.getElementById('effectiveDiscount').textContent = `約 ${numberText(result.effectiveDiscount)} 折`;
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

const STORE_PRESETS = {
  cosmed: { system:'OPENPOINT', method:'rate', rate:.33, minimum:2, pointValue:1, note:'一般會員：實付滿 2 元起，回饋 0.33%；點數取至小數第 2 位。' },
  '7-eleven': { system:'OPENPOINT', method:'rate', rate:.33, minimum:2, pointValue:1, note:'OPENPOINT：實付滿 2 元起，回饋 0.33%；點數取至小數第 2 位。' }
};

function updateStoreMethodFields() {
  const isRate = field('storePointMethod') === 'rate';
  document.getElementById('storeRateLabel').classList.toggle('is-hidden', !isRate);
  document.getElementById('storeSpendUnitLabel').classList.toggle('is-hidden', isRate);
  document.getElementById('storePointsUnitLabel').classList.toggle('is-hidden', isRate);
}

// 選擇已知店家時自動帶入點數制度；其他店家仍可自由修改。
function applyStorePreset() {
  const preset = STORE_PRESETS[field('store')];
  if (preset) {
    document.getElementById('pointSystem').value = preset.system;
    document.getElementById('storePointMethod').value = preset.method;
    document.getElementById('storeRate').value = preset.rate;
    document.getElementById('storeMinimum').value = preset.minimum;
    document.getElementById('storePointValue').value = preset.pointValue;
    document.getElementById('storeMultiplier').value = 1;
    document.getElementById('storeRuleNote').textContent = preset.note;
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
  updateStoreMethodFields();
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
  return {
    id: recordId(), createdAt: new Date().toISOString(),
    store: storeSelect.options[storeSelect.selectedIndex].text,
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

function historyItem(record, type) {
  const isPurchase = type === 'purchase';
  return `<article class="history-item">
    <div class="history-item-header"><div><h3>${escapeHtml(record.store)} · ${numberText(record.quantity)} 件</h3><time datetime="${record.createdAt}">${formatRecordDate(record.createdAt)}</time></div><button type="button" class="delete-record" data-delete-type="${type}" data-id="${record.id}" aria-label="刪除此筆紀錄">刪除</button></div>
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
  const sum = (records, property) => round2(records.reduce((total, item) => total + clamp(item[property], 0), 0));
  document.getElementById('savedCount').textContent = saved.length;
  document.getElementById('purchaseCount').textContent = purchases.length;
  document.getElementById('savedTotalCount').textContent = saved.length;
  document.getElementById('savedPaidTotal').textContent = money(sum(saved, 'paid'));
  document.getElementById('savedRewardTotal').textContent = money(sum(saved, 'reward'));
  document.getElementById('purchaseTotalCount').textContent = purchases.length;
  document.getElementById('purchasePaidTotal').textContent = money(sum(purchases, 'paid'));
  document.getElementById('savedList').innerHTML = saved.length ? saved.map(item => historyItem(item, 'saved')).join('') : '<div class="empty-state">尚無計算紀錄。<br>完成計算後按「儲存計算結果」即可加入。</div>';
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
  renderResults(currentCalculation,currentFormData);
}

function init() {
  renderDiscountFields(); renderCardFields(); updateStoreMethodFields();
  document.getElementById('discountType').addEventListener('change',renderDiscountFields);
  document.getElementById('cardType').addEventListener('change',renderCardFields);
  document.getElementById('store').addEventListener('change',applyStorePreset);
  document.getElementById('storePointMethod').addEventListener('change',updateStoreMethodFields);
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
  document.getElementById('clearBtn').addEventListener('click',() => { document.getElementById('calculatorForm').reset(); renderDiscountFields(); renderCardFields(); applyStorePreset(); submitCalculation(); });
  renderHistory(); submitCalculation();
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded',init);
if (typeof module !== 'undefined') module.exports = { calculateProductDiscount, calculateThresholdActivity, calculateStorePoints, calculateCardReward, calculatePaymentReward, calculateAll };
