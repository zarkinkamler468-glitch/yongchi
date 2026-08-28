'use strict';

const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const { db, getSetting } = require('../db');
const { now, today, isDateString, money } = require('../util');
const { nextMemberNo, nextCardNo, normalizePhone } = require('./common');
const { ok, fail, httpError } = require('../http');
const audit = require('./audit');

const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_ROWS = 5000;
const HEADERS = ['姓名', '手机号', '会员号', '性别', '生日', '备注', '建档日期', '卡号', '卡项名称', '卡种', '剩余次数', '储值余额', '开始日期', '结束日期', '卡状态', '冻结开始', '冻结截止'];
const REQUIRED_HEADERS = ['姓名', '卡项名称', '卡种'];
const FIELDS = ['name','phone','member_no','gender','birthday','note','member_created_at','card_no','card_name','card_type','remaining_uses','balance','start_at','end_at','card_status','frozen_from','frozen_until'];
const FIELD_MAP = Object.fromEntries(HEADERS.map((h, i) => [h, FIELDS[i]]));
const TYPES = new Set(['count', 'month', 'year', 'stored']);
const STATUSES = new Set(['normal', 'frozen', 'expired', 'void', 'refunded']);

function displayValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,'0')}-${String(v.getDate()).padStart(2,'0')}`;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((x) => x.text || '').join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
  }
  return String(v).trim();
}

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (quoted) throw httpError(400, 'CSV 引号格式不完整');
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

async function fileMatrix(buffer, filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'csv') return parseCsv(buffer.toString('utf8').replace(/^\ufeff/, ''));
  if (ext !== 'xlsx') throw httpError(400, '仅支持 .xlsx 和 .csv；旧版 .xls 请先另存为 .xlsx');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer, { ignoreNodes: ['dataValidations'] }); } catch (_) { throw httpError(400, 'Excel 文件损坏或格式不受支持'); }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw httpError(400, 'Excel 没有工作表');
  if (sheet.columnCount > HEADERS.length) throw httpError(400, 'Excel 包含模板之外的列，请使用系统模板并删除多余列');
  if (sheet.rowCount > MAX_ROWS + 1) throw httpError(400, `单次最多导入 ${MAX_ROWS} 行`);
  const rows = [];
  for (let i = 1; i <= sheet.rowCount; i++) {
    const out = [];
    for (let j = 1; j <= sheet.columnCount; j++) out.push(displayValue(sheet.getCell(i, j).value));
    rows.push(out);
  }
  return rows;
}

function decodeBody(body) {
  const encoded = String(body.data || '').replace(/^data:.*?;base64,/, '');
  if (!encoded) throw httpError(400, '请上传文件');
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw httpError(400, '文件不能为空且不能超过 3MB');
  return buffer;
}

async function parseFile(body) {
  const buffer = decodeBody(body);
  const matrix = await fileMatrix(buffer, body.filename);
  if (!matrix.length) throw httpError(400, '文件为空');
  if (matrix.length - 1 > MAX_ROWS) throw httpError(400, `单次最多导入 ${MAX_ROWS} 行`);
  const headers = matrix[0].map(displayValue);
  const duplicateHeaders = headers.filter((h, i) => h && headers.indexOf(h) !== i);
  const unknownHeaders = headers.filter((h) => h && !HEADERS.includes(h));
  const missingHeaders = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (duplicateHeaders.length) throw httpError(400, `表头重复：${[...new Set(duplicateHeaders)].join('、')}`);
  if (unknownHeaders.length) throw httpError(400, `存在不支持的列：${unknownHeaders.join('、')}，请使用系统模板`);
  if (missingHeaders.length) throw httpError(400, `缺少必填列：${missingHeaders.join('、')}`);
  if (headers.length !== HEADERS.length || HEADERS.some((h, i) => headers[i] !== h)) throw httpError(400, '模板列名或顺序已改变，请重新下载系统模板填写');
  const fields = headers.map((h) => FIELD_MAP[h] || null);
  const rows = matrix.slice(1).map((line, i) => {
    const row = { row: i + 2 }; FIELDS.forEach((f) => { row[f] = ''; });
    fields.forEach((f, j) => { if (f) row[f] = displayValue(line[j]); });
    return row;
  }).filter((r) => FIELDS.some((f) => r[f] !== ''));
  if (!rows.length) throw httpError(400, '模板中没有会员数据');
  return { rows, hash: crypto.createHash('sha256').update(buffer).digest('hex') };
}

function nonNegative(v, label, integer = false) {
  if (v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) throw new Error(`${label}格式无效`);
  return integer ? n : money(n);
}
function sameText(a, b) { return String(a || '').trim() === String(b || '').trim(); }

function inspect(rows) {
  const products = db.prepare('SELECT * FROM card_products ORDER BY id').all();
  const productsByName = new Map();
  for (const p of products) productsByName.set(p.name, productsByName.has(p.name) ? null : p);
  const preview = []; const errors = []; const identities = new Map(); const identityMemberNos = new Map(); const seenCards = new Set(); const seenMemberNos = new Map();
  for (const r of rows) {
    const e = []; const phone = normalizePhone(r.phone); const status = r.card_status || 'normal';
    if (!r.name) e.push('姓名不能为空'); else if (r.name.length > 50) e.push('姓名不能超过50个字');
    if (r.note.length > 500) e.push('备注不能超过500个字');
    if (phone && !/^1\d{10}$/.test(phone)) e.push('手机号格式无效');
    if (r.member_no && r.member_no.length > 50) e.push('会员号不能超过50位');
    if (r.gender && !['male','female','unknown'].includes(r.gender)) e.push('性别须为 male/female/unknown');
    for (const [key, label] of [['birthday','生日'],['member_created_at','建档日期'],['start_at','开始日期'],['end_at','结束日期'],['frozen_from','冻结开始'],['frozen_until','冻结截止']]) {
      if (r[key] && !isDateString(r[key])) e.push(`${label}须为 YYYY-MM-DD`);
    }
    if (r.member_created_at && r.member_created_at > today()) e.push('建档日期不能晚于今天');
    if (r.birthday && r.birthday > today()) e.push('生日不能晚于今天');
    if (r.start_at && r.start_at > today()) e.push('开始日期不能晚于今天，否则会员卡尚未生效');
    if (r.start_at && r.end_at && r.end_at < r.start_at) e.push('结束日期不能早于开始日期');
    if (!TYPES.has(r.card_type)) e.push('卡种须为 count/month/year/stored');
    if (!STATUSES.has(status)) e.push('卡状态无效');
    const product = productsByName.get(r.card_name);
    if (!r.card_name) e.push('卡项名称不能为空');
    else if (product === null) e.push(`卡项“${r.card_name}”存在重名，请先整理卡项`);
    else if (!product) e.push(`找不到卡项“${r.card_name}”，请先在卡项管理创建`);
    else if (product.type !== r.card_type) e.push('卡种与系统卡项不一致');
    let uses = 0; let balance = 0;
    try { uses = nonNegative(r.remaining_uses, '剩余次数', true); } catch (x) { e.push(x.message); }
    try { balance = nonNegative(r.balance, '储值余额'); } catch (x) { e.push(x.message); }
    if (r.card_type === 'count' && balance !== 0) e.push('次卡不能填写储值余额');
    if (r.card_type === 'stored' && uses !== 0) e.push('储值卡不能填写剩余次数');
    if (['month','year'].includes(r.card_type) && (uses !== 0 || balance !== 0)) e.push('期限卡不能填写次数或余额');
    if (['month','year'].includes(r.card_type) && !r.end_at) e.push('月卡/年卡必须填写结束日期');
    if (status === 'normal' && r.end_at && r.end_at < today()) e.push('结束日期已过，应将卡状态设为 expired');
    if (status === 'expired' && (!r.end_at || r.end_at >= today())) e.push('过期卡必须填写早于今天的结束日期');
    if (['void','refunded'].includes(status) && (uses !== 0 || balance !== 0)) e.push('作废/退款卡的次数和余额必须为0');
    if (status === 'frozen' && !r.frozen_from) e.push('冻结卡必须填写冻结开始日期');
    if (r.frozen_from && r.frozen_from > today()) e.push('冻结开始日期不能晚于今天');
    if (status !== 'frozen' && (r.frozen_from || r.frozen_until)) e.push('非冻结卡不能填写冻结日期');
    if (r.frozen_from && r.frozen_until && r.frozen_until < r.frozen_from) e.push('冻结截止不能早于冻结开始');
    if (r.card_no.length > 100) e.push('卡号不能超过100位');
    const normalizedCard = r.card_no.replace(/[\s-]/g, '');
    if (normalizedCard && seenCards.has(normalizedCard)) e.push('文件内卡号重复'); else if (normalizedCard) seenCards.add(normalizedCard);
    if (normalizedCard && db.prepare("SELECT id FROM member_cards WHERE REPLACE(REPLACE(card_no,' ',''),'-','')=?").get(normalizedCard)) e.push('卡号已存在');
    const byPhone = phone ? db.prepare('SELECT * FROM members WHERE phone = ?').get(phone) : null;
    const byNo = r.member_no ? db.prepare('SELECT * FROM members WHERE member_no = ?').get(r.member_no) : null;
    if (byPhone && byNo && Number(byPhone.id) !== Number(byNo.id)) e.push('手机号和会员号分别属于两个不同会员');
    const member = byPhone || byNo || null;
    if (byPhone && r.member_no && byPhone.member_no !== r.member_no) e.push(`手机号所属会员号为“${byPhone.member_no}”，与导入会员号不一致`);
    if (byNo && phone && byNo.phone && byNo.phone !== phone) e.push('会员号所属手机号与导入手机号不一致');
    if (member && !sameText(member.name, r.name)) e.push(`已有会员姓名为“${member.name}”，与导入姓名不一致`);
    if (member && r.gender && r.gender !== 'unknown' && member.gender !== 'unknown' && member.gender !== r.gender) e.push('已有会员性别与导入数据不一致');
    if (member && r.birthday && member.birthday && member.birthday !== r.birthday) e.push('已有会员生日与导入数据不一致');
    const identityKey = member ? `id:${member.id}` : phone ? `phone:${phone}` : r.member_no ? `no:${r.member_no}` : `row:${r.row}`;
    const profile = `${r.name}|${r.gender || 'unknown'}|${r.birthday || ''}`;
    if (identities.has(identityKey) && identities.get(identityKey) !== profile) e.push('同一会员的姓名、性别或生日不一致'); else identities.set(identityKey, profile);
    if (r.member_no) { const priorNo=identityMemberNos.get(identityKey); if (priorNo && priorNo!==r.member_no) e.push('同一会员填写了不同会员号'); else identityMemberNos.set(identityKey,r.member_no); }
    if (r.member_no) { const owner = seenMemberNos.get(r.member_no); if (owner && owner !== identityKey) e.push('文件内会员号被不同会员重复使用'); else seenMemberNos.set(r.member_no, identityKey); }
    preview.push({ row:r.row, name:r.name, phone, member_no:r.member_no || member?.member_no || '', card_name:r.card_name, card_no:r.card_no, action:member?'关联已有会员':'新建历史会员', error:e.join('；') });
    if (e.length) errors.push({ row:r.row, message:e.join('；') });
  }
  return { rows, preview, errors };
}

async function preview({ body }) { const parsed=await parseFile(body); const checked=inspect(parsed.rows); return ok({preview:checked.preview,errors:checked.errors,total:checked.rows.length,file_hash:parsed.hash,preview_limit:100}); }

async function commit({ body, req }) {
  const parsed=await parseFile(body);
  // 幂等重试应优先识别已成功导入的文件；否则显式卡号会先触发“卡号已存在”校验。
  const prior=db.prepare('SELECT * FROM member_import_batches WHERE file_hash=?').get(parsed.hash);
  if (prior) return ok({imported:prior.row_count,repeated:true,imported_at:prior.imported_at});
  const checked=inspect(parsed.rows);
  if (checked.errors.length) return fail(400, `导入校验失败：第 ${checked.errors[0].row} 行：${checked.errors[0].message}`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing=db.prepare('SELECT * FROM member_import_batches WHERE file_hash=?').get(parsed.hash);
    if (existing) { db.exec('COMMIT'); return ok({imported:existing.row_count,repeated:true,imported_at:existing.imported_at}); }
    const ts=now(); let memberCount=0; let cardCount=0;
    for (const r of checked.rows) {
      const phone=normalizePhone(r.phone); let member=phone?db.prepare('SELECT * FROM members WHERE phone=?').get(phone):null;
      if (!member && r.member_no) member=db.prepare('SELECT * FROM members WHERE member_no=?').get(r.member_no);
      if (!member) {
        const createdAt=r.member_created_at?`${r.member_created_at}T00:00:00`:ts;
        const mr=db.prepare(`INSERT INTO members(member_no,name,phone,gender,birthday,note,status,created_at,updated_at,is_imported) VALUES(?,?,?,?,?,?,'normal',?,?,1)`)
          .run(r.member_no||nextMemberNo(),r.name,phone||null,r.gender||'unknown',r.birthday||null,r.note||null,createdAt,ts);
        member=db.prepare('SELECT * FROM members WHERE id=?').get(Number(mr.lastInsertRowid)); memberCount++;
      }
      const product=db.prepare('SELECT * FROM card_products WHERE name=?').get(r.card_name);
      const entryFee=r.card_type==='stored'?(money(product.entry_fee)>0?money(product.entry_fee):money(getSetting('default_entry_fee'))):0;
      db.prepare(`INSERT INTO member_cards(member_id,card_product_id,card_no,card_type,start_at,end_at,remaining_uses,balance,entry_fee,status,frozen_from,frozen_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(member.id,product.id,r.card_no||nextCardNo(),r.card_type,r.start_at||r.member_created_at||today(),r.end_at||null,nonNegative(r.remaining_uses,'剩余次数',true),nonNegative(r.balance,'储值余额'),entryFee,r.card_status||'normal',r.frozen_from||null,r.frozen_until||null,ts,ts);
      cardCount++;
    }
    const br=db.prepare('INSERT INTO member_import_batches(file_hash,filename,row_count,imported_by,imported_at) VALUES(?,?,?,?,?)').run(parsed.hash,String(body.filename||'').slice(0,200),checked.rows.length,req.user.id,ts);
    audit.record({req,action:'批量导入会员',target_type:'member_import',target_id:Number(br.lastInsertRowid),after:{rows:checked.rows.length,members:memberCount,cards:cardCount}});
    db.exec('COMMIT'); return ok({imported:checked.rows.length,members:memberCount,cards:cardCount,repeated:false});
  } catch(e) { try{db.exec('ROLLBACK');}catch(_){} return fail(400,e.message||'导入失败'); }
}

