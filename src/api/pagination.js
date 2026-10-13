'use strict';
const { db } = require('../db');
const { httpError } = require('../http');

function paginate(sql, args = [], query = new URLSearchParams()) {
  const page = Number(query.get('page') || 1);
  const pageSize = Number(query.get('page_size') || 100);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000 || !Number.isSafeInteger((page - 1) * pageSize)) {
    throw httpError(400, '分页参数无效，page_size 须为 1 到 1000');
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...args).n;
  const list = db.prepare(sql + ' LIMIT ? OFFSET ?').all(...args, pageSize, (page - 1) * pageSize);
  return { list, total, page, page_size: pageSize, has_more: page * pageSize < total };
}
module.exports = { paginate };
