const { request } = require('../../utils/request');
const { BASE_URL } = require('../../config');

Page({
  data: {
    checking: true,
    needBind: false,
    bindToken: '',
    username: '',
    password: '',
    error: '', captchaCode: '', captchaToken: '', captchaSrc: '',
    loading: false,
    storeName: '游泳馆管理',
    brandIcon: '泳', brandLogoImg: '', loginBg: '', icpNo: '', pseNo: ''
  },
  onLoad() {
    // 加载公开品牌配置（无需登录）
    request('/api/public-config').then((d) => {
      const settings = d.settings || {};
      this.setData({
        storeName: settings.store_name || '游泳馆管理', brandIcon: settings.brand_icon || '泳',
        brandLogoImg: settings.brand_logo_img || '', loginBg: settings.login_bg || '',
        icpNo: settings.icp_no || '', pseNo: settings.public_security_no || ''
      });
    }).catch(() => {});
    this.loadCaptcha();
    // 已有令牌则尝试自动登录
    const token = wx.getStorageSync('token');
    if (!token) { this.setData({ checking: false }); return; }
    request('/api/auth/me').then(() => {
      wx.switchTab({ url: '/pages/index/index' });
    }).catch(() => this.setData({ checking: false }));
  },
  loadCaptcha() {
    request('/api/auth/captcha').then((d) => this.setData({
      captchaToken: d.captcha_token,
      captchaSrc: BASE_URL + d.image_path
    })).catch(() => {});
  },
  // 微信登录（免密）
  wxLogin() {
    const self = this;
    wx.login({
      success(res) {
        if (!res.code) { self.setData({ error: '微信登录失败' }); return; }
        self.setData({ loading: true, error: '' });
        request('/api/auth/wxlogin', { data: { code: res.code } }).then((d) => {
          if (d.need_bind) {
            self.setData({ needBind: true, bindToken: d.bind_token, loading: false });
          } else {
            wx.setStorageSync('token', d.token);
            wx.setStorageSync('user', d.user);
            wx.switchTab({ url: '/pages/index/index' });
          }
        }).catch((e) => self.setData({ error: e.message, loading: false }));
      },
      fail() { self.setData({ error: '微信登录失败' }); }
    });
  },
  // 账号密码登录
  onInput(e) {
    const k = e.currentTarget.dataset.key;
    this.setData({ [k]: e.detail.value, error: '' });
  },
  pwdLogin() {
    const { username, password, loading } = this.data;
    if (loading) return;
    if (!username || !password) { this.setData({ error: '请输入账号和密码' }); return; }
    this.setData({ loading: true, error: '' });
    request('/api/auth/login', { data: { username, password, captcha_token: this.data.captchaToken, captcha_code: this.data.captchaCode } }).then((d) => {
      wx.setStorageSync('token', d.token);
      wx.setStorageSync('user', d.user);
      wx.switchTab({ url: '/pages/index/index' });
    }).catch((e) => { this.setData({ error: e.message, loading: false, captchaCode: '' }); this.loadCaptcha(); });
  },
  // 绑定微信（账号密码验证后绑定）
  bindSubmit() {
    const { bindToken, username, password } = this.data;
    if (!username || !password) { this.setData({ error: '请输入账号和密码以绑定' }); return; }
    this.setData({ loading: true, error: '' });
    request('/api/auth/wxbind', { data: { bind_token: bindToken, username, password } }).then((d) => {
      wx.setStorageSync('token', d.token);
      wx.setStorageSync('user', d.user);
      wx.switchTab({ url: '/pages/index/index' });
    }).catch((e) => this.setData({ error: e.message, loading: false }));
  },
  cancelBind() { this.setData({ needBind: false, bindToken: '' }); }
});