function csvEscape(v){const s=String(v??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}
function exampleRow(){const p=db.prepare("SELECT * FROM card_products WHERE enabled=1 ORDER BY CASE type WHEN 'count' THEN 0 ELSE 1 END,id LIMIT 1").get()||db.prepare('SELECT * FROM card_products ORDER BY id LIMIT 1').get();const type=p?.type||'count';return ['张三','13800000000','','male','','历史会员','2025-01-01','',p?.name||'请先创建卡项',type,type==='count'?String(p.total_uses||1):'0',type==='stored'?String(p.stored_value||0):'0','2025-01-01',['month','year'].includes(type)?'2099-12-31':'', 'normal','',''];}
function csvTemplate(){return '\ufeff'+HEADERS.map(csvEscape).join(',')+'\n'+exampleRow().map(csvEscape).join(',')+'\n';}
async function xlsxTemplate(){
  const wb=new ExcelJS.Workbook(); wb.creator='游泳池管理系统'; wb.created=new Date();
  const ws=wb.addWorksheet('会员导入',{views:[{state:'frozen',ySplit:1}]});
  ws.addRow(HEADERS); ws.addRow(exampleRow());
  ws.getRow(1).height=28; ws.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}}; ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF2563EB'}}; ws.getRow(1).alignment={vertical:'middle',horizontal:'center'};
  [14,16,14,12,14,24,14,16,22,14,14,14,14,14,14,14,14].forEach((w,i)=>ws.getColumn(i+1).width=w);
  ws.autoFilter={from:'A1',to:'Q2'}; ws.getColumn(2).numFmt='@'; ws.getColumn(3).numFmt='@'; ws.getColumn(8).numFmt='@';
  ws.dataValidations.add('D2:D5001',{type:'list',allowBlank:true,formulae:['"male,female,unknown"']});
  ws.dataValidations.add('J2:J5001',{type:'list',allowBlank:false,formulae:['"count,month,year,stored"']});
  ws.dataValidations.add('O2:O5001',{type:'list',allowBlank:false,formulae:['"normal,frozen,expired,void,refunded"']});
  const refs=wb.addWorksheet('卡项参考'); refs.addRow(['卡项名称','卡种','启用状态']);
  const products=db.prepare('SELECT name,type,enabled FROM card_products ORDER BY enabled DESC,id').all(); products.forEach((p)=>refs.addRow([p.name,p.type,p.enabled?'启用':'停用']));
  refs.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}}; refs.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF2563EB'}}; refs.columns=[{width:28},{width:15},{width:15}]; refs.views=[{state:'frozen',ySplit:1}];
  if(products.length) ws.dataValidations.add('I2:I5001',{type:'list',allowBlank:false,formulae:[`'卡项参考'!$A$2:$A$${products.length+1}`]});
  const guide=wb.addWorksheet('填写说明'); guide.addRows([
    ['会员批量导入填写说明',''],['规则','说明'],['使用范围','只导入历史会员与会员卡，不生成订单、支付、班次、营收或员工提成。'],['必填字段','姓名、卡项名称、卡种。卡项名称必须与后台“卡项管理”完全一致。'],['自动编号','会员号、卡号可以留空，由系统自动生成。'],['一人多卡','同一会员多张卡使用相同手机号或会员号，每张卡占一行，会员资料必须一致。'],['卡种枚举','count=次卡；month=月卡；year=年卡；stored=储值卡。'],['卡状态','normal=正常；frozen=冻结；expired=过期；void=作废；refunded=已退款。'],['权益填写','次卡只填剩余次数；储值卡只填储值余额；月卡/年卡必须填结束日期。'],['历史日期','建档日期用于保留历史时间；无论填写与否，导入会员都不会计入新增会员指标。'],['文件限制','最多5000行、3MB。不要修改表头，不要增加未知列。旧版.xls请另存为.xlsx。']]);
  guide.mergeCells('A1:B1'); guide.getCell('A1').font={bold:true,size:16,color:{argb:'FFFFFFFF'}}; guide.getCell('A1').fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1E3A8A'}}; guide.getCell('A1').alignment={horizontal:'center'};
  guide.getRow(2).font={bold:true,color:{argb:'FFFFFFFF'}}; guide.getRow(2).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF2563EB'}}; guide.getColumn(1).width=18; guide.getColumn(2).width=85; guide.getColumn(2).alignment={wrapText:true,vertical:'top'};
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function downloadTemplate({query}){if(query.get('format')==='csv')return ok({data:Buffer.from(csvTemplate(),'utf8').toString('base64'),filename:'会员导入模板.csv',mime:'text/csv'});const b=await xlsxTemplate();return ok({data:b.toString('base64'),filename:'会员导入模板.xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});}

module.exports={preview,commit,downloadTemplate,inspect,parseFile};
