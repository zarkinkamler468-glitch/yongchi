const { request, toast } = require('../../utils/request');
const { fmtMoney, fmtNum, cardTypeLabel, payLabel } = require('../../utils/util');

const HEX = { count: '#10b981', month: '#f59e0b', year: '#2563eb', stored: '#0ea5e9' };

Page({
  data: { stats: null, checkins: [], breakdown: [], canViewBreakdown: false },
  onShow() { this.load(); },
  load() {
    request('/api/dashboard').then((d) => {
      const max = Math.max(1, ...d.recent.map((r) => r.entries));
      this.setData({
        stats: {
          today_income: fmtMoney(d.today_income), today_gross: fmtMoney(d.today_open + d.today_renew + d.today_recharge),
          today_entries: fmtNum(d.today_entries), expiring: d.expiring_cards
        },
        checkins: d.recent.map((r) => ({ label: r.date.slice(5), h: Math.round((r.entries / max) * 100) }))
      });
    }).catch((e) => toast(e.message));

    const user = wx.getStorageSync('user') || {};
    const canViewBreakdown = ['boss', 'finance', 'admin'].includes(user.role);
    this.setData({ canViewBreakdown });
    if (!canViewBreakdown) return;
    request('/api/reports/overview').then((d) => {
      const max = Math.max(1, ...d.by_card.map((x) => Number(x.amount)));
      this.setData({
        breakdown: d.by_card.map((x) => ({
          label: cardTypeLabel(x.card_type), amount: fmtMoney(x.amount), color: HEX[x.card_type] || '#94a3b8', w: Math.round((Number(x.amount) / max) * 100)
        }))
      });
    }).catch(() => {});
  }
});
