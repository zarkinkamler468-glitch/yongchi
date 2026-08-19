const { request, toast } = require('../../utils/request');
const { fmtMoney } = require('../../utils/util');

Page({
  data: { list: [] },
  onShow() { this.load(); },
  load() {
    request('/api/refunds?status=pending').then((d) => {
      this.setData({ list: d.list.map((r) => ({ ...r, amountText: fmtMoney(r.total_amount), member: r.member_name })) });
    }).catch((e) => toast(e.message));
  },
  approve(e) {
    const id = e.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: ['原路退回', '现金登记'],
      success: (res) => {
        const method = res.tapIndex === 0 ? 'original' : 'cash';
        request('/api/refunds/' + id + '/approve', { data: { refund_method: method } })
          .then(() => { toast('已通过', 'success'); this.load(); })
          .catch((err) => toast(err.message));
      }
    });
  },
  reject(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '驳回退款', editable: true, placeholderText: '请填写驳回原因',
      success: (res) => {
        if (!res.confirm) return;
        request('/api/refunds/' + id + '/reject', { data: { reason: res.content } })
          .then(() => { toast('已驳回', 'success'); this.load(); })
          .catch((err) => toast(err.message));
      }
    });
  }
});
