const { request, toast } = require('../../utils/request');
const { fmtMoney, fmtNum } = require('../../utils/util');

Page({
  data: { user: null, stats: null, recent: [], canShift: false, canCashier: false, canMember: false, showShiftReminder: false, startingShift: false },
  onShow() { this.setData({ user: wx.getStorageSync('user') || null }); this.load(); },
  load() {
    request('/api/dashboard').then((d) => {
      const canFinance = d.can_view_finance !== false;
      const values = d.recent.map((r) => canFinance ? Number(r.income || 0) : Number(r.entries || 0));
      const max = Math.max(1, ...values);
      const user = wx.getStorageSync('user') || {};
      const canShift = ['boss', 'frontdesk', 'admin'].includes(user.role);
      const canFront = ['boss', 'frontdesk', 'admin'].includes(user.role);
      this.setData({
        canFinance,
        canShift, canCashier: canFront, canMember: canFront, showShiftReminder: canShift && !d.current_shift,
        stats: {
          canFinance,
          today_income: canFinance ? fmtMoney(d.today_income) : '',
          today_open: canFinance ? fmtMoney(d.today_open) : '',
          today_renew: canFinance ? fmtMoney(d.today_renew) : '',
          today_recharge: canFinance ? fmtMoney(d.today_recharge) : '',
          today_refund: canFinance ? fmtMoney(d.today_refund) : '',
          today_entries: fmtNum(d.today_entries),
          expiring_cards: d.expiring_cards,
          low_balance_members: d.low_balance_members,
          blacklist_count: d.blacklist_count,
          shift_started: !canShift || !!d.current_shift
        },
        recent: d.recent.map((r, i) => ({ ...r, label: r.date.slice(5), h: Math.round((values[i] / max) * 100) }))
      });
    }).catch((e) => toast(e.message));
  },
  startShift() {
    if (this.data.startingShift) return;
    wx.showModal({ title: '开始班次', editable: true, placeholderText: '开班备用金，默认 0 元', success: (res) => {
      if (!res.confirm) return;
      const openingCash = res.content === '' ? 0 : Number(res.content);
      if (!Number.isFinite(openingCash) || openingCash < 0) { toast('备用金必须是非负数'); return; }
      this.setData({ startingShift: true });
      request('/api/shifts/start', { data: { opening_cash: openingCash } }).then(() => {
        toast('班次已开始', 'success');
        this.setData({ showShiftReminder: false, startingShift: false });
        this.load();
      }).catch((e) => { this.setData({ startingShift: false }); toast(e.message); });
    } });
  },
  dismissShiftReminder() { this.setData({ showShiftReminder: false }); },
  goCashier() { wx.switchTab({ url: '/pages/cashier/cashier' }); },
  goMembers() { wx.switchTab({ url: '/pages/members/members' }); },
  goCheckin() { wx.navigateTo({ url: '/pages/checkin/checkin' }); },
  goShifts() { wx.navigateTo({ url: '/pages/shifts/shifts' }); },
  goStats() { wx.navigateTo({ url: '/pages/stats/stats' }); }
});
