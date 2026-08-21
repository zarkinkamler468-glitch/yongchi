const { request, toast } = require('../../utils/request');
const { fmtMoney } = require('../../utils/util');

Page({
  data: { list: [], submittingId: null },
  onShow() { this.load(); },
  load() {
    request('/api/refunds?status=pending').then((d) => {
      this.setData({ list: d.list.map((r) => ({ ...r, amountText: fmtMoney(r.total_amount), member: r.member_name })) });
    }).catch((e) => toast(e.message));
  },
  approve(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.submittingId) return;
    wx.showActionSheet({
      itemList: ['原路退回', '现金登记'],
      success: (res) => {
        const method = res.tapIndex === 0 ? 'original' : 'cash';
        this.setData({ submittingId: id });
        request('/api/refunds/' + id + '/approve', { data: { refund_method: method } })
          .then(() => { this.setData({ submittingId: null }); toast('已通过', 'success'); this.load(); })
          .catch((err) => { this.setData({ submittingId: null }); toast(err.message); });
      }
    });
  },
  reject(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.submittingId) return;
    wx.showModal({
      title: '驳回退款', editable: true, placeholderText: '请填写驳回原因',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ submittingId: id });
        request('/api/refunds/' + id + '/reject', { data: { reason: res.content } })
          .then(() => { this.setData({ submittingId: null }); toast('已驳回', 'success'); this.load(); })
          .catch((err) => { this.setData({ submittingId: null }); toast(err.message); });
      }
    });
  }
});
