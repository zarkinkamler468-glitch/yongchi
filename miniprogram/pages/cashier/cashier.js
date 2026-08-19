const { request, toast } = require('../../utils/request');
const { fmtMoney, payLabel } = require('../../utils/util');

Page({
  data: {
    mode: 'home', tab: 'open', showMemberPicker: false, memberQuery: '', selectedMember: null, memberResults: [],
    checkinKeyword: '', checkinPeople: 1, checkinResult: null, checkinPreview: null,
    members: [],
    products: [], allProducts: [],
    memberNames: ['新会员'],
    memberIndex: 0,
    newName: '', newPhone: '', newGender: 'unknown',
    productIndex: 0,
    cards: [], cardOptions: [], cardIndex: 0,
    amount: '100', discount: '0',
    payMethod: 'cash',
    payable: '¥0',
    payAmount: '',
    payManual: false
  },
  onShow() { this.loadBase(); },
  loadBase() {
    Promise.all([request('/api/members?status=normal'), request('/api/card-products')]).then(([m, p]) => {
      const members = m.list || [];
      const products = (p.list || []).filter((x) => x.enabled);
      this.setData({
        members, products, allProducts: products,
        memberNames: ['新会员'].concat(members.map((x) => x.member_no + ' · ' + x.name))
      });
      this.compute();
    }).catch((e) => toast(e.message));
  },
  setTab(e) { this.setData({ mode: 'form', tab: e.currentTarget.dataset.tab, cardIndex: 0, cards: [], products: this.data.allProducts, productIndex: 0 }); this.compute(); },
  openCashier(e) { this.setTab(e); },
  goHome() { this.setData({ mode: 'home' }); },
  closeMemberPicker() { this.setData({ showMemberPicker: false }); },
  openCheckin() { this.setData({ mode: 'checkin', checkinKeyword: '', checkinPeople: 1, checkinResult: null, checkinPreview: null }); },
  onCheckinInput(e) { this.setData({ [e.currentTarget.dataset.key]: e.detail.value }); },
  submitCheckin() {
    if (!this.data.checkinKeyword.trim()) { toast('请输入卡号、手机号或会员编号'); return; }
    const people = Number(this.data.checkinPeople) || 1;
    request('/api/entries/preview?keyword=' + encodeURIComponent(this.data.checkinKeyword.trim()) + '&people=' + people)
      .then((d) => this.setData({ checkinPreview: d, checkinResult: { ok: true, pending: true, name: d.member.name, phone: d.member.phone, card: d.card.card_name, asset: d.card.card_type === 'count' ? `本次扣 ${d.card.preview_deducted_uses} 次，剩余 ${Math.max(0, Number(d.card.remaining_uses) - Number(d.card.preview_deducted_uses))} 次` : d.card.card_type === 'stored' ? `本次扣 ${d.card.preview_deducted_amount} 元，余额 ${Math.max(0, Number(d.card.balance) - Number(d.card.preview_deducted_amount))} 元` : `有效期至 ${d.card.end_at || '—'}` } }))
      .catch((e) => this.setData({ checkinResult: { ok: false, error: e.message } }));
  },
  confirmCheckin() {
    const p = this.data.checkinPreview;
    if (!p) return;
    request('/api/entries/checkin', { data: { keyword: this.data.checkinKeyword.trim(), people: Number(this.data.checkinPeople) || 1, gate_no: '小程序收银', confirmed: true } })
      .then((d) => this.setData({ checkinPreview: null, checkinResult: { ok: true, pending: false, name: d.member.name, phone: d.member.phone, card: d.card.card_name, asset: d.card.card_type === 'count' ? `核销成功，剩余 ${d.card.remaining_uses} 次` : d.card.card_type === 'stored' ? `核销成功，余额 ${d.card.balance} 元` : `核销成功，有效期至 ${d.card.end_at || '—'}` } }))
      .catch((e) => this.setData({ checkinResult: { ok: false, error: e.message } }));
  },
  searchMember(e) {
    const q = (e.detail.value || '').trim();
    this.setData({ memberQuery: q, memberResults: [], showMemberPicker: false });
    clearTimeout(this._memberSearchTimer);
    if (!q) return;
    this._memberSearchTimer = setTimeout(() => {
      const path = '/api/members?status=normal&search=' + encodeURIComponent(q.replace(/[\\s-]/g, ''));
      request(path).then((d) => {
        if (this.data.memberQuery !== q) return;
        this.setData({ memberResults: (d.list || []).slice(0, 30), showMemberPicker: true });
      }).catch(() => {
        if (this.data.memberQuery === q) this.setData({ memberResults: [], showMemberPicker: true });
      });
    }, 250);
  },
  openMemberPicker() {
    // 未输入关键词时只打开搜索面板，不预先展示大量会员，避免误选。
    this.setData({ memberResults: [], showMemberPicker: true });
  },
  chooseNewMember() { this.setData({ memberIndex: 0, selectedMember: null, memberQuery: '', showMemberPicker: false, cards: [] }); },
  chooseMember(e) {
    const m = this.data.members.find((x) => Number(x.id) === Number(e.currentTarget.dataset.id));
    if (!m) return;
    this.setData({ memberIndex: this.data.members.indexOf(m) + 1, selectedMember: m, memberQuery: `${m.member_no} · ${m.name}`, showMemberPicker: false });
    if (['renew', 'recharge'].includes(this.data.tab)) this.loadCards(m.id);
  },
  pickMember(e) {
    const idx = Number(e.detail.value);
    this.setData({ memberIndex: idx, selectedMember: idx > 0 ? this.data.members[idx - 1] : null });
    if (['renew', 'recharge'].includes(this.data.tab) && idx > 0) this.loadCards(this.data.members[idx - 1].id);
  },
  loadCards(memberId) {
    request('/api/member-cards?member_id=' + memberId).then((d) => {
      const type = this.data.tab === 'renew' ? '' : 'stored';
      const cards = (d.list || []).filter((c) => type ? c.card_type === type : true);
      const cardOptions = cards.map((c) => ({ ...c, label: `${c.card_no} · ${c.card_name || ''} · ${c.status === 'void' ? '已作废' : c.status === 'refunded' ? '已退款' : c.status === 'frozen' ? '已冻结' : c.card_type === 'stored' ? fmtMoney(c.balance) : (c.remaining_uses || 0) + '次'}` }));
      const firstUsable = Math.max(0, cards.findIndex((c) => !['void', 'refunded'].includes(c.status)));
      this.setData({ cards, cardOptions, cardIndex: firstUsable });
      this.filterRenewProducts(cards[firstUsable]);
    }).catch(() => {});
  },
  pickProduct(e) { this.setData({ productIndex: Number(e.detail.value) }); this.compute(); },
  pickCard(e) { const idx = Number(e.detail.value); const card = this.data.cards[idx]; if (!card) return; if (['void', 'refunded'].includes(card.status)) { toast('已作废或退款的卡不可办理'); return; } this.setData({ cardIndex: idx }); this.filterRenewProducts(card); },
  filterRenewProducts(card) {
    if (this.data.tab !== 'renew') return;
    const products = card ? this.data.allProducts.filter((p) => p.type === card.card_type) : this.data.allProducts;
    this.setData({ products, productIndex: 0 }); this.compute();
  },
  onInput(e) { this.setData({ [e.currentTarget.dataset.key]: e.detail.value }); this.compute(); },
  onAmountInput(e) { this.setData({ payAmount: e.detail.value, payManual: true }); },
  pickPay(e) { this.setData({ payMethod: e.currentTarget.dataset.pay }); },
  onGender(e) { const v = Number(e.detail.value); this.setData({ newGender: v === 1 ? 'male' : v === 2 ? 'female' : 'unknown' }); },
  compute() {
    const { tab, products, productIndex, amount, discount } = this.data;
    let total = 0;
    if (tab === 'open' || tab === 'renew') total = products[productIndex] ? Number(products[productIndex].price) : 0;
    else total = Number(amount) || 0;
    const payable = Math.max(0, (total - (Number(discount) || 0)));
    const patch = { payable: fmtMoney(payable) };
    if (!this.data.payManual) patch.payAmount = payable;
    this.setData(patch);
  },
  submit() {
    const { tab, members, memberIndex, newName, newPhone, newGender, products, productIndex, cards, cardIndex, amount, discount, payMethod, payAmount } = this.data;
    const memberId = memberIndex > 0 ? members[memberIndex - 1].id : undefined;
    const selectedCard = cards[cardIndex];
    const payable = Number(payAmount);
    if (!(payable > 0)) { toast('实收金额必须大于 0'); return; }
    if (!memberId && !newName.trim()) { toast('请选择会员或填写新会员姓名'); return; }
    if (['renew', 'recharge'].includes(tab) && selectedCard && ['void', 'refunded'].includes(selectedCard.status)) { toast('已作废或退款的卡不可办理'); return; }
    const body = {
      order_type: tab,
      member_id: memberId,
      name: newName, phone: newPhone, gender: newGender,
      card_product_id: products[productIndex] ? products[productIndex].id : undefined,
      member_card_id: cards[cardIndex] ? cards[cardIndex].id : undefined,
      discount_amount: Number(discount) || 0,
      payments: [{ pay_method: payMethod, amount: payable }]
    };
    if (tab === 'recharge') body.amount = Number(amount);
    wx.showLoading({ title: '收款中', mask: true });
    request('/api/orders', { data: body }).then((d) => {
      wx.hideLoading();
      wx.showModal({ title: '收款成功', content: fmtMoney(d.amount), showCancel: false, confirmText: '继续' });
      this.setData({ memberIndex: 0, newName: '', newPhone: '', newGender: 'unknown', discount: '0', payManual: false, amount: '100', cards: [], cardIndex: 0 });
      this.loadBase();
    }).catch((e) => { wx.hideLoading(); toast(e.message); });
  }
});
