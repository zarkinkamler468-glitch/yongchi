const { request, toast } = require('../../utils/request');
const { fmtMoney, fmtNum } = require('../../utils/util');

Page({
  data: { user: null, stats: null, recent: [], canShift: false, showShiftReminder: false, startingShift: false },
  onShow() { this.setData({ user: wx.getStorageSync('user') || null }); this.load(); },
  load() {
    request('/api/dashboard').then((d) => {
      const max = Math.max(1, ...d.recent.map((r) => r.income));
      const user = wx.getStorageSync('user') || {};
      const canShift = ['boss', 'frontdesk'].includes(user.role);
      this.setData({
        canShift, showShiftReminder: canShift && !d.current_shift,
        stats: {
          today_income: fmtMoney(d.today_income),
          today_open: fmtMoney(d.today_open),
          today_renew: fmtMoney(d.today_renew),
          today_recharge: fmtMoney(d.today_recharge),
          today_refund: fmtMoney(d.today_refund),
          today_entries: fmtNum(d.today_entries),
          expiring_cards: d.expiring_cards,
          low_balance_members: d.low_balance_members,
          blacklist_count: d.blacklist_count,
          shift_started: !!d.current_shift
        },
        recent: d.recent.map((r) => ({ ...r, label: r.date.slice(5), h: Math.round((r.income / max) * 100) }))
      });
    }).catch((e) => toast(e.message));
  },
  startShift() {
    if (this.data.startingShift) return;
    this.setData({ startingShift: true });
    request('/api/shifts/start', { data: {} }).then(() => {
      toast('班次已开始', 'success');
      this.setData({ showShiftReminder: false, startingShift: false });
      this.load();
    }).catch((e) => { this.setData({ startingShift: false }); toast(e.message); });
  },
  dismissShiftReminder() { this.setData({ showShiftReminder: false }); },
  goCashier() { wx.switchTab({ url: '/pages/cashier/cashier' }); },
  goMembers() { wx.switchTab({ url: '/pages/members/members' }); },
  goCheckin() { wx.navigateTo({ url: '/pages/checkin/checkin' }); },
  goShifts() { wx.navigateTo({ url: '/pages/shifts/shifts' }); },
  goStats() { wx.navigateTo({ url: '/pages/stats/stats' }); }
});
