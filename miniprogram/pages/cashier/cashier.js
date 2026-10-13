const { request, toast } = require('../../utils/request');
const { fmtMoney, payLabel } = require('../../utils/util');

Page({
  data: {
    mode: 'home', tab: 'open', memberMode: 'new', showMemberPicker: false, memberQuery: '', selectedMember: null, memberResults: [],
    checkinKeyword: '', checkinPeople: 1, checkinResult: null, checkinPreview: null,
    products: [], allProducts: [],
    memberIndex: 0,
    newName: '', newPhone: '', newGender: 'unknown',
    productIndex: 0,
    cards: [], cardOptions: [], cardIndex: 0,
    amount: '100', discount: '0',
    payMethod: 'cash',
    mixedPay: false, splitCash: '', splitWechat: '', splitAlipay: '', splitStored: '', storedCards: [], storedCardIndex: 0,
    payable: '¥0',
    payAmount: '',
    payManual: false, submitting: false, checkinSubmitting: false, requestId: '', checkinRequestId: ''
  },
  onShow() { this.loadBase(); },
  onUnload() { clearTimeout(this._memberSearchTimer); },
  loadBase() {
    request('/api/card-products').then((p) => {
      const products = (p.list || []).filter((x) => x.enabled);
      const card = this.data.cards[this.data.cardIndex];
      const filtered = this.data.tab === 'renew' && card ? products.filter(p => p.type === card.card_type) : products;
      this.setData({ products: filtered, allProducts: products, productIndex: Math.min(this.data.productIndex, Math.max(0, filtered.length - 1)) });
      this.compute();
    }).catch((e) => toast(e.message));
  },
  setTab(e) { const tab = e.currentTarget.dataset.tab; this.setData({ mode: 'form', tab, memberMode: tab === 'open' ? 'new' : 'existing', memberIndex: 0, selectedMember: null, memberQuery: '', memberResults: [], cardIndex: 0, cards: [], cardOptions: [], products: this.data.allProducts, productIndex: 0 }); this.compute(); },
  openCashier(e) { this.setTab(e); },
  goHome() { this.setData({ mode: 'home' }); },
  closeMemberPicker() { this.setData({ showMemberPicker: false }); },
  openCheckin() { this.setData({ mode: 'checkin', checkinKeyword: '', checkinPeople: 1, checkinResult: null, checkinPreview: null }); },
  onCheckinInput(e) { if (this.data.checkinSubmitting) return; this._checkinVersion = (this._checkinVersion || 0) + 1; this.setData({ [e.currentTarget.dataset.key]: e.detail.value, checkinPreview: null, checkinResult: null }); },
  submitCheckin() {
    if (this.data.checkinSubmitting) return;
    if (this._pendingCheckin) { this.confirmCheckin(); return; }
    if (!this.data.checkinKeyword.trim()) { toast('请输入卡号、手机号或会员编号'); return; }
    const people = Number(this.data.checkinPeople) || 1;
    const keyword = this.data.checkinKeyword.trim();
    const version = this._checkinVersion = (this._checkinVersion || 0) + 1;
    this.setData({ checkinPreview: null });
    request('/api/entries/preview?keyword=' + encodeURIComponent(this.data.checkinKeyword.trim()) + '&people=' + people)
      .then((d) => { if (version === this._checkinVersion) this.setData({ checkinPreview: { ...d, keyword, people: d.card.people }, checkinResult: { ok: true, pending: true, name: d.member.name, phone: d.member.phone, card: d.card.card_name, asset: d.card.card_type === 'count' ? `本次扣 ${d.card.preview_deducted_uses} 次，剩余 ${Math.max(0, Number(d.card.remaining_uses) - Number(d.card.preview_deducted_uses))} 次` : d.card.card_type === 'stored' ? `本次扣 ${d.card.preview_deducted_amount} 元，余额 ${Math.max(0, Number(d.card.balance) - Number(d.card.preview_deducted_amount))} 元` : `有效期至 ${d.card.end_at || '—'}` } }); })
      .catch((e) => { if (version === this._checkinVersion) this.setData({ checkinPreview: null, checkinResult: { ok: false, error: e.message } }); });
  },
  confirmCheckin() {
    const p = this._pendingCheckin || this.data.checkinPreview;
    if (!p || this.data.checkinSubmitting) return;
    const rid = this.data.checkinRequestId || `checkin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.setData({ checkinSubmitting: true, checkinRequestId: rid });
    this._pendingCheckin = { ...p };
    request('/api/entries/checkin', { data: { keyword: p.keyword, card_id: p.card && p.card.id, people: p.people, gate_no: '小程序收银', confirmed: true, request_id: rid } })
      .then((d) => { this._pendingCheckin = null; this.setData({ checkinSubmitting: false, checkinRequestId: '', checkinPreview: null, checkinResult: { ok: true, pending: false, name: d.member.name, phone: d.member.phone, card: d.card.card_name, asset: d.card.card_type === 'count' ? `核销成功，剩余 ${d.card.remaining_uses} 次` : d.card.card_type === 'stored' ? `核销成功，余额 ${d.card.balance} 元` : `核销成功，有效期至 ${d.card.end_at || '—'}` } }); })
      .catch((e) => { const rejected = e.status >= 400 && e.status < 500; if (rejected) this._pendingCheckin = null; this.setData({ checkinSubmitting: false, checkinRequestId: rejected ? '' : rid, checkinResult: { ok: false, error: e.message } }); });
  },
  searchMember(e) {
    const q = (e.detail.value || '').trim();
    this.setData({ memberQuery: q, memberResults: [], showMemberPicker: false, selectedMember: null, memberIndex: 0, cards: [], cardOptions: [], cardIndex: 0, storedCards: [], storedCardIndex: 0 });
    clearTimeout(this._memberSearchTimer);
    if (!q) return;
    this._memberSearchTimer = setTimeout(() => {
      const path = '/api/members?status=normal&search=' + encodeURIComponent(q);
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
  chooseNewMember() { this.setData({ memberMode: 'new', memberIndex: 0, selectedMember: null, memberQuery: '', showMemberPicker: false, cards: [], storedCards: [], storedCardIndex: 0 }); },
  chooseExistingMember() { this.setData({ memberMode: 'existing', memberIndex: 0, selectedMember: null, memberQuery: '', memberResults: [], cards: [], storedCards: [], storedCardIndex: 0 }); },
  chooseMember(e) {
    const m = this.data.memberResults.find((x) => Number(x.id) === Number(e.currentTarget.dataset.id));
    if (!m) return;
    this.setData({ memberMode: 'existing', memberIndex: 1, selectedMember: m, memberQuery: `${m.member_no} · ${m.name}`, showMemberPicker: false });
    request('/api/member-cards?member_id=' + m.id).then(d => {
      if (this.data.selectedMember?.id !== m.id) return;
      const today = new Date(); const date = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
      this.setData({ storedCards: [{ id: null, label: '自动选择可用储值卡' }, ...d.list.filter(c => c.card_type === 'stored' && c.status === 'normal' && (!c.start_at || c.start_at <= date)).map(c => ({ ...c, label: `${c.card_no} · ${fmtMoney(c.balance)}` }))], storedCardIndex: 0 });
    }).catch(e => toast(e.message));
    if (['renew', 'recharge'].includes(this.data.tab)) this.loadCards(m.id);
  },
  loadCards(memberId) {
    const tab = this.data.tab;
    const version = this._cardLoadVersion = (this._cardLoadVersion || 0) + 1;
    this.setData({ cards: [], cardOptions: [], cardIndex: 0 });
    request('/api/member-cards?member_id=' + memberId).then((d) => {
      if (version !== this._cardLoadVersion || this.data.selectedMember?.id !== memberId || this.data.tab !== tab) return;
      const type = this.data.tab === 'renew' ? '' : 'stored';
      const cards = (d.list || []).filter((c) => type ? c.card_type === type : true);
      const cardOptions = cards.map((c) => ({ ...c, label: `${c.card_no} · ${c.card_name || ''} · ${c.status === 'void' ? '已作废' : c.status === 'refunded' ? '已退款' : c.status === 'frozen' ? '已冻结' : c.card_type === 'stored' ? fmtMoney(c.balance) : (c.remaining_uses || 0) + '次'}` }));
      const firstUsable = Math.max(0, cards.findIndex((c) => !['void', 'refunded', 'frozen'].includes(c.status)));
      this.setData({ cards, cardOptions, cardIndex: firstUsable });
      this.filterRenewProducts(cards[firstUsable]);
    }).catch(() => {});
  },
  pickProduct(e) { this.setData({ productIndex: Number(e.detail.value) }); this.compute(); },
  pickCard(e) { const idx = Number(e.detail.value); const card = this.data.cards[idx]; if (!card) return; if (['void', 'refunded', 'frozen'].includes(card.status)) { toast('已作废、退款或冻结的卡不可办理'); return; } this.setData({ cardIndex: idx }); this.filterRenewProducts(card); },
  filterRenewProducts(card) {
    if (this.data.tab !== 'renew') return;
    const products = card ? this.data.allProducts.filter((p) => p.type === card.card_type) : this.data.allProducts;
    this.setData({ products, productIndex: 0 }); this.compute();
  },
  onInput(e) { this.setData({ [e.currentTarget.dataset.key]: e.detail.value }); this.compute(); },
  onAmountInput(e) { this.setData({ payAmount: e.detail.value, payManual: true }); },
  pickPay(e) { this.setData({ payMethod: e.currentTarget.dataset.pay }); },
  toggleMixedPay(e) { this.setData({ mixedPay: e.detail.value }); },
  pickStoredCard(e) { this.setData({ storedCardIndex: Number(e.detail.value) }); },
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
    if (this.data.submitting) return;
    const { tab, selectedMember, newName, newPhone, newGender, products, productIndex, cards, cardIndex, amount, discount, payMethod, payAmount } = this.data;
    const memberId = selectedMember && selectedMember.id;
    const selectedCard = cards[cardIndex];
    const payable = Number(payAmount);
    if (!Number.isFinite(payable) || payable < 0) { toast('实收金额不能为负数'); return; }
    let payments = payable > 0 ? [{ pay_method: payMethod, amount: payable }] : [];
    if (this.data.mixedPay) {
      payments = [['cash','splitCash'],['wechat','splitWechat'],['alipay','splitAlipay'],['stored','splitStored']].map(([method,key]) => ({ pay_method: method, amount: Number(this.data[key] || 0) }));
      if (payments.some(p => !Number.isFinite(p.amount) || p.amount < 0)) { toast('拆分金额必须为非负数'); return; }
      payments = payments.filter(p => p.amount > 0);
    }
    const total = tab === 'recharge' ? Number(amount) : Number(products[productIndex]?.price || 0);
    if (payments.reduce((n,p) => n + Math.round(p.amount*100),0) !== Math.round((total - Number(discount || 0))*100)) { toast('支付合计必须等于应收金额'); return; }
    const source = this.data.storedCards[this.data.storedCardIndex];
    payments.forEach(p => { if (p.pay_method === 'stored' && source?.id) p.source_card_id = source.id; });
    if (tab === 'open' && !memberId && !newName.trim()) { toast('请选择已有会员或填写新会员姓名'); return; }
    if (['renew', 'recharge'].includes(tab) && !memberId) { toast('请先查询并选择会员'); return; }
    if (['renew', 'recharge'].includes(tab) && selectedCard && ['void', 'refunded', 'frozen'].includes(selectedCard.status)) { toast('已作废、退款或冻结的卡不可办理'); return; }
    const body = {
      order_type: tab,
      member_id: memberId,
      name: newName, phone: newPhone, gender: newGender,
      card_product_id: products[productIndex] ? products[productIndex].id : undefined,
      member_card_id: cards[cardIndex] ? cards[cardIndex].id : undefined,
      discount_amount: Number(discount) || 0,
      payments
    };
    const rid = this.data.requestId || `cashier-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    body.request_id = rid;
    if (tab === 'recharge') body.amount = Number(amount);
    const signature = JSON.stringify({ ...body, request_id: undefined });
    if (this._pendingSale && this._pendingSale.signature !== signature) { toast('上一笔结果尚未确认，请恢复原参数重试后再办理新业务'); return; }
    this._pendingSale = { signature };
    this.setData({ submitting: true, requestId: rid });
    wx.showLoading({ title: '收款中', mask: true });
    request('/api/orders', { data: body }).then((d) => {
      this._pendingSale = null;
      wx.hideLoading();
      wx.showModal({ title: '收款成功', content: fmtMoney(d.amount), showCancel: false, confirmText: '继续' });
      this.setData({ submitting: false, requestId: '', mixedPay: false, splitCash: '', splitWechat: '', splitAlipay: '', splitStored: '', storedCards: [], storedCardIndex: 0, memberMode: tab === 'open' ? 'new' : 'existing', memberIndex: 0, selectedMember: null, memberQuery: '', memberResults: [], newName: '', newPhone: '', newGender: 'unknown', discount: '0', payManual: false, amount: '100', cards: [], cardOptions: [], cardIndex: 0 });
      this.loadBase();
    }).catch((e) => { wx.hideLoading(); const rejected = e.status >= 400 && e.status < 500; if (rejected) this._pendingSale = null; this.setData({ submitting: false, requestId: rejected ? '' : rid }); toast(e.message); });
  }
});
