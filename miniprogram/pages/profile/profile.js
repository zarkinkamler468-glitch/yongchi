const { request, toast } = require('../../utils/request');
const { roleLabel } = require('../../utils/util');

Page({
  data: { user: null, roleText: '', wxBound: false, canRefund: false, icpNo: '', pseNo: '' },
  onShow() {
    const user = wx.getStorageSync('user') || null;
    this.setData({ user, roleText: user ? roleLabel(user.role) : '', canRefund: user && ['boss', 'finance', 'admin'].includes(user.role) });
    request('/api/auth/me').then((d) => this.setData({ wxBound: !!d.user.wx_bound })).catch(() => {});
    request('/api/public-config').then((d) => this.setData({ icpNo: d.settings.icp_no || '', pseNo: d.settings.public_security_no || '' })).catch(() => {});
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
