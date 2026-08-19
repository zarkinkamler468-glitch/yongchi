// 通用工具与常量（对齐后端 v0.5）
const CARD_TYPE_LABEL = { count: '次卡', month: '月卡', year: '年卡', stored: '储值卡' };
const CARD_STATUS_LABEL = { normal: '正常', frozen: '冻结', expired: '过期', void: '作废', refunded: '已退款' };
const MEMBER_STATUS_LABEL = { normal: '正常', blacklist: '黑名单', inactive: '停用' };
const ORDER_TYPE_LABEL = { open: '开卡', renew: '续费', recharge: '储值充值', refund: '退款' };
const ORDER_STATUS_LABEL = { pending: '待审批', paid: '已支付', partial_refund: '部分退款', refunded: '已退款', void: '已作废' };
const PAY_LABEL = { cash: '现金', wechat: '微信', alipay: '支付宝', stored: '储值' };
const ROLE_LABEL = { admin: '超管', boss: '老板', frontdesk: '前台', finance: '财务' };
const GENDER = { male: '男', female: '女', unknown: '—' };

function fmtNum(n) {
  return String(Math.round(Number(n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtMoney(n) {
  const v = Number(n || 0);
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  const fixed = Math.round(abs * 100) / 100;
  const s = fixed.toFixed(2);
  const parts = s.split('.');
  const int = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const dec = parts[1] === '00' ? '' : '.' + parts[1].replace(/0$/, '');
  return sign + '¥' + int + dec;
}
function fmtDateTime(s) { return (s || '').replace('T', ' ').slice(0, 16); }

function cardTypeLabel(t) { return CARD_TYPE_LABEL[t] || t || '—'; }
function cardStatusLabel(t) { return CARD_STATUS_LABEL[t] || t || '—'; }
function payLabel(t) { return PAY_LABEL[t] || t || '—'; }
function genderLabel(t) { return GENDER[t] || '—'; }
function orderTypeLabel(t) { return ORDER_TYPE_LABEL[t] || t; }
function orderStatusLabel(t) { return ORDER_STATUS_LABEL[t] || t; }
function roleLabel(t) { return ROLE_LABEL[t] || t; }

function cardTypeClass(t) { return { count: 'green', month: 'amber', year: 'blue', stored: 'blue' }[t] || 'gray'; }
function cardStatusClass(s) { return { normal: 'green', frozen: 'amber', expired: 'red', void: 'gray', refunded: 'red' }[s] || 'gray'; }

function cardAssetText(c) {
  if (c.card_type === 'stored') return '余额 ' + fmtMoney(c.balance);
  if (c.card_type === 'count') return '剩余 ' + c.remaining_uses + ' 次';
  if (['month', 'year'].includes(c.card_type)) return '有效期至 ' + (c.end_at || '—');
  return '—';
}

module.exports = {
  CARD_TYPE_LABEL, CARD_STATUS_LABEL, MEMBER_STATUS_LABEL, ORDER_TYPE_LABEL, ORDER_STATUS_LABEL, PAY_LABEL, ROLE_LABEL, GENDER,
  fmtMoney, fmtNum, fmtDateTime, cardTypeLabel, cardTypeClass, cardStatusLabel, cardStatusClass, cardAssetText,
  payLabel, genderLabel, orderTypeLabel, orderStatusLabel, roleLabel
};
