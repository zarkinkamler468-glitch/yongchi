const { request, toast } = require('../../utils/request');
const { MEMBER_STATUS_LABEL, genderLabel } = require('../../utils/util');

function statusClass(s) { return s === 'normal' ? 'green' : s === 'blacklist' ? 'red' : 'gray'; }

Page({
  data: {
    keyword: '',
    statusIndex: 0,
    statuses: ['全部状态', '正常', '黑名单', '停用'],
    statusValues: ['', 'normal', 'blacklist', 'inactive'],
    list: [],
    loading: false
  },
  onShow() { this.load(); },
  onSearchInput(e) { this.setData({ keyword: e.detail.value }); this.load(); },
  onStatus(e) { this.setData({ statusIndex: Number(e.detail.value) }); this.load(); },
  load() {
    const q = [];
    if (this.data.keyword) q.push('search=' + encodeURIComponent(this.data.keyword));
    const st = this.data.statusValues[this.data.statusIndex];
    if (st) q.push('status=' + st);
    this.setData({ loading: true });
    request('/api/members' + (q.length ? '?' + q.join('&') : '')).then((d) => {
      this.setData({
        loading: false,
        list: d.list.map((m) => ({
          ...m,
          genderText: genderLabel(m.gender),
          statusText: MEMBER_STATUS_LABEL[m.status] || m.status,
          statusClass: statusClass(m.status),
          tagsText: (m.tags || []).map((t) => t.tag_name).join('、')
        }))
      });
    }).catch((e) => { this.setData({ loading: false }); toast(e.message); });
  },
  goDetail(e) { wx.navigateTo({ url: '/pages/member-detail/member-detail?id=' + e.currentTarget.dataset.id }); }
});
