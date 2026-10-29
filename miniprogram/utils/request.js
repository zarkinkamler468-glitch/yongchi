const { BASE_URL } = require('../config');

const SCOPES = ['cashier', 'checkin', 'refund'];
function pendingKey(scope) {
  const user = wx.getStorageSync('user') || {};
  return `pms_pending_${BASE_URL}_${user.id || wx.getStorageSync('token') || 'current'}_${scope}`;
}
function pendingTransactions() {
  return SCOPES.map(scope => {
    const record = wx.getStorageSync(pendingKey(scope));
    if (!record) return null;
    return typeof record === 'object' && record.data?.request_id && typeof record.signature === 'string' && transactionScope(record.path) === scope ? { ...record, scope } : { scope, corrupt: true };
  }).filter(Boolean);
}
function discardPending(scope) {
  if (!SCOPES.includes(scope)) return false;
  wx.removeStorageSync(pendingKey(scope));
  return true;
}
function transactionScope(path) {
  if (path === '/api/orders') return 'cashier';
  if (path === '/api/entries/checkin') return 'checkin';
  if (/^\/api\/orders\/[^/]+\/refund$/.test(path)) return 'refund';
  return null;
}

// 统一请求封装：自动携带令牌、统一处理 401 跳转登录
function request(path, options = {}) {
  if (!BASE_URL) return Promise.reject(new Error('请先在 miniprogram/config.js 配置后端 HTTPS 域名（BASE_URL）'));
  const token = wx.getStorageSync('token') || '';
  const method = options.method || (options.data !== undefined ? 'POST' : 'GET');
  const scope = method === 'POST' ? transactionScope(path) : null;
  let data = options.data;
  let storageKey;
  let pendingId;
  try {
    if (scope) {
      storageKey = pendingKey(scope);
      const prior = wx.getStorageSync(storageKey);
      const signature = JSON.stringify({ ...data, request_id: undefined });
      if (prior) {
        if (typeof prior !== 'object' || !prior.data?.request_id || typeof prior.signature !== 'string' || transactionScope(prior.path) !== scope) throw new Error('待确认业务记录损坏，请联系维护人员核对流水');
        if (prior.path !== path || prior.signature !== signature) throw new Error('上一笔结果尚未确认，请在“我的”中恢复待确认业务');
        data = prior.data;
      } else {
        data = { ...data, request_id: data?.request_id || `${scope}-${Date.now()}-${Math.random().toString(36).slice(2)}` };
        wx.setStorageSync(storageKey, { path, data, signature, created_at: Date.now() });
      }
      pendingId = data.request_id;
    }
  } catch (error) { return Promise.reject(error); }
  const clearOwnPending = () => {
    if (storageKey && wx.getStorageSync(storageKey)?.data?.request_id === pendingId) wx.removeStorageSync(storageKey);
  };
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method,
      data,
      timeout: options.timeout || 15000,
      header: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {},
        options.header || {}
      ),
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const data = res.data;
          if (!data || typeof data !== 'object' || Array.isArray(data)
            || (scope === 'cashier' && (!data.order?.id || !Number.isFinite(data.amount)))
            || (scope === 'checkin' && !data.card?.id)
            || (scope === 'refund' && !data.refund?.id)) { reject(new Error('业务响应不完整，请恢复原请求确认结果')); return; }
          if (storageKey) {
            try { clearOwnPending(); } catch (error) { reject(error); return; }
          }
          if (method === 'GET' && !/[?&]page=/.test(path) && Array.isArray(data.list) && data.has_more) {
            (async () => {
              let page = data.page;
              let pages = 0;
              // 小程序 setData 单次有 1MB 上限：最多自动补 4 页（共 500 条），
              // 超出时提示用筛选缩小范围，避免整页白屏。
              while (data.has_more && pages < 4) {
                const next = await request(path + (path.includes('?') ? '&' : '?') + 'page=' + (++page), options);
                data.list.push(...next.list); data.has_more = next.has_more; pages += 1;
              }
              if (data.has_more) {
                data.truncated = true;
                toast('数据较多，仅加载前 ' + data.list.length + ' 条，请用搜索或筛选缩小范围');
              }
              return data;
            })().then(resolve, reject);
          } else resolve(data);
        } else if (res.statusCode === 401 && !['/api/auth/login', '/api/auth/wxbind', '/api/auth/wxlogin'].includes(path)) {
          wx.removeStorageSync('token');
          wx.removeStorageSync('user');
          wx.reLaunch({ url: '/pages/login/login' });
          reject(new Error((res.data && res.data.error) || '未登录'));
        } else {
          if (storageKey && [400, 422].includes(res.statusCode)) {
            try { clearOwnPending(); } catch (error) { reject(error); return; }
          }
          reject(Object.assign(new Error((res.data && res.data.error) || '请求失败(' + res.statusCode + ')'), { status: res.statusCode }));
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

module.exports = { request, toast, pendingTransactions, discardPending };
