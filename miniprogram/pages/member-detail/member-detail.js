const { request, toast } = require('../../utils/request');
const { fmtMoney, fmtDateTime, MEMBER_STATUS_LABEL, cardTypeLabel, cardTypeClass, cardStatusLabel, cardStatusClass, cardAssetText, orderTypeLabel, orderStatusLabel } = require('../../utils/util');

Page({
  data: {
    id: null, member: null, cards: [], entries: [], orders: [],
    showRecharge: false, rechargeCardId: null, rechargeAmount: '', checkinPreview: null,
    pays: ['现金', '微信', '支付宝'], payValues: ['cash', 'wechat', 'alipay'], payIndex: 0
  },
  onLoad(options) { this.setData({ id: options.id }); },
  onShow() { this.load(); },
  load() {
    request('/api/members/' + this.data.id).then((d) => {
      this.setData({
        member: {
          ...d.member,
          statusText: MEMBER_STATUS_LABEL[d.member.status] || d.member.status,
          statusClass: d.member.status === 'normal' ? 'green' : d.member.status === 'blacklist' ? 'red' : 'gray',
          tagsText: (d.member.tags || []).map((t) => t.tag_name).join('、')
        },
        cards: d.cards.map((c) => ({ ...c, typeText: cardTypeLabel(c.card_type), typeClass: cardTypeClass(c.card_type), statusText: cardStatusLabel(c.status), statusClass: cardStatusClass(c.status), assetText: cardAssetText(c), canRecharge: c.card_type === 'stored' && !['void', 'refunded'].includes(c.status) })),
        entries: d.entries.map((e) => ({ ...e, timeText: fmtDateTime(e.entry_at), resultOk: e.result === 'success' })),
        orders: d.orders.map((o) => ({ ...o, typeText: orderTypeLabel(o.order_type), statusText: orderStatusLabel(o.status), amountText: fmtMoney(o.paid_amount) }))
      });
    }).catch((e) => toast(e.message));
  },
  openRecharge(e) { this.setData({ showRecharge: true, rechargeCardId: e.currentTarget.dataset.id, rechargeAmount: '' }); },
  closeRecharge() { this.setData({ showRecharge: false }); },
  onAmount(e) { this.setData({ rechargeAmount: e.detail.value }); },
  onPay(e) { this.setData({ payIndex: Number(e.detail.value) }); },
  confirmRecharge() {
    const amt = Number(this.data.rechargeAmount);
    if (!amt || amt <= 0) { toast('请输入充值金额'); return; }
    request('/api/orders', { data: { order_type: 'recharge', member_id: Number(this.data.id), member_card_id: Number(this.data.rechargeCardId), amount: amt, payments: [{ pay_method: this.data.payValues[this.data.payIndex], amount: amt }] } })
      .then(() => { toast('充值成功', 'success'); this.setData({ showRecharge: false }); this.load(); })
      .catch((e) => toast(e.message));
  },
  doCheckin() {
    const m = this.data.member;
    request('/api/entries/preview?keyword=' + encodeURIComponent(m.member_no) + '&people=1')
      .then((d) => this.setData({ checkinPreview: { cardName: d.card.card_name, cardType: d.card.card_type, uses: d.card.preview_deducted_uses, amount: fmtMoney(d.card.preview_deducted_amount), remaining: d.card.remaining_uses, balance: fmtMoney(d.card.balance) } }))
      .catch((e) => toast(e.message));
  },
  cancelCheckin() { this.setData({ checkinPreview: null }); },
  confirmCheckin() {
    const m = this.data.member;
    request('/api/entries/checkin', { data: { keyword: m.member_no, gate_no: '小程序会员详情', people: 1, confirmed: true } })
      .then(() => { toast('核销成功', 'success'); this.setData({ checkinPreview: null }); this.load(); })
      .catch((e) => toast(e.message));
  }
});
