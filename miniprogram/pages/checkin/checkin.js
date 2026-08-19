const { request, toast } = require('../../utils/request');
const { fmtMoney } = require('../../utils/util');

Page({
  data: { keyword: '', gate_no: '前台', people: 1, result: null, preview: null },
  onInput(e) { this.setData({ [e.currentTarget.dataset.key]: e.detail.value }); },
  submit() {
    const { keyword, gate_no, people } = this.data;
    if (!keyword.trim()) { toast('请输入卡号 / 手机号 / 会员编号'); return; }
    request('/api/entries/preview?keyword=' + encodeURIComponent(keyword) + '&people=' + (Number(people) || 1)).then((d) => {
      this.setData({
        preview: { name: d.member.name, member_no: d.member.member_no, phone: d.member.phone || '', card_name: d.card.card_name || '', remaining_uses: d.card.remaining_uses, balance: fmtMoney(d.card.balance), end_at: d.card.end_at || '—', deduct_uses: d.card.preview_deducted_uses, deduct_amount: fmtMoney(d.card.preview_deducted_amount) }, result: null
      });
    }).catch((e) => this.setData({ result: { ok: false, error: e.message } }));
  },
  confirm() {
    const { keyword, gate_no, people } = this.data;
    request('/api/entries/checkin', { data: { keyword, gate_no, people: Number(people) || 1, confirmed: true } }).then(() => { toast('核销成功', 'success'); this.setData({ preview: null, result: { ok: true, error: '核销成功，权益已扣减' } }); }).catch((e) => this.setData({ result: { ok: false, error: e.message } }));
  }
});
