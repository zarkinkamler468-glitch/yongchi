const { BASE_URL } = require('../config');

// 统一请求封装：自动携带令牌、统一处理 401 跳转登录
function request(path, options = {}) {
  const token = wx.getStorageSync('token') || '';
  const method = options.method || (options.data !== undefined ? 'POST' : 'GET');
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method,
      data: options.data,
      timeout: options.timeout || 15000,
      header: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {},
        options.header || {}
      ),
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else if (res.statusCode === 401 && path !== '/api/auth/login') {
          wx.removeStorageSync('token');
          wx.removeStorageSync('user');
          wx.reLaunch({ url: '/pages/login/login' });
          reject(new Error((res.data && res.data.error) || '未登录'));
        } else {
          reject(new Error((res.data && res.data.error) || '请求失败(' + res.statusCode + ')'));
        }
      },
      fail() {
        reject(new Error('网络错误，请检查服务地址与网络'));
      }
    });
  });
}

function toast(title, icon = 'none') {
  wx.showToast({ title, icon });
}

module.exports = { request, toast };
