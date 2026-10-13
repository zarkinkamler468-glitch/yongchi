const { request, toast } = require('../../utils/request');
const { fmtMoney } = require('../../utils/util');

Page({
  data: { keyword: '', gate_no: '前台', people: 1, result: null, preview: null, submitting: false, requestId: '' },
  onInput(e) { if (this.data.submitting) return; this._previewVersion = (this._previewVersion || 0) + 1; this.setData({ [e.currentTarget.dataset.key]: e.detail.value, preview: null, result: null }); },
  submit() {
    if (this.data.submitting) return;
    if (this._pendingCheckin) { this.confirm(); return; }
    const { keyword, gate_no, people } = this.data;
    const version = this._previewVersion = (this._previewVersion || 0) + 1;
    this.setData({ preview: null });
    if (!keyword.trim()) { toast('请输入卡号 / 手机号 / 会员编号'); return; }
    request('/api/entries/preview?keyword=' + encodeURIComponent(keyword) + '&people=' + (Number(people) || 1)).then((d) => {
      if (version !== this._previewVersion) return;
      this.setData({
        preview: { keyword, gate_no, people: d.card.people, card_id: d.card.id, name: d.member.name, member_no: d.member.member_no, phone: d.member.phone || '', card_name: d.card.card_name || '', remaining_uses: d.card.remaining_uses, balance: fmtMoney(d.card.balance), end_at: d.card.end_at || '—', deduct_uses: d.card.preview_deducted_uses, deduct_amount: fmtMoney(d.card.preview_deducted_amount) }, result: null
      });
    }).catch((e) => { if (version === this._previewVersion) this.setData({ preview: null, result: { ok: false, error: e.message } }); });
  },
  confirm() {
    const preview = this._pendingCheckin || this.data.preview;
    if (this.data.submitting || !preview) return;
    const { keyword, gate_no, people } = preview;
    const rid = this.data.requestId || `checkin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.setData({ submitting: true, requestId: rid });
    this._pendingCheckin = { ...preview };
    request('/api/entries/checkin', { data: { keyword, card_id: preview.card_id, gate_no, people: Number(people) || 1, confirmed: true, request_id: rid } }).then(() => { this._pendingCheckin = null; toast('核销成功', 'success'); this.setData({ submitting: false, requestId: '', preview: null, result: { ok: true, error: '核销成功，权益已扣减' } }); }).catch((e) => { const rejected = e.status >= 400 && e.status < 500; if (rejected) this._pendingCheckin = null; this.setData({ submitting: false, requestId: rejected ? '' : rid, result: { ok: false, error: e.message } }); });
  }
});
