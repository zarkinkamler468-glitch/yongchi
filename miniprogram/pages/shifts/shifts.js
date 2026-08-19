const { request, toast } = require('../../utils/request');
const { fmtMoney, fmtDateTime, PAY_LABEL } = require('../../utils/util');

Page({
  data: {
    current: null, list: [],
    showClose: false, closeId: null, summary: null,
    actualCash: '', note: '', diff: '—'
  },
  onShow() { this.load(); },
  load() {
    Promise.all([request('/api/shifts/current'), request('/api/shifts')]).then(([c, l]) => {
      this.setData({
        current: c.shift,
        list: l.list.map((s) => ({
          ...s, startedText: fmtDateTime(s.started_at), endedText: s.ended_at ? fmtDateTime(s.ended_at) : '—',
          statusText: s.status === 'active' ? '进行中' : '已交班',
          cashShould: s.cash_amount != null ? fmtMoney(s.cash_amount) : '—',
          actualText: s.actual_cash != null ? fmtMoney(s.actual_cash) : '—',
          diffText: s.difference != null ? (s.difference === 0 ? '0' : s.difference) : '—'
        }))
      });
    }).catch((e) => toast(e.message));
  },
  start() { request('/api/shifts/start', { data: {} }).then(() => { toast('已开班', 'success'); this.load(); }).catch((e) => toast(e.message)); },
  openClose(e) {
    const id = e.currentTarget.dataset.id;
    request('/api/shifts/' + id).then((d) => {
      this.setData({
        showClose: true, closeId: id, summary: d.summary,
        actualCash: d.summary ? String(d.summary.cash_should) : '', note: '', diff: '0.00'
      });
    }).catch((e) => toast(e.message));
  },
  closeSheet() { this.setData({ showClose: false }); },
  onInput(e) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value });
    if (e.currentTarget.dataset.key === 'actualCash') this.calcDiff();
  },
  calcDiff() {
    const s = this.data.summary;
    if (!s) return;
    const actual = Number(this.data.actualCash) || 0;
    const diff = Math.round((actual - s.cash_should) * 100) / 100;
    this.setData({ diff: (diff >= 0 ? '+' : '') + fmtMoney(diff).replace('¥', '') });
  },
  confirmClose() {
    request('/api/shifts/' + this.data.closeId + '/close', { data: { actual_cash: this.data.actualCash, note: this.data.note } })
      .then(() => { toast('已交班', 'success'); this.setData({ showClose: false }); this.load(); })
      .catch((e) => toast(e.message));
  }
});
