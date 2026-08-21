'use strict';

const { makeRouter } = require('../http');
const members = require('./members');
const cards = require('./cards');
const orders = require('./orders');
const entries = require('./entries');
const shifts = require('./shifts');
const closings = require('./closings');
const reports = require('./reports');
const settings = require('./settings');
const auth = require('./auth');
const staff = require('./staff');
const smsSettings = require('./sms-settings');
const audit = require('./audit');

// 角色：boss 老板 / frontdesk 前台 / finance 财务
const BOSS = ['boss'];
const BOSS_FINANCE = ['boss', 'finance'];
const ALL = ['boss', 'frontdesk', 'finance'];
const FRONT = ['boss', 'frontdesk'];

function buildRouter() {
  const r = makeRouter({ audit: audit.record });
  const get = (p, h, o = {}) => r.add('GET', p, h, o);
  const post = (p, h, o = {}) => r.add('POST', p, h, o);
  const put = (p, h, o = {}) => r.add('PUT', p, h, o);
  const del = (p, h, o = {}) => r.add('DELETE', p, h, o);

  // 登录 / 会话
  get('/api/auth/captcha', auth.captcha);
  get('/api/auth/captcha-image', auth.captchaImage);
  get('/api/public-config', settings.publicConfig);
  post('/api/auth/login', auth.login, { action: '登录系统', module: 'auth' });
  post('/api/auth/wxlogin', auth.wxLogin, { action: '微信登录', module: 'auth' });
  post('/api/auth/wxbind', auth.wxBind, { action: '微信绑定员工', module: 'auth' });
  post('/api/auth/wxunbind', auth.wxUnbind, { action: '解绑微信', module: 'auth' });
  post('/api/auth/logout', auth.logout, { action: '退出登录', module: 'auth' });
  get('/api/auth/me', auth.me);

  // 会员
  get('/api/members', members.list, { roles: FRONT });
  get('/api/members/:id', members.get, { roles: FRONT });
  post('/api/members', members.create, { roles: FRONT, action: '会员建档', module: 'member', audit: false });
  put('/api/members/:id', members.update, { roles: FRONT, action: '编辑会员', module: 'member', audit: false });
  post('/api/members/:id/tags', members.addTag, { roles: FRONT, action: '添加会员标签', module: 'member', audit: false });
  del('/api/members/:id/tags/:tagId', members.removeTag, { roles: FRONT, action: '删除会员标签', module: 'member', audit: false });

  // 卡项（老板配置）
  get('/api/card-products', cards.listProducts);
  post('/api/card-products', cards.createProduct, { roles: BOSS, action: '新增卡项', module: 'card_product' });
  put('/api/card-products/:id', cards.updateProduct, { roles: BOSS, action: '编辑卡项', module: 'card_product' });
  del('/api/card-products/:id', cards.disableProduct, { roles: BOSS, action: '停用卡项', module: 'card_product' });

  // 会员卡账户
  get('/api/member-cards', cards.listCards, { roles: FRONT });
  get('/api/member-cards/:id', cards.getCard, { roles: FRONT });
  post('/api/member-cards/:id/freeze', cards.freeze, { roles: BOSS, action: '冻结会员卡', module: 'member_card', audit: false });
  post('/api/member-cards/:id/unfreeze', cards.unfreeze, { roles: BOSS, action: '解冻会员卡', module: 'member_card', audit: false });
  post('/api/member-cards/:id/extend', cards.extend, { roles: BOSS, action: '会员卡延期', module: 'member_card', audit: false });
  post('/api/member-cards/:id/transfer', cards.transfer, { roles: BOSS, action: '会员卡转卡', module: 'member_card', audit: false });
  post('/api/member-cards/:id/void', cards.voidCard, { roles: BOSS, action: '会员卡作废', module: 'member_card', audit: false });

  // 收银 / 订单 / 退款
  get('/api/orders', orders.list);
  get('/api/orders/:id', orders.get);
  post('/api/orders', orders.create, { roles: FRONT, action: '收银开单', module: 'order', audit: false });
  post('/api/orders/:id/refund', orders.refundApply, { roles: ALL, action: '退款申请', module: 'order', audit: false });
  get('/api/refunds', orders.refunds, { roles: BOSS_FINANCE });
  post('/api/refunds/:id/approve', orders.refundApprove, { roles: BOSS_FINANCE, action: '退款审批通过', module: 'order', audit: false });
  post('/api/refunds/:id/reject', orders.refundReject, { roles: BOSS_FINANCE, action: '退款审批驳回', module: 'order', audit: false });

  // 入场核销
  get('/api/entries', entries.list, { roles: FRONT });
  get('/api/entries/preview', entries.preview, { roles: FRONT });
  post('/api/entries/checkin', entries.checkin, { roles: FRONT, action: '入场核销', module: 'entry', audit: false });

  // 交班对账
  get('/api/shifts', shifts.list, { roles: FRONT });
  get('/api/shifts/current', shifts.current, { roles: FRONT });
  post('/api/shifts/start', shifts.start, { roles: FRONT, action: '开始班次', module: 'shift' });
  get('/api/shifts/:id', shifts.get, { roles: FRONT });
  post('/api/shifts/:id/close', shifts.close, { roles: FRONT, action: '交班对账', module: 'shift', audit: false });

  // 日结管理
  get('/api/closings', closings.list, { roles: BOSS_FINANCE });
  get('/api/closings/:date', closings.get, { roles: BOSS_FINANCE });
  post('/api/closings', closings.create, { roles: BOSS_FINANCE, action: '执行日结', module: 'daily_closing', audit: false });

  // 报表中心 / 首页
  get('/api/dashboard', reports.dashboard);
  get('/api/reports/overview', reports.overview, { roles: BOSS_FINANCE });
  get('/api/reports/staff-performance', reports.staffPerformance, { roles: BOSS_FINANCE });
  get('/api/reports/cards-expiring', reports.cardsExpiring, { roles: BOSS_FINANCE });
  get('/api/reports/export/orders', reports.exportOrders, { roles: BOSS_FINANCE });
  get('/api/reports/export/members', reports.exportMembers, { roles: BOSS_FINANCE });

  // 设置
  get('/api/settings', settings.get);
  put('/api/settings', settings.update, { roles: BOSS, action: '修改系统设置', module: 'settings' });
  get('/api/sms-settings', smsSettings.get, { roles: ['admin'] });
  put('/api/sms-settings', smsSettings.update, { roles: ['admin'], action: '修改短信配置', module: 'sms_settings' });
  post('/api/sms-settings/test', smsSettings.test, { roles: ['admin'], action: '测试短信发送', module: 'sms_settings' });

  // 员工权限（老板）
  get('/api/staff', staff.list, { roles: BOSS });
  post('/api/staff', staff.create, { roles: BOSS, action: '新增员工', module: 'staff' });
  put('/api/staff/:id', staff.update, { roles: BOSS, action: '编辑员工', module: 'staff' });
  del('/api/staff/:id', staff.remove, { roles: BOSS, action: '停用/启用员工', module: 'staff' });

  // 操作日志
  get('/api/operation-logs', audit.list, { roles: BOSS });

  return r;
}

module.exports = { buildRouter };
