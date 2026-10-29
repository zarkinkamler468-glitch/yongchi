const { request, toast, pendingTransactions } = require('../../utils/request');
const { fmtMoney } = require('../../utils/util');

Page({
  data: { keyword: '', gate_no: '前台', people: 1, result: null, preview: null, submitting: false, requestId: '' },
  onShow() {
    // 其他页面完成恢复后，清除本页已失效的重试快照。
    if (typeof pendingTransactions === 'function') {
      const pending = pendingTransactions();
      if (!pending.some(p => p.scope === 'checkin')) { this._pendingCheckin = null; this.setData({ requestId: '', preview: null }); }
    }
  },
  onInput(e) {
    if (this.data.submitting) return;
    this._previewVersion = (this._previewVersion || 0) + 1;
    // 保留待重试快照：上一笔结果未知时不能直接给另一位会员扣费。
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value, preview: null, result: null });
  },
  submit() {
    if (this.data.submitting) return;
    if (this._pendingCheckin) {
      const p = this._pendingCheckin;
      const same = p.keyword === this.data.keyword.trim()
        && Number(p.people) === (Number(this.data.people) || 1)
        && String(p.gate_no || '') === String(this.data.gate_no || '');
      if (!same) {
        this._previewVersion = (this._previewVersion || 0) + 1;
        this.setData({ preview: null, result: { ok: false, retry: true, error: '上一笔核销结果未确认，请先重试上一笔，确认后再为其他会员办理' } });
        return;
      }
      this.confirm(); return;
    }
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
  retryPendingCheckin() {
    if (!this._pendingCheckin) return;
    this.setData({ result: null });
    this.confirm();
  },
  confirm() {
    const preview = this._pendingCheckin || this.data.preview;
    if (this.data.submitting || !preview) return;
    const { keyword, gate_no, people } = preview;
    const rid = this.data.requestId || `checkin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.setData({ submitting: true, requestId: rid });
    this._pendingCheckin = { ...preview };
    request('/api/entries/checkin', { data: { keyword, card_id: preview.card_id, gate_no, people: Number(people) || 1, confirmed: true, request_id: rid } }).then(() => { this._pendingCheckin = null; toast('核销成功', 'success'); this.setData({ submitting: false, requestId: '', preview: null, result: { ok: true, error: '核销成功，权益已扣减' } }); }).catch((e) => { const rejected = [400, 422].includes(e.status); if (rejected) this._pendingCheckin = null; this.setData({ submitting: false, requestId: rejected ? '' : rid, result: { ok: false, error: e.message } }); });
  }
});
