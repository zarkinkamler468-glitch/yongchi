App({
  globalData: {
    user: null,
    token: ''
  },
  onLaunch() {
    this.globalData.token = wx.getStorageSync('token') || '';
    this.globalData.user = wx.getStorageSync('user') || null;
  }
});
