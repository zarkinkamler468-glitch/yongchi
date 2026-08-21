const { request, toast } = require('../../utils/request');
const { fmtMoney, fmtDateTime, orderTypeLabel, orderStatusLabel } = require('../../utils/util');

Page({
  data: { list: [], scope: 'income', scopeLabel: '收入', type: '', typeLabel: '全部类型', typeIndex: 0, status: '', statusLabel: '全部状态', statusIndex: 0, search: '', from: '', to: '', loading: false },
  onShow() { this.load(); },
  load() {
    const q = [];
    if (this.data.scope === 'income') q.push('income_only=1');
    if (this.data.scope === 'refund') q.push('order_type=refund');
    if (this.data.type) q.push('order_type=' + this.data.type);
    if (this.data.status) q.push('status=' + this.data.status);
    if (this.data.search.trim()) q.push('search=' + encodeURIComponent(this.data.search.trim()));
    if (this.data.from) q.push('from=' + this.data.from);
    if (this.data.to) q.push('to=' + this.data.to);
    const path = '/api/orders' + (q.length ? '?' + q.join('&') : '');
    this.setData({ loading: true });
    request(path).then((d) => {
      this.setData({
        loading: false,
        list: d.list.map((o) => ({
          ...o, typeText: orderTypeLabel(o.order_type), statusText: orderStatusLabel(o.status),
          amountText: fmtMoney(o.order_type === 'refund' ? -Number(o.total_amount) : o.paid_amount), timeText: fmtDateTime(o.business_at || o.created_at),
          statusClass: o.status === 'paid' ? 'green' : o.status === 'pending' ? 'amber' : o.status === 'refunded' || o.status === 'void' ? 'red' : 'amber'
        }))
      });
    }).catch((e) => { this.setData({ loading: false }); toast(e.message); });
  },
  setScope(e) { const scope = e.currentTarget.dataset.scope; const labels = { income: '收入', refund: '退款', all: '全部' }; this.setData({ scope, scopeLabel: labels[scope], type: scope === 'income' || scope === 'refund' ? '' : this.data.type }); this.load(); },
  onSearch(e) { this.setData({ search: e.detail.value }); },
  onType(e) { const values = ['', 'open', 'renew', 'recharge', 'refund']; const labels = ['全部类型', '开卡', '续费', '储值充值', '退款']; let i = Number(e.detail.value); if (this.data.scope === 'income' && i === 4) i = 0; this.setData({ type: values[i], typeLabel: labels[i], typeIndex: i }); },
  onStatus(e) { const values = ['', 'paid', 'partial_refund', 'refunded', 'pending', 'void']; const labels = ['全部状态', '已支付', '部分退款', '已退款', '待审批', '已作废']; const i = Number(e.detail.value); this.setData({ status: values[i], statusLabel: labels[i], statusIndex: i }); },
  onFrom(e) { this.setData({ from: e.detail.value }); },
  onTo(e) { this.setData({ to: e.detail.value }); },
  applyFilter() { this.load(); },
  resetFilter() { this.setData({ type: '', status: '', typeLabel: '全部类型', statusLabel: '全部状态', typeIndex: 0, statusIndex: 0, search: '', from: '', to: '' }); this.load(); }
});
