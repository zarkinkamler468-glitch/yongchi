const { request, toast, pendingTransactions, discardPending } = require('../../utils/request');
const { roleLabel } = require('../../utils/util');

Page({
  data: { user: null, roleText: '', wxBound: false, canRefund: false, canShift: false, icpNo: '', pseNo: '', pending: [], recovering: false },
  onShow() {
    const user = wx.getStorageSync('user') || null;
    this.setData({
      pending: pendingTransactions().map(p => ({
        scope: p.scope,
        corrupt: !!p.corrupt,
        label: ({ cashier: '收银', checkin: '核销', refund: '退款申请' })[p.scope],
        createdText: p.created_at ? new Date(p.created_at).toLocaleString() : ''
      })),
      user,
      roleText: user ? roleLabel(user.role) : '',
      canRefund: user && ['boss', 'finance', 'admin'].includes(user.role),
      canShift: user && ['boss', 'frontdesk', 'admin'].includes(user.role)
    });
    request('/api/auth/me').then((d) => this.setData({ wxBound: !!d.user.wx_bound })).catch(() => {});
    request('/api/public-config').then((d) => this.setData({ icpNo: d.settings.icp_no || '', pseNo: d.settings.public_security_no || '' })).catch(() => {});
  },
  recoverPending(e) {
    if (this.data.recovering) return;
    const pending = pendingTransactions().find(p => p.scope === e.currentTarget.dataset.scope);
    if (!pending) return;
    if (pending.corrupt) { toast('待确认业务记录损坏，请联系维护人员核对流水'); return; }
    this.setData({ recovering: true });
    request(pending.path, { data: pending.data })
      .then(() => { toast('上一笔结果已确认，请查看流水', 'success'); })
      .catch(error => toast(error.message))
      .finally(() => { this.setData({ recovering: false }); this.onShow(); });
  },
  abandonPending(e) {
    const scope = e.currentTarget.dataset.scope;
    wx.showModal({
      title: '放弃待确认业务',
      content: '请先核对收银流水或核销记录，确认上一笔业务确实未执行。放弃后记录会被删除。',
      confirmText: '核对后放弃',
      success: (res) => {
        if (!res.confirm) return;
        discardPending(scope);
        toast('已放弃待确认记录，请核对流水', 'success');
        this.onShow();
      }
    });
  },
  goStats() { wx.navigateTo({ url: '/pages/stats/stats' }); },
  goOrders() { wx.navigateTo({ url: '/pages/orders/orders' }); },
  goShifts() { wx.navigateTo({ url: '/pages/shifts/shifts' }); },
  goRefunds() { wx.navigateTo({ url: '/pages/refunds/refunds' }); },
  unbindWx() {
    wx.showModal({
      title: '解绑微信', content: '解绑后下次需重新登录并绑定',
      success: (res) => {
        if (!res.confirm) return;
        request('/api/auth/wxunbind', { data: {} }).then(() => { toast('已解绑', 'success'); this.setData({ wxBound: false }); }).catch((e) => toast(e.message));
      }
    });
  },
  logout() {
    wx.showModal({
      title: '退出登录', content: '确定退出当前账号吗？',
      success: (res) => {
        if (!res.confirm) return;
        request('/api/auth/logout', { data: {} }).catch(() => {});
        wx.removeStorageSync('token'); wx.removeStorageSync('user');
        wx.reLaunch({ url: '/pages/login/login' });
      }
    });
  }
});
