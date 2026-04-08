import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = { DB: D1Database }
const app = new Hono<{ Bindings: Bindings }>()

app.use('/waste-api/*', cors())

// ===== UTILITY =====
function today() { return new Date().toISOString().slice(0, 10) }
function now() { return new Date().toISOString().slice(0, 19).replace('T', ' ') }
function ok(data: any, msg = '성공') { return { success: true, message: msg, data, timestamp: now() } }
function err(msg: string) { return { success: false, message: msg, data: null, timestamp: now() } }

async function genTrackingNo(db: D1Database) {
  const prefix = `WTK-${today().replace(/-/g, '')}-`
  const r = await db.prepare(`SELECT MAX(TRACKING_NO) as mx FROM MOD_WASTE_TRACKING WHERE TRACKING_NO LIKE ?`).bind(prefix + '%').first<{mx:string|null}>()
  if (r?.mx) {
    const seq = parseInt(r.mx.split('-').pop()!) + 1
    return prefix + String(seq).padStart(4, '0')
  }
  return prefix + '0001'
}

const STAGE_ORDER: Record<string,number> = { DISCHARGE:1, COLLECTION:2, COMPRESSION:3, RECYCLING:4, PRODUCTION:5 }

// ===== AUTH HELPERS =====
async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function genToken(): Promise<string> {
  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function getSessionUser(db: D1Database, token: string | null): Promise<any | null> {
  if (!token) return null
  const row = await db.prepare(
    `SELECT u.* FROM MOD_WASTE_USER u JOIN MOD_WASTE_SESSION s ON u.USER_ID=s.USER_ID WHERE s.TOKEN=? AND s.EXPIRES_AT>? AND u.ACTIVE_YN='Y' AND u.DEL_YN='N'`
  ).bind(token, now()).first()
  return row || null
}

// ===== AUTH API =====
app.post('/waste-api/auth/login', async (c) => {
  const { loginId, password } = await c.req.json()
  if (!loginId || !password) return c.json(err('아이디와 비밀번호를 입력하세요'), 400)
  const db = c.env.DB
  const hash = await sha256(password)
  const user = await db.prepare(`SELECT * FROM MOD_WASTE_USER WHERE LOGIN_ID=? AND PASSWORD_HASH=? AND ACTIVE_YN='Y' AND DEL_YN='N'`).bind(loginId, hash).first()
  if (!user) return c.json(err('아이디 또는 비밀번호가 올바르지 않습니다'), 401)
  const token = await genToken()
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  await db.prepare(`INSERT INTO MOD_WASTE_SESSION (USER_ID,TOKEN,EXPIRES_AT) VALUES (?,?,?)`).bind((user as any).USER_ID, token, expiresAt).run()
  return c.json(ok({
    token, userName: (user as any).USER_NAME, role: (user as any).ROLE, loginId: (user as any).LOGIN_ID,
    expiresAt
  }, '로그인 성공'))
})

app.post('/waste-api/auth/logout', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (token) await c.env.DB.prepare(`DELETE FROM MOD_WASTE_SESSION WHERE TOKEN=?`).bind(token).run()
  return c.json(ok(null, '로그아웃 완료'))
})

app.get('/waste-api/auth/me', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  const user = await getSessionUser(c.env.DB, token || null)
  if (!user) return c.json(err('인증이 필요합니다'), 401)
  return c.json(ok({ userName: user.USER_NAME, role: user.ROLE, loginId: user.LOGIN_ID }))
})

// ===== ADMIN MIDDLEWARE =====
async function requireAdmin(c: any): Promise<Response | null> {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  const user = await getSessionUser(c.env.DB, token || null)
  if (!user) return c.json(err('인증이 필요합니다'), 401)
  if (user.ROLE !== 'ADMIN') return c.json(err('관리자 권한이 필요합니다'), 403)
  return null
}

// ===== GENERIC ADMIN CRUD =====
function adminCRUD(
  prefix: string, table: string, codeCol: string, nameCol: string,
  fields: string[], insertCols: string[]
) {
  // LIST
  app.get(`/waste-api/admin/${prefix}`, async (c) => {
    const guard = await requireAdmin(c); if (guard) return guard
    const db = c.env.DB
    const showAll = c.req.query('all') === 'true'
    const where = showAll ? `DEL_YN='N'` : `DEL_YN='N' AND ACTIVE_YN='Y'`
    const rows = await db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY CREATED_AT DESC`).all()
    return c.json(ok(rows.results))
  })

  // SINGLE
  app.get(`/waste-api/admin/${prefix}/:id`, async (c) => {
    const guard = await requireAdmin(c); if (guard) return guard
    const id = c.req.param('id')
    const pk = table.replace('MOD_WASTE_MST_', '').replace('MOD_WASTE_', '') + '_ID'
    const row = await c.env.DB.prepare(`SELECT * FROM ${table} WHERE ${pk}=? AND DEL_YN='N'`).bind(id).first()
    if (!row) return c.json(err('데이터를 찾을 수 없습니다'), 404)
    return c.json(ok(row))
  })

  // CREATE
  app.post(`/waste-api/admin/${prefix}`, async (c) => {
    const guard = await requireAdmin(c); if (guard) return guard
    const body = await c.req.json()
    const db = c.env.DB
    // check duplicate code
    if (body[codeCol]) {
      const dup = await db.prepare(`SELECT 1 FROM ${table} WHERE ${codeCol}=? AND DEL_YN='N'`).bind(body[codeCol]).first()
      if (dup) return c.json(err('이미 존재하는 코드입니다'), 409)
    }
    const cols = [...insertCols, 'CREATED_AT', 'DEL_YN']
    const vals = [...insertCols.map(col => body[col] ?? null), now(), 'N']
    const ph = cols.map(() => '?').join(',')
    const r = await db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph})`).bind(...vals).run()
    return c.json(ok({ id: r.meta?.last_row_id }, '등록 완료'), 201)
  })

  // UPDATE
  app.put(`/waste-api/admin/${prefix}/:id`, async (c) => {
    const guard = await requireAdmin(c); if (guard) return guard
    const id = c.req.param('id')
    const body = await c.req.json()
    const db = c.env.DB
    const pk = table.replace('MOD_WASTE_MST_', '').replace('MOD_WASTE_', '') + '_ID'
    const sets = fields.filter(f => body[f] !== undefined).map(f => `${f}=?`)
    sets.push('UPDATED_AT=?')
    const vals = fields.filter(f => body[f] !== undefined).map(f => body[f])
    vals.push(now(), id)
    await db.prepare(`UPDATE ${table} SET ${sets.join(',')} WHERE ${pk}=? AND DEL_YN='N'`).bind(...vals).run()
    return c.json(ok(null, '수정 완료'))
  })

  // DELETE (soft)
  app.delete(`/waste-api/admin/${prefix}/:id`, async (c) => {
    const guard = await requireAdmin(c); if (guard) return guard
    const id = c.req.param('id')
    const pk = table.replace('MOD_WASTE_MST_', '').replace('MOD_WASTE_', '') + '_ID'
    await c.env.DB.prepare(`UPDATE ${table} SET DEL_YN='Y',UPDATED_AT=? WHERE ${pk}=?`).bind(now(), id).run()
    return c.json(ok(null, '삭제 완료'))
  })
}

// Register admin CRUD routes
adminCRUD('centers', 'MOD_WASTE_MST_CENTER', 'CENTER_CODE', 'CENTER_NAME',
  ['CENTER_CODE','CENTER_NAME','ADDRESS','CONTACT_NAME','CONTACT_PHONE','REMARKS','ACTIVE_YN'],
  ['CENTER_CODE','CENTER_NAME','ADDRESS','CONTACT_NAME','CONTACT_PHONE','REMARKS','ACTIVE_YN'])

adminCRUD('waste-types', 'MOD_WASTE_MST_WASTE_TYPE', 'TYPE_CODE', 'TYPE_NAME',
  ['TYPE_CODE','TYPE_NAME','DESCRIPTION','UNIT','ACTIVE_YN'],
  ['TYPE_CODE','TYPE_NAME','DESCRIPTION','UNIT','ACTIVE_YN'])

adminCRUD('collectors', 'MOD_WASTE_MST_COLLECTOR', 'COLLECTOR_CODE', 'COLLECTOR_NAME',
  ['COLLECTOR_CODE','COLLECTOR_NAME','ADDRESS','CONTACT_NAME','CONTACT_PHONE','VEHICLE_COUNT','REMARKS','ACTIVE_YN'],
  ['COLLECTOR_CODE','COLLECTOR_NAME','ADDRESS','CONTACT_NAME','CONTACT_PHONE','VEHICLE_COUNT','REMARKS','ACTIVE_YN'])

adminCRUD('processors', 'MOD_WASTE_MST_PROCESSOR', 'PROCESSOR_CODE', 'PROCESSOR_NAME',
  ['PROCESSOR_CODE','PROCESSOR_NAME','ADDRESS','CONTACT_NAME','CONTACT_PHONE','CAPACITY_KG','REMARKS','ACTIVE_YN'],
  ['PROCESSOR_CODE','PROCESSOR_NAME','ADDRESS','CONTACT_NAME','CONTACT_PHONE','CAPACITY_KG','REMARKS','ACTIVE_YN'])

adminCRUD('recyclers', 'MOD_WASTE_MST_RECYCLER', 'RECYCLER_CODE', 'RECYCLER_NAME',
  ['RECYCLER_CODE','RECYCLER_NAME','ADDRESS','CONTACT_NAME','CONTACT_PHONE','RECYCLING_TYPES','REMARKS','ACTIVE_YN'],
  ['RECYCLER_CODE','RECYCLER_NAME','ADDRESS','CONTACT_NAME','CONTACT_PHONE','RECYCLING_TYPES','REMARKS','ACTIVE_YN'])

adminCRUD('producers', 'MOD_WASTE_MST_PRODUCER', 'PRODUCER_CODE', 'PRODUCER_NAME',
  ['PRODUCER_CODE','PRODUCER_NAME','ADDRESS','CONTACT_NAME','CONTACT_PHONE','PRODUCT_TYPES','REMARKS','ACTIVE_YN'],
  ['PRODUCER_CODE','PRODUCER_NAME','ADDRESS','CONTACT_NAME','CONTACT_PHONE','PRODUCT_TYPES','REMARKS','ACTIVE_YN'])

// ===== ISSUE CRUD (special) =====
app.get('/waste-api/admin/issues', async (c) => {
  const guard = await requireAdmin(c); if (guard) return guard
  const db = c.env.DB
  const status = c.req.query('status')
  let q = `SELECT i.*, t.TRACKING_NO FROM MOD_WASTE_MST_ISSUE i LEFT JOIN MOD_WASTE_TRACKING t ON i.TRACKING_ID=t.TRACKING_ID WHERE i.DEL_YN='N'`
  const params: any[] = []
  if (status && status !== 'ALL') { q += ` AND i.STATUS=?`; params.push(status) }
  q += ` ORDER BY i.CREATED_AT DESC`
  const rows = params.length ? await db.prepare(q).bind(...params).all() : await db.prepare(q).all()
  return c.json(ok(rows.results))
})

app.post('/waste-api/admin/issues', async (c) => {
  const guard = await requireAdmin(c); if (guard) return guard
  const body = await c.req.json()
  const db = c.env.DB
  const r = await db.prepare(`INSERT INTO MOD_WASTE_MST_ISSUE (TRACKING_ID,ISSUE_TYPE,SEVERITY,TITLE,DESCRIPTION,REPORTED_BY,ASSIGNED_TO,STATUS,CREATED_AT,DEL_YN) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(body.TRACKING_ID||null, body.ISSUE_TYPE, body.SEVERITY||'MEDIUM', body.TITLE, body.DESCRIPTION||'', body.REPORTED_BY||'', body.ASSIGNED_TO||'', 'OPEN', now(), 'N').run()
  return c.json(ok({ id: r.meta?.last_row_id }, '이슈 등록 완료'), 201)
})

app.put('/waste-api/admin/issues/:id', async (c) => {
  const guard = await requireAdmin(c); if (guard) return guard
  const id = c.req.param('id')
  const body = await c.req.json()
  const db = c.env.DB
  const sets: string[] = []; const vals: any[] = []
  const fields = ['TRACKING_ID','ISSUE_TYPE','SEVERITY','TITLE','DESCRIPTION','REPORTED_BY','ASSIGNED_TO','STATUS','RESOLUTION','RESOLVED_AT']
  fields.forEach(f => { if (body[f] !== undefined) { sets.push(`${f}=?`); vals.push(body[f]) } })
  if (body.STATUS === 'RESOLVED' && !body.RESOLVED_AT) { sets.push('RESOLVED_AT=?'); vals.push(now()) }
  sets.push('UPDATED_AT=?'); vals.push(now()); vals.push(id)
  await db.prepare(`UPDATE MOD_WASTE_MST_ISSUE SET ${sets.join(',')} WHERE ISSUE_ID=? AND DEL_YN='N'`).bind(...vals).run()
  return c.json(ok(null, '이슈 수정 완료'))
})

app.delete('/waste-api/admin/issues/:id', async (c) => {
  const guard = await requireAdmin(c); if (guard) return guard
  await c.env.DB.prepare(`UPDATE MOD_WASTE_MST_ISSUE SET DEL_YN='Y',UPDATED_AT=? WHERE ISSUE_ID=?`).bind(now(), c.req.param('id')).run()
  return c.json(ok(null, '이슈 삭제 완료'))
})

// ===== USER MANAGEMENT =====
app.get('/waste-api/admin/users', async (c) => {
  const guard = await requireAdmin(c); if (guard) return guard
  const rows = await c.env.DB.prepare(`SELECT USER_ID,LOGIN_ID,USER_NAME,ROLE,EMAIL,PHONE,ACTIVE_YN,CREATED_AT FROM MOD_WASTE_USER WHERE DEL_YN='N' ORDER BY CREATED_AT DESC`).all()
  return c.json(ok(rows.results))
})

app.post('/waste-api/admin/users', async (c) => {
  const guard = await requireAdmin(c); if (guard) return guard
  const body = await c.req.json()
  const db = c.env.DB
  if (!body.LOGIN_ID || !body.PASSWORD || !body.USER_NAME) return c.json(err('필수 항목을 입력하세요'), 400)
  const dup = await db.prepare(`SELECT 1 FROM MOD_WASTE_USER WHERE LOGIN_ID=? AND DEL_YN='N'`).bind(body.LOGIN_ID).first()
  if (dup) return c.json(err('이미 존재하는 아이디입니다'), 409)
  const hash = await sha256(body.PASSWORD)
  const r = await db.prepare(`INSERT INTO MOD_WASTE_USER (LOGIN_ID,PASSWORD_HASH,USER_NAME,ROLE,EMAIL,PHONE,ACTIVE_YN,CREATED_AT,DEL_YN) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(body.LOGIN_ID, hash, body.USER_NAME, body.ROLE||'USER', body.EMAIL||'', body.PHONE||'', 'Y', now(), 'N').run()
  return c.json(ok({ id: r.meta?.last_row_id }, '사용자 등록 완료'), 201)
})

app.put('/waste-api/admin/users/:id', async (c) => {
  const guard = await requireAdmin(c); if (guard) return guard
  const id = c.req.param('id')
  const body = await c.req.json()
  const db = c.env.DB
  const sets: string[] = []; const vals: any[] = []
  if (body.USER_NAME) { sets.push('USER_NAME=?'); vals.push(body.USER_NAME) }
  if (body.ROLE) { sets.push('ROLE=?'); vals.push(body.ROLE) }
  if (body.EMAIL !== undefined) { sets.push('EMAIL=?'); vals.push(body.EMAIL) }
  if (body.PHONE !== undefined) { sets.push('PHONE=?'); vals.push(body.PHONE) }
  if (body.ACTIVE_YN) { sets.push('ACTIVE_YN=?'); vals.push(body.ACTIVE_YN) }
  if (body.PASSWORD) { sets.push('PASSWORD_HASH=?'); vals.push(await sha256(body.PASSWORD)) }
  sets.push('UPDATED_AT=?'); vals.push(now()); vals.push(id)
  await db.prepare(`UPDATE MOD_WASTE_USER SET ${sets.join(',')} WHERE USER_ID=? AND DEL_YN='N'`).bind(...vals).run()
  return c.json(ok(null, '사용자 수정 완료'))
})

app.delete('/waste-api/admin/users/:id', async (c) => {
  const guard = await requireAdmin(c); if (guard) return guard
  await c.env.DB.prepare(`UPDATE MOD_WASTE_USER SET DEL_YN='Y',UPDATED_AT=? WHERE USER_ID=?`).bind(now(), c.req.param('id')).run()
  return c.json(ok(null, '사용자 삭제 완료'))
})

// ===== MASTER DATA LOOKUPS (for data entry dropdowns - no auth required) =====
app.get('/waste-api/lookup/centers', async (c) => {
  const rows = await c.env.DB.prepare(`SELECT CENTER_CODE,CENTER_NAME FROM MOD_WASTE_MST_CENTER WHERE DEL_YN='N' AND ACTIVE_YN='Y' ORDER BY CENTER_NAME`).all()
  return c.json(ok(rows.results))
})
app.get('/waste-api/lookup/waste-types', async (c) => {
  const rows = await c.env.DB.prepare(`SELECT TYPE_CODE,TYPE_NAME FROM MOD_WASTE_MST_WASTE_TYPE WHERE DEL_YN='N' AND ACTIVE_YN='Y' ORDER BY TYPE_NAME`).all()
  return c.json(ok(rows.results))
})
app.get('/waste-api/lookup/collectors', async (c) => {
  const rows = await c.env.DB.prepare(`SELECT COLLECTOR_CODE,COLLECTOR_NAME FROM MOD_WASTE_MST_COLLECTOR WHERE DEL_YN='N' AND ACTIVE_YN='Y' ORDER BY COLLECTOR_NAME`).all()
  return c.json(ok(rows.results))
})
app.get('/waste-api/lookup/processors', async (c) => {
  const rows = await c.env.DB.prepare(`SELECT PROCESSOR_CODE,PROCESSOR_NAME FROM MOD_WASTE_MST_PROCESSOR WHERE DEL_YN='N' AND ACTIVE_YN='Y' ORDER BY PROCESSOR_NAME`).all()
  return c.json(ok(rows.results))
})
app.get('/waste-api/lookup/recyclers', async (c) => {
  const rows = await c.env.DB.prepare(`SELECT RECYCLER_CODE,RECYCLER_NAME FROM MOD_WASTE_MST_RECYCLER WHERE DEL_YN='N' AND ACTIVE_YN='Y' ORDER BY RECYCLER_NAME`).all()
  return c.json(ok(rows.results))
})
app.get('/waste-api/lookup/producers', async (c) => {
  const rows = await c.env.DB.prepare(`SELECT PRODUCER_CODE,PRODUCER_NAME FROM MOD_WASTE_MST_PRODUCER WHERE DEL_YN='N' AND ACTIVE_YN='Y' ORDER BY PRODUCER_NAME`).all()
  return c.json(ok(rows.results))
})

// ===== API: 1단계 배출 등록 =====
app.post('/waste-api/tracking/discharge', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  const no = await genTrackingNo(db)
  const r = await db.prepare(`INSERT INTO MOD_WASTE_TRACKING (TRACKING_NO,WASTE_TYPE,CURRENT_STAGE,STATUS,SOURCE_NAME,TOTAL_WEIGHT_KG,CREATED_BY,CREATED_AT,DEL_YN) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(no, body.wasteType, 'DISCHARGE', 'INITIATED', body.centerName, body.weightKg, body.dischargeManager||'system', now(), 'N').run()
  const tid = r.meta?.last_row_id
  await db.prepare(`INSERT INTO MOD_WASTE_DISCHARGE (TRACKING_ID,DISCHARGE_DATE,CENTER_CODE,CENTER_NAME,DISCHARGE_MANAGER,WEIGHT_KG,WASTE_TYPE,REMARKS,CREATED_AT,DEL_YN) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(tid, body.dischargeDate, body.centerCode, body.centerName, body.dischargeManager||'', body.weightKg, body.wasteType, body.remarks||'', now(), 'N').run()
  return c.json(ok({ trackingId: tid, trackingNo: no }, '배출 등록 완료'), 201)
})

// ===== API: 2단계 수거 등록 =====
app.post('/waste-api/tracking/collection', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  const t = await db.prepare(`SELECT * FROM MOD_WASTE_TRACKING WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(body.trackingId).first()
  if (!t) return c.json(err('트래킹을 찾을 수 없습니다'), 404)
  if (STAGE_ORDER[(t as any).CURRENT_STAGE] !== 1) return c.json(err('현재 단계에서 수거를 등록할 수 없습니다 (배출 단계에서만 가능)'), 400)
  const co2 = body.distanceKm ? +(body.distanceKm * 0.21).toFixed(2) : null
  await db.prepare(`INSERT INTO MOD_WASTE_COLLECTION (TRACKING_ID,COLLECTOR_CODE,COLLECTOR_NAME,VEHICLE_NO,DRIVER_NAME,COLLECTION_START_AT,COLLECTION_END_AT,COLLECTED_WEIGHT_KG,ORIGIN_ADDRESS,DESTINATION_ADDRESS,DISTANCE_KM,CO2_EMISSION_KG,REMARKS,CREATED_AT,DEL_YN) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(body.trackingId, body.collectorCode, body.collectorName, body.vehicleNo||'', body.driverName||'', body.collectionStartAt, body.collectionEndAt||'', body.collectedWeightKg, body.originAddress||'', body.destinationAddress||'', body.distanceKm||0, co2, body.remarks||'', now(), 'N').run()
  await db.prepare(`UPDATE MOD_WASTE_TRACKING SET CURRENT_STAGE='COLLECTION',STATUS='IN_PROGRESS',UPDATED_AT=? WHERE TRACKING_ID=?`).bind(now(), body.trackingId).run()
  return c.json(ok({ trackingId: body.trackingId }, '수거 등록 완료'), 201)
})

// ===== API: 3단계 압축 등록 =====
app.post('/waste-api/tracking/compression', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  const t = await db.prepare(`SELECT * FROM MOD_WASTE_TRACKING WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(body.trackingId).first()
  if (!t) return c.json(err('트래킹을 찾을 수 없습니다'), 404)
  if (STAGE_ORDER[(t as any).CURRENT_STAGE] !== 2) return c.json(err('수거 단계에서만 압축을 등록할 수 있습니다'), 400)
  let lossW = null, lossR = null
  if (body.outputWeightKg && body.inputWeightKg) {
    lossW = +(body.inputWeightKg - body.outputWeightKg).toFixed(2)
    lossR = +((lossW / body.inputWeightKg) * 100).toFixed(2)
  }
  await db.prepare(`INSERT INTO MOD_WASTE_COMPRESSION (TRACKING_ID,PROCESSOR_CODE,PROCESSOR_NAME,PROCESS_START_AT,PROCESS_END_AT,INPUT_WEIGHT_KG,OUTPUT_WEIGHT_KG,LOSS_WEIGHT_KG,LOSS_RATE,COMPRESSION_DENSITY,BALE_COUNT,REMARKS,CREATED_AT,DEL_YN) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(body.trackingId, body.processorCode, body.processorName, body.processStartAt, body.processEndAt||'', body.inputWeightKg, body.outputWeightKg||0, lossW, lossR, body.compressionDensity||0, body.baleCount||0, body.remarks||'', now(), 'N').run()
  await db.prepare(`UPDATE MOD_WASTE_TRACKING SET CURRENT_STAGE='COMPRESSION',UPDATED_AT=? WHERE TRACKING_ID=?`).bind(now(), body.trackingId).run()
  return c.json(ok({ trackingId: body.trackingId }, '압축 처리 등록 완료'), 201)
})

// ===== API: 4단계 재활용 등록 =====
app.post('/waste-api/tracking/recycling', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  const t = await db.prepare(`SELECT * FROM MOD_WASTE_TRACKING WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(body.trackingId).first()
  if (!t) return c.json(err('트래킹을 찾을 수 없습니다'), 404)
  if (STAGE_ORDER[(t as any).CURRENT_STAGE] !== 3) return c.json(err('압축 단계에서만 재활용을 등록할 수 있습니다'), 400)
  let rate = null, co2s = null
  if (body.outputWeightKg && body.inputWeightKg) {
    rate = +((body.outputWeightKg / body.inputWeightKg) * 100).toFixed(2)
    co2s = +(body.outputWeightKg * 2.3).toFixed(2)
  }
  await db.prepare(`INSERT INTO MOD_WASTE_RECYCLING (TRACKING_ID,RECYCLER_CODE,RECYCLER_NAME,PROCESS_START_AT,PROCESS_END_AT,INPUT_WEIGHT_KG,OUTPUT_WEIGHT_KG,RECYCLING_RATE,RECYCLING_METHOD,CO2_SAVING_KG,REMARKS,CREATED_AT,DEL_YN) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(body.trackingId, body.recyclerCode, body.recyclerName, body.processStartAt, body.processEndAt||'', body.inputWeightKg, body.outputWeightKg||0, rate, body.recyclingMethod||'', co2s, body.remarks||'', now(), 'N').run()
  await db.prepare(`UPDATE MOD_WASTE_TRACKING SET CURRENT_STAGE='RECYCLING',UPDATED_AT=? WHERE TRACKING_ID=?`).bind(now(), body.trackingId).run()
  return c.json(ok({ trackingId: body.trackingId }, '재활용 등록 완료'), 201)
})

// ===== API: 5단계 생산 등록 =====
app.post('/waste-api/tracking/production', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  const t = await db.prepare(`SELECT * FROM MOD_WASTE_TRACKING WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(body.trackingId).first()
  if (!t) return c.json(err('트래킹을 찾을 수 없습니다'), 404)
  if (STAGE_ORDER[(t as any).CURRENT_STAGE] !== 4) return c.json(err('재활용 단계에서만 생산을 등록할 수 있습니다'), 400)
  await db.prepare(`INSERT INTO MOD_WASTE_PRODUCTION (TRACKING_ID,PRODUCER_CODE,PRODUCER_NAME,PRODUCT_NAME,PRODUCT_CODE,PRODUCTION_START_AT,PRODUCTION_END_AT,INPUT_WEIGHT_KG,OUTPUT_WEIGHT_KG,PRODUCTION_QTY,DELIVERY_DESTINATION,DELIVERY_DATE,REMARKS,CREATED_AT,DEL_YN) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(body.trackingId, body.producerCode, body.producerName, body.productName, body.productCode||'', body.productionStartAt, body.productionEndAt||'', body.inputWeightKg, body.outputWeightKg||0, body.productionQty||0, body.deliveryDestination||'', body.deliveryDate||'', body.remarks||'', now(), 'N').run()
  await db.prepare(`UPDATE MOD_WASTE_TRACKING SET CURRENT_STAGE='PRODUCTION',STATUS='COMPLETED',COMPLETED_AT=?,UPDATED_AT=? WHERE TRACKING_ID=?`).bind(now(), now(), body.trackingId).run()
  return c.json(ok({ trackingId: body.trackingId }, '제품 생산 등록 완료'), 201)
})

// ===== API: 트래킹 목록 =====
app.get('/waste-api/tracking', async (c) => {
  const db = c.env.DB
  const page = parseInt(c.req.query('page') || '0')
  const size = parseInt(c.req.query('size') || '20')
  const rows = await db.prepare(`SELECT * FROM MOD_WASTE_TRACKING WHERE DEL_YN='N' ORDER BY CREATED_AT DESC LIMIT ? OFFSET ?`).bind(size, page * size).all()
  const cnt = await db.prepare(`SELECT COUNT(*) as c FROM MOD_WASTE_TRACKING WHERE DEL_YN='N'`).first<{c:number}>()
  return c.json(ok({ content: rows.results, totalElements: cnt?.c || 0, page, size }))
})

// ===== API: 트래킹 상세 =====
app.get('/waste-api/tracking/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const t = await db.prepare(`SELECT * FROM MOD_WASTE_TRACKING WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(id).first()
  if (!t) return c.json(err('트래킹을 찾을 수 없습니다'), 404)
  const d = await db.prepare(`SELECT * FROM MOD_WASTE_DISCHARGE WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(id).first()
  const col = await db.prepare(`SELECT * FROM MOD_WASTE_COLLECTION WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(id).first()
  const comp = await db.prepare(`SELECT * FROM MOD_WASTE_COMPRESSION WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(id).first()
  const recy = await db.prepare(`SELECT * FROM MOD_WASTE_RECYCLING WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(id).first()
  const prod = await db.prepare(`SELECT * FROM MOD_WASTE_PRODUCTION WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(id).first()
  return c.json(ok({ tracking: t, discharge: d, collection: col, compression: comp, recycling: recy, production: prod }))
})

// ===== API: 대시보드 =====
app.get('/waste-api/dashboard', async (c) => {
  const db = c.env.DB
  const sd = c.req.query('startDate') || '2026-01-01'
  const ed = c.req.query('endDate') || '2026-12-31'

  const totalQ = await db.prepare(`SELECT COUNT(*) as cnt, COALESCE(SUM(TOTAL_WEIGHT_KG),0) as total FROM MOD_WASTE_TRACKING WHERE DEL_YN='N' AND CREATED_AT>=? AND CREATED_AT<=?`).bind(sd, ed + ' 23:59:59').first<{cnt:number,total:number}>()
  const stageQ = await db.prepare(`SELECT CURRENT_STAGE as stage, COUNT(*) as cnt FROM MOD_WASTE_TRACKING WHERE DEL_YN='N' GROUP BY CURRENT_STAGE`).all()
  const statusQ = await db.prepare(`SELECT STATUS as st, COUNT(*) as cnt FROM MOD_WASTE_TRACKING WHERE DEL_YN='N' GROUP BY STATUS`).all()
  const recycleQ = await db.prepare(`SELECT COALESCE(AVG(RECYCLING_RATE),0) as avgRate, COALESCE(SUM(CO2_SAVING_KG),0) as co2Save FROM MOD_WASTE_RECYCLING WHERE DEL_YN='N' AND CREATED_AT>=? AND CREATED_AT<=?`).bind(sd, ed + ' 23:59:59').first<{avgRate:number,co2Save:number}>()
  const lossQ = await db.prepare(`SELECT COALESCE(AVG(LOSS_RATE),0) as avgLoss FROM MOD_WASTE_COMPRESSION WHERE DEL_YN='N' AND CREATED_AT>=? AND CREATED_AT<=?`).bind(sd, ed + ' 23:59:59').first<{avgLoss:number}>()
  const distQ = await db.prepare(`SELECT COALESCE(SUM(DISTANCE_KM),0) as dist, COALESCE(SUM(CO2_EMISSION_KG),0) as co2E FROM MOD_WASTE_COLLECTION WHERE DEL_YN='N' AND CREATED_AT>=? AND CREATED_AT<=?`).bind(sd, ed + ' 23:59:59').first<{dist:number,co2E:number}>()
  const dailyQ = await db.prepare(`SELECT DATE(CREATED_AT) as dt, COUNT(*) as cnt, COALESCE(SUM(TOTAL_WEIGHT_KG),0) as wt FROM MOD_WASTE_TRACKING WHERE DEL_YN='N' AND CREATED_AT>=? AND CREATED_AT<=? GROUP BY DATE(CREATED_AT) ORDER BY dt`).bind(sd, ed + ' 23:59:59').all()
  const centerQ = await db.prepare(`SELECT CENTER_NAME as name, COUNT(*) as cnt, COALESCE(SUM(WEIGHT_KG),0) as wt FROM MOD_WASTE_DISCHARGE WHERE DEL_YN='N' AND DISCHARGE_DATE>=? AND DISCHARGE_DATE<=? GROUP BY CENTER_NAME ORDER BY wt DESC`).bind(sd, ed).all()
  const wasteTypeQ = await db.prepare(`SELECT WASTE_TYPE as tp, COUNT(*) as cnt, COALESCE(SUM(WEIGHT_KG),0) as wt FROM MOD_WASTE_DISCHARGE WHERE DEL_YN='N' AND DISCHARGE_DATE>=? AND DISCHARGE_DATE<=? GROUP BY WASTE_TYPE`).bind(sd, ed).all()
  const collectorQ = await db.prepare(`SELECT COLLECTOR_NAME as name, COUNT(*) as cnt, COALESCE(SUM(COLLECTED_WEIGHT_KG),0) as wt, COALESCE(SUM(DISTANCE_KM),0) as dist FROM MOD_WASTE_COLLECTION WHERE DEL_YN='N' AND CREATED_AT>=? AND CREATED_AT<=? GROUP BY COLLECTOR_NAME`).bind(sd, ed + ' 23:59:59').all()

  return c.json(ok({
    totalCount: totalQ?.cnt || 0,
    totalWeightKg: totalQ?.total || 0,
    avgRecyclingRate: +(recycleQ?.avgRate || 0).toFixed(1),
    totalCo2SavingKg: +(recycleQ?.co2Save || 0).toFixed(1),
    avgLossRate: +(lossQ?.avgLoss || 0).toFixed(1),
    totalDistanceKm: +(distQ?.dist || 0).toFixed(1),
    totalCo2EmissionKg: +(distQ?.co2E || 0).toFixed(1),
    stageStats: stageQ.results,
    statusStats: statusQ.results,
    dailyStats: dailyQ.results,
    centerStats: centerQ.results,
    wasteTypeStats: wasteTypeQ.results,
    collectorStats: collectorQ.results
  }))
})

// ===== SPA HTML =====
app.get('*', (c) => {
  return c.html(renderHTML())
})

function renderHTML() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>WMS - Waste Management System</title>
<link rel="preconnect" href="https://cdn.jsdelivr.net">
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.0/css/all.min.css" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --c-bg:#f3f4f6;--c-card:#fff;--c-text:#1f2937;--c-text2:#6b7280;--c-text3:#9ca3af;
  --c-border:#e5e7eb;--c-primary:#059669;--c-primary-l:#d1fae5;
  --sidebar-w:260px;--header-h:64px;
  --r:12px;--shadow:0 1px 3px rgba(0,0,0,.08);
}
html{font-size:14px}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans KR',sans-serif;background:var(--c-bg);color:var(--c-text);line-height:1.5}

/* SIDEBAR */
.sidebar{position:fixed;left:0;top:0;bottom:0;width:var(--sidebar-w);background:linear-gradient(180deg,#064e3b,#065f46);z-index:100;display:flex;flex-direction:column;transition:transform .3s ease}
.sidebar-brand{padding:20px 24px;border-bottom:1px solid rgba(255,255,255,.1)}
.sidebar-brand h1{color:#fff;font-size:20px;font-weight:700;display:flex;align-items:center;gap:10px}
.sidebar-brand h1 i{font-size:22px;color:#34d399}
.sidebar-brand p{color:#6ee7b7;font-size:11px;margin-top:2px;letter-spacing:.5px}
.sidebar nav{flex:1;padding:12px 0;overflow-y:auto}
.nav-item{display:flex;align-items:center;gap:14px;padding:12px 24px;color:#a7f3d0;font-size:14px;cursor:pointer;transition:all .2s;border-left:3px solid transparent;text-decoration:none}
.nav-item:hover{background:rgba(255,255,255,.08);color:#fff}
.nav-item.active{background:rgba(255,255,255,.12);color:#fff;border-left-color:#34d399;font-weight:600}
.nav-item i{width:20px;text-align:center;font-size:15px}
.nav-section{padding:12px 24px 6px;font-size:10px;font-weight:700;color:rgba(255,255,255,.35);text-transform:uppercase;letter-spacing:1px}
.sidebar-footer{padding:16px 24px;border-top:1px solid rgba(255,255,255,.08);color:#6ee7b7;font-size:11px}

/* LAYOUT */
.layout{margin-left:var(--sidebar-w);min-height:100vh;transition:margin .3s}
.header{height:var(--header-h);background:var(--c-card);border-bottom:1px solid var(--c-border);display:flex;align-items:center;justify-content:space-between;padding:0 32px;position:sticky;top:0;z-index:50}
.header-left h2{font-size:18px;font-weight:700;color:var(--c-text)}
.header-left p{font-size:12px;color:var(--c-text2);margin-top:1px}
.header-right{display:flex;align-items:center;gap:12px}
.content{padding:24px 32px}

/* MOBILE */
.mobile-toggle{display:none;position:fixed;top:14px;left:14px;z-index:200;background:var(--c-primary);color:#fff;border:none;width:40px;height:40px;border-radius:10px;cursor:pointer;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,.15)}
.sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:90}
@media(max-width:900px){
  .sidebar{transform:translateX(-100%)}
  .sidebar.open{transform:translateX(0)}
  .sidebar-overlay.open{display:block}
  .layout{margin-left:0}
  .mobile-toggle{display:flex;align-items:center;justify-content:center}
  .content{padding:16px}
  .header{padding:0 16px 0 60px}
}

/* COMPONENTS */
.card{background:var(--c-card);border-radius:var(--r);padding:24px;box-shadow:var(--shadow)}
.page{display:none;animation:fadeIn .3s ease}.page.active{display:block}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}

/* KPI */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:16px;margin-bottom:24px}
.kpi{background:var(--c-card);border-radius:var(--r);padding:20px;box-shadow:var(--shadow);transition:transform .15s,box-shadow .15s;position:relative;overflow:hidden}
.kpi:hover{transform:translateY(-3px);box-shadow:0 4px 12px rgba(0,0,0,.1)}
.kpi-icon{width:42px;height:42px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:12px}
.kpi-label{font-size:12px;color:var(--c-text2);margin-bottom:2px;font-weight:500}
.kpi-value{font-size:28px;font-weight:800;color:var(--c-text);line-height:1.1}
.kpi-unit{font-size:12px;color:var(--c-text3);margin-top:2px}

/* CHARTS */
.chart-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:20px;margin-bottom:24px}
@media(max-width:900px){.chart-grid{grid-template-columns:1fr}}
.chart-card{background:var(--c-card);border-radius:var(--r);padding:24px;box-shadow:var(--shadow)}
.chart-card h3{font-size:15px;font-weight:600;color:var(--c-text);margin-bottom:16px;display:flex;align-items:center;gap:8px}

/* CO2 SUMMARY */
.co2-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
.co2-box{border-radius:var(--r);padding:24px;text-align:center}
.co2-box .co2-label{font-size:13px;font-weight:500;margin-bottom:6px}
.co2-box .co2-val{font-size:34px;font-weight:800;line-height:1.1}
.co2-box .co2-unit{font-size:12px;margin-top:4px;opacity:.8}

/* FORMS */
.step-tabs{display:flex;gap:6px;margin-bottom:24px;flex-wrap:wrap;align-items:center}
.step-tab{padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;border:2px solid transparent;background:#e5e7eb;color:#6b7280}
.step-tab.on{background:var(--c-primary);color:#fff;border-color:var(--c-primary);box-shadow:0 2px 10px rgba(5,150,105,.25)}
.step-arrow{color:#ccc;font-size:10px}
.form-panel{display:none;animation:fadeIn .25s ease}.form-panel.show{display:block}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:600px){.form-grid{grid-template-columns:1fr}}
.form-grid .full{grid-column:1/-1}
.form-group label{display:block;font-size:12px;font-weight:600;color:var(--c-text2);margin-bottom:5px;text-transform:uppercase;letter-spacing:.3px}
.form-group input,.form-group select,.form-group textarea{width:100%;border:1.5px solid var(--c-border);border-radius:8px;padding:10px 14px;font-size:14px;outline:none;transition:border .2s,box-shadow .2s;background:var(--c-card);color:var(--c-text);font-family:inherit}
.form-group input:focus,.form-group select:focus,.form-group textarea:focus{border-color:var(--c-primary);box-shadow:0 0 0 3px rgba(5,150,105,.12)}
.form-group textarea{resize:vertical;min-height:60px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 24px;border-radius:10px;font-weight:600;font-size:14px;cursor:pointer;border:none;transition:all .2s;font-family:inherit}
.btn:hover{filter:brightness(1.08);transform:translateY(-1px)}
.btn:active{transform:translateY(0)}
.btn-primary{background:var(--c-primary);color:#fff}
.btn-blue{background:#3b82f6;color:#fff}
.btn-amber{background:#f59e0b;color:#fff}
.btn-purple{background:#8b5cf6;color:#fff}
.btn-red{background:#ef4444;color:#fff}
.btn-gray{background:#6b7280;color:#fff}
.btn-sm{padding:6px 14px;font-size:12px;border-radius:8px}
.btn-outline{background:transparent;border:1.5px solid var(--c-border);color:var(--c-text2)}
.btn-outline:hover{border-color:var(--c-primary);color:var(--c-primary)}

/* TRACKING */
.search-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.search-bar .form-group{flex:1;min-width:200px}

/* TIMELINE */
.timeline-wrap{display:flex;align-items:center;justify-content:center;gap:0;padding:20px 0;flex-wrap:wrap}
.tl-step{display:flex;flex-direction:column;align-items:center;gap:6px}
.tl-dot{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;transition:all .3s}
.tl-dot.done{background:#059669;color:#fff;box-shadow:0 2px 8px rgba(5,150,105,.3)}
.tl-dot.now{background:#3b82f6;color:#fff;animation:pulseDot 2s infinite;box-shadow:0 2px 8px rgba(59,130,246,.3)}
.tl-dot.wait{background:#e5e7eb;color:#9ca3af}
@keyframes pulseDot{0%,100%{box-shadow:0 0 0 0 rgba(59,130,246,.4)}50%{box-shadow:0 0 0 12px rgba(59,130,246,0)}}
.tl-label{font-size:11px;font-weight:600;white-space:nowrap}
.tl-connector{width:50px;height:3px;margin-bottom:20px}
.tl-connector.done{background:#059669}.tl-connector.wait{background:#e5e7eb}

/* DETAIL CARDS */
.detail-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin-bottom:24px}
.detail-card{background:var(--c-card);border-radius:var(--r);padding:20px;box-shadow:var(--shadow);border-top:4px solid}
.detail-card h4{font-size:14px;font-weight:700;color:var(--c-text);margin-bottom:12px;display:flex;align-items:center;gap:8px}
.detail-row{display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid #f3f4f6}
.detail-row:last-child{border-bottom:none}
.detail-row .dl{color:var(--c-text2)}.detail-row .dv{font-weight:600;color:var(--c-text)}

/* TABLE */
.tbl-wrap{overflow-x:auto;margin-top:20px}
table{width:100%;border-collapse:collapse}
thead th{padding:10px 14px;text-align:left;font-size:11px;font-weight:700;color:var(--c-text2);text-transform:uppercase;letter-spacing:.5px;background:#f9fafb;border-bottom:2px solid var(--c-border)}
tbody td{padding:12px 14px;font-size:13px;border-bottom:1px solid #f3f4f6}
tbody tr{transition:background .15s}
tbody tr:hover{background:#f0fdf4}
.badge{display:inline-block;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:700}
.mono{font-family:'Courier New',monospace;font-weight:700;color:var(--c-primary)}

/* TOAST */
.toast{position:fixed;top:20px;right:20px;z-index:9999;padding:14px 28px;border-radius:12px;color:#fff;font-size:14px;font-weight:500;animation:toastIn .35s ease;box-shadow:0 6px 24px rgba(0,0,0,.2);display:none;backdrop-filter:blur(8px)}
@keyframes toastIn{from{transform:translateY(-20px) scale(.95);opacity:0}to{transform:translateY(0) scale(1);opacity:1}}

/* COLLECTOR TABLE */
.collector-tbl{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
.collector-tbl th{background:#f9fafb;padding:8px 10px;text-align:left;font-size:11px;font-weight:700;color:var(--c-text2);border-bottom:2px solid var(--c-border)}
.collector-tbl td{padding:8px 10px;border-bottom:1px solid #f3f4f6}

/* LOADING */
.loading{display:flex;align-items:center;justify-content:center;padding:40px;color:var(--c-text3)}
.spinner{width:24px;height:24px;border:3px solid var(--c-border);border-top-color:var(--c-primary);border-radius:50%;animation:spin .6s linear infinite;margin-right:10px}
@keyframes spin{to{transform:rotate(360deg)}}

/* DATE INPUTS */
.date-filter{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.date-filter input[type=date]{width:155px;padding:8px 12px;border:1.5px solid var(--c-border);border-radius:8px;font-size:13px;outline:none}
.date-filter input[type=date]:focus{border-color:var(--c-primary)}
.date-sep{color:var(--c-text3);font-size:13px}

/* LOGIN MODAL */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:none;align-items:center;justify-content:center;backdrop-filter:blur(4px)}
.modal-overlay.show{display:flex}
.modal{background:#fff;border-radius:16px;padding:32px;width:100%;max-width:400px;box-shadow:0 20px 60px rgba(0,0,0,.2);animation:modalIn .3s ease}
@keyframes modalIn{from{transform:scale(.9);opacity:0}to{transform:scale(1);opacity:1}}
.modal h3{font-size:18px;font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:10px}
.modal p{font-size:13px;color:var(--c-text2);margin-bottom:24px}
.modal .form-group{margin-bottom:16px}
.modal .form-group label{font-size:12px;font-weight:600;color:var(--c-text2);margin-bottom:5px;display:block;text-transform:uppercase;letter-spacing:.3px}
.modal .form-group input{width:100%;border:1.5px solid var(--c-border);border-radius:8px;padding:10px 14px;font-size:14px;outline:none;transition:border .2s}
.modal .form-group input:focus{border-color:var(--c-primary);box-shadow:0 0 0 3px rgba(5,150,105,.12)}
.modal-error{color:#ef4444;font-size:12px;margin-top:8px;display:none}

/* USER INFO BAR */
.user-bar{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--c-text2)}
.user-bar .avatar{width:32px;height:32px;border-radius:50%;background:var(--c-primary);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700}
.user-bar .user-name{font-weight:600;color:var(--c-text)}
.user-bar .user-role{font-size:10px;background:var(--c-primary-l);color:var(--c-primary);padding:2px 8px;border-radius:10px;font-weight:700}
.user-bar .btn-logout{padding:4px 12px;font-size:11px;border-radius:6px;cursor:pointer;border:1px solid var(--c-border);background:#fff;color:var(--c-text2);transition:all .2s}
.user-bar .btn-logout:hover{border-color:#ef4444;color:#ef4444;background:#fef2f2}

/* ADMIN TAB SPECIFIC */
.admin-tabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:20px;background:#f3f4f6;padding:4px;border-radius:12px}
.admin-tab{padding:8px 16px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s;border:none;background:transparent;color:var(--c-text2);font-family:inherit}
.admin-tab.on{background:#fff;color:var(--c-primary);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.admin-tab:hover:not(.on){background:rgba(0,0,0,.04)}
.admin-panel{display:none;animation:fadeIn .25s ease}.admin-panel.show{display:block}
.admin-toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px}
.admin-toolbar h3{font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px}
.admin-count{font-size:12px;color:var(--c-text3);font-weight:400;margin-left:4px}
.empty-state{text-align:center;color:var(--c-text3);padding:40px}
.empty-state i{font-size:36px;margin-bottom:12px;display:block;color:var(--c-border)}

/* SEVERITY */
.sev-low{background:#dbeafe;color:#1d4ed8}
.sev-medium{background:#fef3c7;color:#92400e}
.sev-high{background:#fed7aa;color:#c2410c}
.sev-critical{background:#fecaca;color:#991b1b}

/* ISSUE STATUS */
.ist-open{background:#fee2e2;color:#991b1b}
.ist-in_progress{background:#fef3c7;color:#92400e}
.ist-resolved{background:#d1fae5;color:#065f46}
.ist-closed{background:#e5e7eb;color:#374151}

/* ACTIVE/INACTIVE BADGE */
.active-y{color:#059669;font-weight:700}.active-n{color:#ef4444;font-weight:700}

/* Edit modal */
.edit-modal{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10001;display:none;align-items:flex-start;justify-content:center;padding:40px 20px;overflow-y:auto;backdrop-filter:blur(4px)}
.edit-modal.show{display:flex}
.edit-modal-body{background:#fff;border-radius:16px;padding:28px;width:100%;max-width:560px;box-shadow:0 20px 60px rgba(0,0,0,.2);animation:modalIn .3s ease;margin:auto}
.edit-modal-body h3{font-size:16px;font-weight:700;margin-bottom:20px;display:flex;align-items:center;gap:8px}
</style>
</head>
<body>

<!-- Mobile Toggle -->
<button class="mobile-toggle" id="mobileToggle"><i class="fas fa-bars"></i></button>
<div class="sidebar-overlay" id="overlay"></div>

<!-- Sidebar -->
<aside class="sidebar" id="sidebar">
  <div class="sidebar-brand">
    <h1><i class="fas fa-recycle"></i> WMS</h1>
    <p>Waste Management System</p>
  </div>
  <nav>
    <div class="nav-section">운영</div>
    <a class="nav-item active" data-page="dashboard"><i class="fas fa-chart-pie"></i>대시보드</a>
    <a class="nav-item" data-page="input"><i class="fas fa-edit"></i>데이터 입력</a>
    <a class="nav-item" data-page="tracking"><i class="fas fa-route"></i>추적 조회</a>
    <div class="nav-section">관리자</div>
    <a class="nav-item" data-page="admin" id="adminNav"><i class="fas fa-cogs"></i>시스템 관리 <i class="fas fa-lock" id="adminLockIcon" style="font-size:10px;margin-left:auto;color:#f59e0b"></i></a>
  </nav>
  <div class="sidebar-footer">
    <div id="sidebarUser" style="display:none;margin-bottom:6px;font-size:12px"></div>
    v2.0 &middot; module-waste
  </div>
</aside>

<!-- Login Modal -->
<div class="modal-overlay" id="loginModal">
  <div class="modal">
    <h3><i class="fas fa-lock" style="color:var(--c-primary)"></i> 관리자 로그인</h3>
    <p>시스템 관리 기능은 관리자 인증이 필요합니다.</p>
    <form id="loginForm">
      <div class="form-group"><label>아이디</label><input id="loginId" placeholder="admin" required autocomplete="username"></div>
      <div class="form-group"><label>비밀번호</label><input type="password" id="loginPw" placeholder="비밀번호" required autocomplete="current-password"></div>
      <div class="modal-error" id="loginErr"></div>
      <div style="display:flex;gap:8px;margin-top:20px">
        <button type="submit" class="btn btn-primary" style="flex:1"><i class="fas fa-sign-in-alt"></i> 로그인</button>
        <button type="button" class="btn btn-outline" onclick="closeLogin()">취소</button>
      </div>
    </form>
    <div style="margin-top:16px;padding:12px;background:#f0fdf4;border-radius:8px;font-size:11px;color:#065f46">
      <i class="fas fa-info-circle"></i> 테스트 계정: <b>admin</b> / <b>admin123</b>
    </div>
  </div>
</div>

<!-- Edit Modal -->
<div class="edit-modal" id="editModal">
  <div class="edit-modal-body" id="editModalBody"></div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<!-- Layout -->
<div class="layout">

<!-- ==================== DASHBOARD ==================== -->
<div id="pg-dashboard" class="page active">
  <div class="header">
    <div class="header-left">
      <h2><i class="fas fa-chart-pie" style="color:var(--c-primary);margin-right:6px"></i>대시보드</h2>
      <p>폐기물 처리 현황 종합 모니터링</p>
    </div>
    <div class="date-filter">
      <input type="date" id="sd">
      <span class="date-sep">~</span>
      <input type="date" id="ed">
      <button class="btn btn-primary" onclick="loadDash()"><i class="fas fa-sync-alt"></i> 조회</button>
    </div>
  </div>
  <div class="content">
    <div class="kpi-grid" id="kpiGrid">
      <div class="kpi"><div class="kpi-icon" style="background:#d1fae5;color:#059669"><i class="fas fa-weight-hanging"></i></div><div class="kpi-label">총 배출량</div><div class="kpi-value" id="k-wt">-</div><div class="kpi-unit">kg</div></div>
      <div class="kpi"><div class="kpi-icon" style="background:#dbeafe;color:#3b82f6"><i class="fas fa-clipboard-list"></i></div><div class="kpi-label">트래킹 건수</div><div class="kpi-value" id="k-cnt">-</div><div class="kpi-unit">건</div></div>
      <div class="kpi"><div class="kpi-icon" style="background:#ccfbf1;color:#14b8a6"><i class="fas fa-recycle"></i></div><div class="kpi-label">평균 재활용률</div><div class="kpi-value" id="k-recycle">-</div><div class="kpi-unit">%</div></div>
      <div class="kpi"><div class="kpi-icon" style="background:#fef3c7;color:#f59e0b"><i class="fas fa-exclamation-triangle"></i></div><div class="kpi-label">평균 Loss율</div><div class="kpi-value" id="k-loss">-</div><div class="kpi-unit">%</div></div>
      <div class="kpi"><div class="kpi-icon" style="background:#ede9fe;color:#8b5cf6"><i class="fas fa-road"></i></div><div class="kpi-label">총 이동거리</div><div class="kpi-value" id="k-dist">-</div><div class="kpi-unit">km</div></div>
      <div class="kpi"><div class="kpi-icon" style="background:#dcfce7;color:#22c55e"><i class="fas fa-leaf"></i></div><div class="kpi-label">CO2 절감</div><div class="kpi-value" id="k-co2">-</div><div class="kpi-unit">kg CO2</div></div>
    </div>
    <div class="chart-grid">
      <div class="chart-card"><h3><i class="fas fa-chart-bar" style="color:#10b981"></i>일별 배출 추이</h3><div style="position:relative;height:280px"><canvas id="chDaily"></canvas></div></div>
      <div class="chart-card"><h3><i class="fas fa-chart-doughnut" style="color:#3b82f6"></i>처리 단계별 현황</h3><div style="position:relative;height:280px"><canvas id="chStage"></canvas></div></div>
    </div>
    <div class="chart-grid">
      <div class="chart-card"><h3><i class="fas fa-chart-pie" style="color:#14b8a6"></i>폐기물 종류별 비중</h3><div style="position:relative;height:280px"><canvas id="chType"></canvas></div></div>
      <div class="chart-card"><h3><i class="fas fa-building" style="color:#8b5cf6"></i>배출처별 처리량</h3><div style="position:relative;height:280px"><canvas id="chCenter"></canvas></div></div>
    </div>
    <div class="card" style="margin-bottom:24px">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:16px;display:flex;align-items:center;gap:8px"><i class="fas fa-leaf" style="color:#22c55e"></i>탄소 배출/절감 요약</h3>
      <div class="co2-grid">
        <div class="co2-box" style="background:#fef2f2"><div class="co2-label" style="color:#dc2626">운송 CO2 배출</div><div class="co2-val" style="color:#b91c1c" id="co2e">-</div><div class="co2-unit" style="color:#f87171">kg CO2</div></div>
        <div class="co2-box" style="background:#f0fdf4"><div class="co2-label" style="color:#16a34a">재활용 CO2 절감</div><div class="co2-val" style="color:#15803d" id="co2s">-</div><div class="co2-unit" style="color:#4ade80">kg CO2</div></div>
        <div class="co2-box" style="background:#eff6ff"><div class="co2-label" style="color:#2563eb">순 CO2 절감</div><div class="co2-val" style="color:#1d4ed8" id="co2n">-</div><div class="co2-unit" style="color:#60a5fa">kg CO2</div></div>
      </div>
    </div>
    <div class="card">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:12px;display:flex;align-items:center;gap:8px"><i class="fas fa-truck" style="color:#3b82f6"></i>수거 업체별 통계</h3>
      <div class="tbl-wrap">
        <table class="collector-tbl">
          <thead><tr><th>업체명</th><th>수거 건수</th><th>수거 중량(kg)</th><th>이동 거리(km)</th></tr></thead>
          <tbody id="collectorBody"><tr><td colspan="4" style="text-align:center;color:var(--c-text3);padding:20px">로딩 중...</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ==================== DATA INPUT ==================== -->
<div id="pg-input" class="page">
  <div class="header">
    <div class="header-left">
      <h2><i class="fas fa-edit" style="color:var(--c-primary);margin-right:6px"></i>단계별 데이터 입력</h2>
      <p>배출 > 수거/운송 > 압축(KNT) > 재활용 > 생산</p>
    </div>
  </div>
  <div class="content">
    <div class="step-tabs">
      <button class="step-tab on" data-step="1"><i class="fas fa-truck-loading"></i> 1. 배출</button>
      <i class="fas fa-chevron-right step-arrow"></i>
      <button class="step-tab" data-step="2"><i class="fas fa-truck"></i> 2. 수거</button>
      <i class="fas fa-chevron-right step-arrow"></i>
      <button class="step-tab" data-step="3"><i class="fas fa-compress-arrows-alt"></i> 3. 압축</button>
      <i class="fas fa-chevron-right step-arrow"></i>
      <button class="step-tab" data-step="4"><i class="fas fa-recycle"></i> 4. 재활용</button>
      <i class="fas fa-chevron-right step-arrow"></i>
      <button class="step-tab" data-step="5"><i class="fas fa-industry"></i> 5. 생산</button>
    </div>

    <!-- STEP 1 -->
    <div id="fp1" class="form-panel show">
      <div class="card">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:20px;display:flex;align-items:center;gap:8px"><i class="fas fa-truck-loading" style="color:#10b981"></i>배출 등록</h3>
        <form id="f1" class="form-grid">
          <div class="form-group"><label>배출일 *</label><input type="date" name="dischargeDate" required></div>
          <div class="form-group"><label>폐기물 종류 *</label><select name="wasteType" id="selWasteType" required><option value="">선택하세요</option></select></div>
          <div class="form-group"><label>배출처 *</label><select name="centerCode" id="selCenter" required onchange="onCenterSelect(this)"><option value="">선택하세요</option></select></div>
          <div class="form-group"><label>배출처명</label><input name="centerName" id="inpCenterName" readonly placeholder="자동입력"></div>
          <div class="form-group"><label>담당자</label><input name="dischargeManager" placeholder="홍길동"></div>
          <div class="form-group"><label>배출 중량(kg) *</label><input type="number" step="0.01" name="weightKg" required placeholder="1500.00"></div>
          <div class="form-group full"><label>비고</label><textarea name="remarks" rows="2" placeholder="특이사항을 입력하세요"></textarea></div>
          <div class="full" style="text-align:right"><button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> 배출 등록</button></div>
        </form>
      </div>
    </div>

    <!-- STEP 2 -->
    <div id="fp2" class="form-panel">
      <div class="card">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:20px;display:flex;align-items:center;gap:8px"><i class="fas fa-truck" style="color:#3b82f6"></i>수거/운송 등록</h3>
        <form id="f2" class="form-grid">
          <div class="form-group"><label>트래킹 ID *</label><input type="number" name="trackingId" required placeholder="숫자 ID"></div>
          <div class="form-group"><label>수거 업체 *</label><select name="collectorCode" id="selCollector" required onchange="onColSelect(this)"><option value="">선택하세요</option></select></div>
          <div class="form-group"><label>수거 업체명</label><input name="collectorName" id="inpColName" readonly placeholder="자동입력"></div>
          <div class="form-group"><label>차량 번호</label><input name="vehicleNo" placeholder="12가3456"></div>
          <div class="form-group"><label>운전기사</label><input name="driverName" placeholder="박운전"></div>
          <div class="form-group"><label>수거 시작 *</label><input type="datetime-local" name="collectionStartAt" required></div>
          <div class="form-group"><label>수거 완료</label><input type="datetime-local" name="collectionEndAt"></div>
          <div class="form-group"><label>수거 중량(kg) *</label><input type="number" step="0.01" name="collectedWeightKg" required placeholder="1500.00"></div>
          <div class="form-group"><label>출발지</label><input name="originAddress" placeholder="서울시 강남구"></div>
          <div class="form-group"><label>도착지</label><input name="destinationAddress" placeholder="경기도 화성시"></div>
          <div class="form-group"><label>이동 거리(km)</label><input type="number" step="0.01" name="distanceKm" placeholder="85.5"></div>
          <div class="form-group"><label>비고</label><textarea name="remarks" rows="2"></textarea></div>
          <div class="full" style="text-align:right"><button type="submit" class="btn btn-blue"><i class="fas fa-save"></i> 수거 등록</button></div>
        </form>
      </div>
    </div>

    <!-- STEP 3 -->
    <div id="fp3" class="form-panel">
      <div class="card">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:20px;display:flex;align-items:center;gap:8px"><i class="fas fa-compress-arrows-alt" style="color:#f59e0b"></i>압축 처리 등록 (KNT)</h3>
        <form id="f3" class="form-grid">
          <div class="form-group"><label>트래킹 ID *</label><input type="number" name="trackingId" required></div>
          <div class="form-group"><label>처리 업체 *</label><select name="processorCode" id="selProcessor" required onchange="onProcSelect(this)"><option value="">선택하세요</option></select></div>
          <div class="form-group"><label>처리 업체명</label><input name="processorName" id="inpProcName" readonly placeholder="자동입력"></div>
          <div class="form-group"><label>처리 시작 *</label><input type="datetime-local" name="processStartAt" required></div>
          <div class="form-group"><label>처리 완료</label><input type="datetime-local" name="processEndAt"></div>
          <div class="form-group"><label>입고 중량(kg) *</label><input type="number" step="0.01" name="inputWeightKg" required placeholder="1500.00"></div>
          <div class="form-group"><label>출고 중량(kg)</label><input type="number" step="0.01" name="outputWeightKg" placeholder="1425.00"></div>
          <div class="form-group"><label>베일 수량</label><input type="number" name="baleCount" placeholder="3"></div>
          <div class="form-group"><label>압축 밀도(kg/m3)</label><input type="number" step="0.01" name="compressionDensity" placeholder="450.00"></div>
          <div class="form-group"><label>비고</label><textarea name="remarks" rows="2"></textarea></div>
          <div class="full" style="text-align:right"><button type="submit" class="btn btn-amber"><i class="fas fa-save"></i> 압축 등록</button></div>
        </form>
      </div>
    </div>

    <!-- STEP 4 -->
    <div id="fp4" class="form-panel">
      <div class="card">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:20px;display:flex;align-items:center;gap:8px"><i class="fas fa-recycle" style="color:#8b5cf6"></i>재활용 등록</h3>
        <form id="f4" class="form-grid">
          <div class="form-group"><label>트래킹 ID *</label><input type="number" name="trackingId" required></div>
          <div class="form-group"><label>재활용 업체 *</label><select name="recyclerCode" id="selRecycler" required onchange="onRecySelect(this)"><option value="">선택하세요</option></select></div>
          <div class="form-group"><label>재활용 업체명</label><input name="recyclerName" id="inpRecyName" readonly placeholder="자동입력"></div>
          <div class="form-group"><label>처리 시작 *</label><input type="datetime-local" name="processStartAt" required></div>
          <div class="form-group"><label>처리 완료</label><input type="datetime-local" name="processEndAt"></div>
          <div class="form-group"><label>입고 중량(kg) *</label><input type="number" step="0.01" name="inputWeightKg" required placeholder="1425.00"></div>
          <div class="form-group"><label>산출 중량(kg)</label><input type="number" step="0.01" name="outputWeightKg" placeholder="1282.50"></div>
          <div class="form-group"><label>재활용 방법</label><input name="recyclingMethod" placeholder="파쇄>세척>탈수>건조"></div>
          <div class="form-group full"><label>비고</label><textarea name="remarks" rows="2"></textarea></div>
          <div class="full" style="text-align:right"><button type="submit" class="btn btn-purple"><i class="fas fa-save"></i> 재활용 등록</button></div>
        </form>
      </div>
    </div>

    <!-- STEP 5 -->
    <div id="fp5" class="form-panel">
      <div class="card">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:20px;display:flex;align-items:center;gap:8px"><i class="fas fa-industry" style="color:#ef4444"></i>제품 생산 등록</h3>
        <form id="f5" class="form-grid">
          <div class="form-group"><label>트래킹 ID *</label><input type="number" name="trackingId" required></div>
          <div class="form-group"><label>생산 업체 *</label><select name="producerCode" id="selProducer" required onchange="onProdSelect(this)"><option value="">선택하세요</option></select></div>
          <div class="form-group"><label>생산 업체명</label><input name="producerName" id="inpProdName" readonly placeholder="자동입력"></div>
          <div class="form-group"><label>제품명 *</label><input name="productName" required placeholder="재생 A4 용지"></div>
          <div class="form-group"><label>제품 코드</label><input name="productCode" placeholder="RP-A4-001"></div>
          <div class="form-group"><label>생산 시작 *</label><input type="datetime-local" name="productionStartAt" required></div>
          <div class="form-group"><label>생산 완료</label><input type="datetime-local" name="productionEndAt"></div>
          <div class="form-group"><label>투입 중량(kg) *</label><input type="number" step="0.01" name="inputWeightKg" required></div>
          <div class="form-group"><label>생산 중량(kg)</label><input type="number" step="0.01" name="outputWeightKg"></div>
          <div class="form-group"><label>생산 수량</label><input type="number" name="productionQty"></div>
          <div class="form-group"><label>납품처</label><input name="deliveryDestination" placeholder="오피스디포 본사"></div>
          <div class="form-group"><label>납품일</label><input type="date" name="deliveryDate"></div>
          <div class="form-group full"><label>비고</label><textarea name="remarks" rows="2"></textarea></div>
          <div class="full" style="text-align:right"><button type="submit" class="btn btn-red"><i class="fas fa-save"></i> 생산 등록</button></div>
        </form>
      </div>
    </div>
  </div>
</div>

<!-- ==================== TRACKING ==================== -->
<div id="pg-tracking" class="page">
  <div class="header">
    <div class="header-left">
      <h2><i class="fas fa-route" style="color:var(--c-primary);margin-right:6px"></i>폐기물 흐름 추적</h2>
      <p>Tracking ID로 배출 > 수거 > 압축 > 재활용 > 생산 전 과정 추적</p>
    </div>
  </div>
  <div class="content">
    <div class="card" style="margin-bottom:24px">
      <div class="search-bar">
        <div class="form-group"><label>트래킹 ID 또는 번호 검색</label><input id="srcId" placeholder="숫자 ID 입력 후 Enter" onkeydown="if(event.key==='Enter')srcTrack()"></div>
        <button class="btn btn-primary" onclick="srcTrack()" style="margin-bottom:0"><i class="fas fa-search"></i> 조회</button>
        <button class="btn btn-gray" onclick="loadList()" style="margin-bottom:0"><i class="fas fa-list"></i> 전체 목록</button>
      </div>
    </div>
    <div id="trkDetail" style="display:none">
      <div class="card" style="margin-bottom:20px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:16px">
          <h3 style="font-size:17px;font-weight:700" id="td-no">-</h3>
          <span id="td-st"></span>
        </div>
        <div id="timeline" class="timeline-wrap"></div>
      </div>
      <div id="stCards" class="detail-grid"></div>
    </div>
    <div class="card">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:4px"><i class="fas fa-list" style="color:var(--c-primary);margin-right:6px"></i>트래킹 목록</h3>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>ID</th><th>트래킹번호</th><th>종류</th><th>배출처</th><th>중량(kg)</th><th>단계</th><th>상태</th><th style="text-align:center">상세</th></tr></thead>
          <tbody id="trkBody"><tr><td colspan="8" style="text-align:center;color:var(--c-text3);padding:40px"><div class="loading"><div class="spinner"></div> 데이터를 불러오는 중...</div></td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ==================== ADMIN ==================== -->
<div id="pg-admin" class="page">
  <div class="header">
    <div class="header-left">
      <h2><i class="fas fa-cogs" style="color:var(--c-primary);margin-right:6px"></i>시스템 관리</h2>
      <p>마스터 데이터 관리 (관리자 전용)</p>
    </div>
    <div class="header-right">
      <div class="user-bar" id="userBar" style="display:none">
        <div class="avatar" id="userAvatar">A</div>
        <div>
          <div class="user-name" id="userName">관리자</div>
          <span class="user-role" id="userRole">ADMIN</span>
        </div>
        <button class="btn-logout" onclick="doLogout()"><i class="fas fa-sign-out-alt"></i> 로그아웃</button>
      </div>
    </div>
  </div>
  <div class="content">
    <div class="admin-tabs">
      <button class="admin-tab on" data-at="centers"><i class="fas fa-building"></i> 물류센터</button>
      <button class="admin-tab" data-at="wasteTypes"><i class="fas fa-trash"></i> 폐기물 종류</button>
      <button class="admin-tab" data-at="collectors"><i class="fas fa-truck"></i> 수거 업체</button>
      <button class="admin-tab" data-at="processors"><i class="fas fa-compress-arrows-alt"></i> 압축 업체</button>
      <button class="admin-tab" data-at="recyclers"><i class="fas fa-recycle"></i> 재활용 업체</button>
      <button class="admin-tab" data-at="producers"><i class="fas fa-industry"></i> 생산 업체</button>
      <button class="admin-tab" data-at="issues"><i class="fas fa-exclamation-circle"></i> 이슈 관리</button>
      <button class="admin-tab" data-at="users"><i class="fas fa-users"></i> 사용자</button>
    </div>

    <!-- Centers -->
    <div id="ap-centers" class="admin-panel show">
      <div class="card">
        <div class="admin-toolbar"><h3><i class="fas fa-building" style="color:#8b5cf6"></i>물류센터(배출처) 관리<span class="admin-count" id="acCnt"></span></h3><button class="btn btn-primary btn-sm" onclick="openAddCenter()"><i class="fas fa-plus"></i> 신규 등록</button></div>
        <div class="tbl-wrap"><table><thead><tr><th>코드</th><th>센터명</th><th>주소</th><th>담당자</th><th>연락처</th><th>상태</th><th>관리</th></tr></thead><tbody id="tbCenters"></tbody></table></div>
      </div>
    </div>

    <!-- Waste Types -->
    <div id="ap-wasteTypes" class="admin-panel">
      <div class="card">
        <div class="admin-toolbar"><h3><i class="fas fa-trash" style="color:#14b8a6"></i>폐기물 종류 관리<span class="admin-count" id="awCnt"></span></h3><button class="btn btn-primary btn-sm" onclick="openAddWT()"><i class="fas fa-plus"></i> 신규 등록</button></div>
        <div class="tbl-wrap"><table><thead><tr><th>코드</th><th>종류명</th><th>설명</th><th>단위</th><th>상태</th><th>관리</th></tr></thead><tbody id="tbWasteTypes"></tbody></table></div>
      </div>
    </div>

    <!-- Collectors -->
    <div id="ap-collectors" class="admin-panel">
      <div class="card">
        <div class="admin-toolbar"><h3><i class="fas fa-truck" style="color:#3b82f6"></i>수거 업체 관리<span class="admin-count" id="acolCnt"></span></h3><button class="btn btn-primary btn-sm" onclick="openAddCol()"><i class="fas fa-plus"></i> 신규 등록</button></div>
        <div class="tbl-wrap"><table><thead><tr><th>코드</th><th>업체명</th><th>주소</th><th>담당자</th><th>연락처</th><th>차량수</th><th>상태</th><th>관리</th></tr></thead><tbody id="tbCollectors"></tbody></table></div>
      </div>
    </div>

    <!-- Processors -->
    <div id="ap-processors" class="admin-panel">
      <div class="card">
        <div class="admin-toolbar"><h3><i class="fas fa-compress-arrows-alt" style="color:#f59e0b"></i>압축 처리 업체 관리<span class="admin-count" id="aprocCnt"></span></h3><button class="btn btn-primary btn-sm" onclick="openAddProc()"><i class="fas fa-plus"></i> 신규 등록</button></div>
        <div class="tbl-wrap"><table><thead><tr><th>코드</th><th>업체명</th><th>주소</th><th>담당자</th><th>연락처</th><th>처리용량(kg)</th><th>상태</th><th>관리</th></tr></thead><tbody id="tbProcessors"></tbody></table></div>
      </div>
    </div>

    <!-- Recyclers -->
    <div id="ap-recyclers" class="admin-panel">
      <div class="card">
        <div class="admin-toolbar"><h3><i class="fas fa-recycle" style="color:#8b5cf6"></i>재활용 업체 관리<span class="admin-count" id="arecCnt"></span></h3><button class="btn btn-primary btn-sm" onclick="openAddRecy()"><i class="fas fa-plus"></i> 신규 등록</button></div>
        <div class="tbl-wrap"><table><thead><tr><th>코드</th><th>업체명</th><th>주소</th><th>담당자</th><th>연락처</th><th>처리 가능 종류</th><th>상태</th><th>관리</th></tr></thead><tbody id="tbRecyclers"></tbody></table></div>
      </div>
    </div>

    <!-- Producers -->
    <div id="ap-producers" class="admin-panel">
      <div class="card">
        <div class="admin-toolbar"><h3><i class="fas fa-industry" style="color:#ef4444"></i>생산 업체 관리<span class="admin-count" id="aprdCnt"></span></h3><button class="btn btn-primary btn-sm" onclick="openAddProd()"><i class="fas fa-plus"></i> 신규 등록</button></div>
        <div class="tbl-wrap"><table><thead><tr><th>코드</th><th>업체명</th><th>주소</th><th>담당자</th><th>연락처</th><th>생산 품목</th><th>상태</th><th>관리</th></tr></thead><tbody id="tbProducers"></tbody></table></div>
      </div>
    </div>

    <!-- Issues -->
    <div id="ap-issues" class="admin-panel">
      <div class="card">
        <div class="admin-toolbar">
          <h3><i class="fas fa-exclamation-circle" style="color:#ef4444"></i>이슈 관리<span class="admin-count" id="aissCnt"></span></h3>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <select id="issFilter" class="btn btn-outline btn-sm" style="padding:6px 12px" onchange="loadIssues()"><option value="ALL">전체</option><option value="OPEN">미해결</option><option value="IN_PROGRESS">처리중</option><option value="RESOLVED">해결됨</option><option value="CLOSED">종료</option></select>
            <button class="btn btn-primary btn-sm" onclick="openAddIssue()"><i class="fas fa-plus"></i> 이슈 등록</button>
          </div>
        </div>
        <div class="tbl-wrap"><table><thead><tr><th>ID</th><th>트래킹번호</th><th>유형</th><th>심각도</th><th>제목</th><th>보고자</th><th>상태</th><th>관리</th></tr></thead><tbody id="tbIssues"></tbody></table></div>
      </div>
    </div>

    <!-- Users -->
    <div id="ap-users" class="admin-panel">
      <div class="card">
        <div class="admin-toolbar"><h3><i class="fas fa-users" style="color:#059669"></i>사용자 관리<span class="admin-count" id="ausrCnt"></span></h3><button class="btn btn-primary btn-sm" onclick="openAddUser()"><i class="fas fa-plus"></i> 사용자 등록</button></div>
        <div class="tbl-wrap"><table><thead><tr><th>ID</th><th>로그인 ID</th><th>이름</th><th>역할</th><th>이메일</th><th>연락처</th><th>상태</th><th>관리</th></tr></thead><tbody id="tbUsers"></tbody></table></div>
      </div>
    </div>
  </div>
</div>

</div><!-- layout -->

<script>
/* ===== CONSTANTS ===== */
const W={PAPER_WASTE:'폐지/파지',CARDBOARD:'골판지',MIXED_PAPER:'혼합 폐지',NEWSPAPER:'신문지',OTHER:'기타'};
const SL={DISCHARGE:'배출',COLLECTION:'수거',COMPRESSION:'압축',RECYCLING:'재활용',PRODUCTION:'생산'};
const SO={DISCHARGE:1,COLLECTION:2,COMPRESSION:3,RECYCLING:4,PRODUCTION:5};
const SI={DISCHARGE:'fa-truck-loading',COLLECTION:'fa-truck',COMPRESSION:'fa-compress-arrows-alt',RECYCLING:'fa-recycle',PRODUCTION:'fa-industry'};
const SC_MAP={INITIATED:{bg:'#dbeafe',c:'#1d4ed8',t:'시작됨'},IN_PROGRESS:{bg:'#fef3c7',c:'#92400e',t:'진행 중'},COMPLETED:{bg:'#d1fae5',c:'#065f46',t:'완료'},CANCELLED:{bg:'#fee2e2',c:'#991b1b',t:'취소'}};
const IT={DELAY:'지연',QUALITY:'품질',WEIGHT_DIFF:'중량차이',ACCIDENT:'사고',OTHER:'기타'};
const IST={OPEN:'미해결',IN_PROGRESS:'처리중',RESOLVED:'해결됨',CLOSED:'종료'};
const SEV={LOW:'낮음',MEDIUM:'보통',HIGH:'높음',CRITICAL:'긴급'};
const COLORS=['#10b981','#3b82f6','#f59e0b','#8b5cf6','#ef4444','#14b8a6','#f97316','#06b6d4'];
let ch1,ch2,ch3,ch4;

/* ===== AUTH STATE ===== */
let authToken=localStorage.getItem('wms_token')||null;
let authUser=JSON.parse(localStorage.getItem('wms_user')||'null');

function isAdmin(){ return authUser && authUser.role==='ADMIN' }
function authHeaders(){ return authToken?{'Authorization':'Bearer '+authToken,'Content-Type':'application/json'}:{'Content-Type':'application/json'} }

function updateAuthUI(){
  const show=isAdmin();
  const lockIcon=document.getElementById('adminLockIcon');
  if(lockIcon) lockIcon.style.display=show?'none':'';
  if(show){
    document.getElementById('userBar').style.display='flex';
    document.getElementById('userName').textContent=authUser.userName;
    document.getElementById('userRole').textContent=authUser.role;
    document.getElementById('userAvatar').textContent=authUser.userName.charAt(0);
    document.getElementById('sidebarUser').style.display='block';
    document.getElementById('sidebarUser').innerHTML='<i class="fas fa-user-shield"></i> '+authUser.userName;
  } else {
    document.getElementById('userBar').style.display='none';
    document.getElementById('sidebarUser').style.display='none';
  }
}

async function checkAuth(){
  if(!authToken) return;
  try{
    const r=await(await fetch('/waste-api/auth/me',{headers:authHeaders()})).json();
    if(!r.success){authToken=null;authUser=null;localStorage.removeItem('wms_token');localStorage.removeItem('wms_user')}
  }catch(e){/* ignore */}
  updateAuthUI();
}

/* ===== HELPERS ===== */
function fmt(v){return v==null||v===''?'0':Number(v).toLocaleString('ko-KR',{maximumFractionDigits:1})}
function fj(form){const o={};new FormData(form).forEach((v,k)=>{if(v==='')return;if(['trackingId','baleCount','productionQty'].includes(k))o[k]=parseInt(v);else if(['weightKg','collectedWeightKg','inputWeightKg','outputWeightKg','distanceKm','compressionDensity'].includes(k))o[k]=parseFloat(v);else o[k]=v});return o}

function toast(msg,ok=true){
  const t=document.getElementById('toast');
  t.textContent=msg;
  t.style.background=ok?'linear-gradient(135deg,#059669,#10b981)':'linear-gradient(135deg,#dc2626,#ef4444)';
  t.style.display='block';
  setTimeout(()=>t.style.display='none',3500);
}

function activeBadge(v){ return v==='Y'?'<span class="active-y">활성</span>':'<span class="active-n">비활성</span>' }

function emptyRow(colspan,text='데이터가 없습니다'){return '<tr><td colspan="'+colspan+'" class="empty-state"><i class="fas fa-inbox"></i>'+text+'</td></tr>'}

/* ===== LOGIN =====*/
function showLogin(){
  document.getElementById('loginModal').classList.add('show');
  document.getElementById('loginId').focus();
}
function closeLogin(){document.getElementById('loginModal').classList.remove('show')}

document.getElementById('loginForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const loginId=document.getElementById('loginId').value;
  const password=document.getElementById('loginPw').value;
  const errEl=document.getElementById('loginErr');
  errEl.style.display='none';
  try{
    const r=await(await fetch('/waste-api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({loginId,password})})).json();
    if(r.success){
      authToken=r.data.token;
      authUser={userName:r.data.userName,role:r.data.role,loginId:r.data.loginId};
      localStorage.setItem('wms_token',authToken);
      localStorage.setItem('wms_user',JSON.stringify(authUser));
      closeLogin();
      updateAuthUI();
      toast('환영합니다, '+r.data.userName+'님!');
      // navigate to admin
      navTo('admin');
    }else{
      errEl.textContent=r.message;errEl.style.display='block';
    }
  }catch(x){errEl.textContent='로그인 실패';errEl.style.display='block'}
});

async function doLogout(){
  try{await fetch('/waste-api/auth/logout',{method:'POST',headers:authHeaders()})}catch(e){}
  authToken=null;authUser=null;
  localStorage.removeItem('wms_token');localStorage.removeItem('wms_user');
  updateAuthUI();
  navTo('dashboard');
  toast('로그아웃 되었습니다');
}

/* ===== NAVIGATION ===== */
function navTo(page){
  document.querySelectorAll('.page').forEach(pg=>pg.classList.remove('active'));
  document.getElementById('pg-'+page).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n=>{
    n.classList.toggle('active',n.dataset.page===page);
  });
  if(page==='dashboard')loadDash();
  if(page==='tracking')loadList();
  if(page==='admin')loadAdminData();
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
}

document.querySelectorAll('.nav-item').forEach(el=>{
  el.addEventListener('click',()=>{
    const p=el.dataset.page;
    if(p==='admin'&&!isAdmin()){showLogin();return}
    navTo(p);
  });
});
document.getElementById('mobileToggle').addEventListener('click',()=>{
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('overlay').classList.toggle('open');
});
document.getElementById('overlay').addEventListener('click',()=>{
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
});

/* ===== ADMIN TABS ===== */
document.querySelectorAll('.admin-tab').forEach(tab=>{
  tab.addEventListener('click',()=>{
    document.querySelectorAll('.admin-panel').forEach(p=>p.classList.remove('show'));
    document.getElementById('ap-'+tab.dataset.at).classList.add('show');
    document.querySelectorAll('.admin-tab').forEach(t=>t.classList.remove('on'));
    tab.classList.add('on');
  });
});

/* ===== STEP TABS ===== */
document.querySelectorAll('.step-tab').forEach(tab=>{
  tab.addEventListener('click',()=>{
    const n=tab.dataset.step;
    document.querySelectorAll('.form-panel').forEach(fp=>fp.classList.remove('show'));
    document.getElementById('fp'+n).classList.add('show');
    document.querySelectorAll('.step-tab').forEach(t=>t.classList.remove('on'));
    tab.classList.add('on');
  });
});

/* ===== LOOKUP DATA FOR FORMS ===== */
let lookupCenters=[],lookupWT=[],lookupCol=[],lookupProc=[],lookupRecy=[],lookupProd=[];

async function loadLookups(){
  try{
    const [c,w,co,pr,rc,pd]=await Promise.all([
      fetch('/waste-api/lookup/centers').then(r=>r.json()),
      fetch('/waste-api/lookup/waste-types').then(r=>r.json()),
      fetch('/waste-api/lookup/collectors').then(r=>r.json()),
      fetch('/waste-api/lookup/processors').then(r=>r.json()),
      fetch('/waste-api/lookup/recyclers').then(r=>r.json()),
      fetch('/waste-api/lookup/producers').then(r=>r.json())
    ]);
    lookupCenters=c.data||[];lookupWT=w.data||[];lookupCol=co.data||[];
    lookupProc=pr.data||[];lookupRecy=rc.data||[];lookupProd=pd.data||[];
    fillSelect('selCenter',lookupCenters,'CENTER_CODE','CENTER_NAME');
    fillSelect('selWasteType',lookupWT,'TYPE_CODE','TYPE_NAME');
    fillSelect('selCollector',lookupCol,'COLLECTOR_CODE','COLLECTOR_NAME');
    fillSelect('selProcessor',lookupProc,'PROCESSOR_CODE','PROCESSOR_NAME');
    fillSelect('selRecycler',lookupRecy,'RECYCLER_CODE','RECYCLER_NAME');
    fillSelect('selProducer',lookupProd,'PRODUCER_CODE','PRODUCER_NAME');
  }catch(e){console.error('Lookup load failed',e)}
}

function fillSelect(id,data,codeFld,nameFld){
  const el=document.getElementById(id);
  const first=el.options[0];
  el.innerHTML='';
  el.appendChild(first);
  data.forEach(d=>{const o=document.createElement('option');o.value=d[codeFld];o.textContent=d[nameFld];o.dataset.name=d[nameFld];el.appendChild(o)});
}

function onCenterSelect(sel){document.getElementById('inpCenterName').value=sel.options[sel.selectedIndex]?.dataset?.name||''}
function onColSelect(sel){document.getElementById('inpColName').value=sel.options[sel.selectedIndex]?.dataset?.name||''}
function onProcSelect(sel){document.getElementById('inpProcName').value=sel.options[sel.selectedIndex]?.dataset?.name||''}
function onRecySelect(sel){document.getElementById('inpRecyName').value=sel.options[sel.selectedIndex]?.dataset?.name||''}
function onProdSelect(sel){document.getElementById('inpProdName').value=sel.options[sel.selectedIndex]?.dataset?.name||''}

/* ===== DASHBOARD ===== */
document.addEventListener('DOMContentLoaded',()=>{
  const d=new Date(),p=new Date(d);p.setDate(d.getDate()-30);
  document.getElementById('sd').value=p.toISOString().slice(0,10);
  document.getElementById('ed').value=d.toISOString().slice(0,10);
  loadDash();loadLookups();checkAuth();
});

async function loadDash(){
  const s=document.getElementById('sd').value,e=document.getElementById('ed').value;
  try{
    const r=await(await fetch('/waste-api/dashboard?startDate='+s+'&endDate='+e)).json();
    if(r.success)renderDash(r.data);else toast(r.message,false);
  }catch(e){console.error(e);toast('대시보드 데이터 로딩 실패',false)}
}

function renderDash(d){
  document.getElementById('k-wt').textContent=fmt(d.totalWeightKg);
  document.getElementById('k-cnt').textContent=d.totalCount;
  document.getElementById('k-recycle').textContent=(d.avgRecyclingRate||0).toFixed(1);
  document.getElementById('k-loss').textContent=(d.avgLossRate||0).toFixed(1);
  document.getElementById('k-dist').textContent=fmt(d.totalDistanceKm);
  document.getElementById('k-co2').textContent=fmt(d.totalCo2SavingKg);
  const em=d.totalCo2EmissionKg||0,sv=d.totalCo2SavingKg||0;
  document.getElementById('co2e').textContent=fmt(em);
  document.getElementById('co2s').textContent=fmt(sv);
  document.getElementById('co2n').textContent=fmt(sv-em);
  const cs=d.collectorStats||[];
  const cb=document.getElementById('collectorBody');
  if(cs.length){cb.innerHTML=cs.map(r=>'<tr><td style="font-weight:600">'+r.name+'</td><td>'+r.cnt+'건</td><td style="font-weight:600">'+fmt(r.wt)+'</td><td>'+fmt(r.dist)+'</td></tr>').join('')}
  else{cb.innerHTML='<tr><td colspan="4" style="text-align:center;color:var(--c-text3);padding:20px">데이터 없음</td></tr>'}
  if(ch1)ch1.destroy();if(ch2)ch2.destroy();if(ch3)ch3.destroy();if(ch4)ch4.destroy();
  const ds=d.dailyStats||[];
  ch1=new Chart(document.getElementById('chDaily'),{type:'bar',data:{labels:ds.map(x=>{const p=x.dt.split('-');return p[1]+'/'+p[2]}),datasets:[{label:'배출량(kg)',data:ds.map(x=>x.wt),backgroundColor:'rgba(16,185,129,.65)',borderColor:'#10b981',borderWidth:1,borderRadius:6,barPercentage:.6},{label:'건수',data:ds.map(x=>x.cnt),type:'line',borderColor:'#3b82f6',backgroundColor:'rgba(59,130,246,.08)',yAxisID:'y1',tension:.4,pointRadius:5,pointBackgroundColor:'#3b82f6',fill:true}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{font:{size:12}}}},scales:{y:{beginAtZero:true,title:{display:true,text:'kg',font:{size:11}},grid:{color:'rgba(0,0,0,.04)'}},y1:{beginAtZero:true,position:'right',grid:{drawOnChartArea:false},title:{display:true,text:'건수',font:{size:11}}},x:{grid:{display:false}}}}});
  const ss=d.stageStats||[];
  ch2=new Chart(document.getElementById('chStage'),{type:'doughnut',data:{labels:ss.map(x=>SL[x.stage]||x.stage),datasets:[{data:ss.map(x=>x.cnt),backgroundColor:COLORS.slice(0,ss.length),borderWidth:3,borderColor:'#fff',hoverOffset:8}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{padding:16,font:{size:12}}}},cutout:'60%'}});
  const wt=d.wasteTypeStats||[];
  ch3=new Chart(document.getElementById('chType'),{type:'pie',data:{labels:wt.map(x=>W[x.tp]||x.tp),datasets:[{data:wt.map(x=>x.wt),backgroundColor:COLORS.slice(0,wt.length),borderWidth:3,borderColor:'#fff',hoverOffset:8}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{padding:16,font:{size:12}}}}}});
  const ct=d.centerStats||[];
  ch4=new Chart(document.getElementById('chCenter'),{type:'bar',data:{labels:ct.map(x=>x.name),datasets:[{label:'처리량(kg)',data:ct.map(x=>x.wt),backgroundColor:COLORS.map(c=>c+'cc'),borderColor:COLORS,borderWidth:1,borderRadius:6,barPercentage:.7}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,title:{display:true,text:'kg',font:{size:11}},grid:{color:'rgba(0,0,0,.04)'}},y:{grid:{display:false}}}}});
}

/* ===== FORM SUBMIT ===== */
const API={1:'/waste-api/tracking/discharge',2:'/waste-api/tracking/collection',3:'/waste-api/tracking/compression',4:'/waste-api/tracking/recycling',5:'/waste-api/tracking/production'};
[1,2,3,4,5].forEach(n=>{
  document.getElementById('f'+n).addEventListener('submit',async e=>{
    e.preventDefault();
    const btn=e.target.querySelector('button[type=submit]');
    const origText=btn.innerHTML;
    btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> 처리 중...';btn.disabled=true;
    try{
      const r=await(await fetch(API[n],{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fj(e.target))})).json();
      if(r.success){toast(r.message+(r.data?.trackingNo?' ('+r.data.trackingNo+')':''));e.target.reset()}
      else{toast(r.message,false)}
    }catch(x){toast('오류: '+x.message,false)}
    finally{btn.innerHTML=origText;btn.disabled=false}
  });
});

/* ===== TRACKING LIST ===== */
async function loadList(){
  document.getElementById('trkDetail').style.display='none';
  const body=document.getElementById('trkBody');
  body.innerHTML='<tr><td colspan="8" style="text-align:center;padding:30px"><div class="loading"><div class="spinner"></div> 불러오는 중...</div></td></tr>';
  try{const r=await(await fetch('/waste-api/tracking?size=50')).json();if(r.success)renderTbl(r.data.content||[])}
  catch(e){body.innerHTML='<tr><td colspan="8" style="text-align:center;color:var(--c-text3);padding:40px">데이터 로딩 실패</td></tr>'}
}
async function srcTrack(){
  const v=document.getElementById('srcId').value.trim();
  if(!v)return toast('트래킹 ID를 입력하세요',false);
  try{const r=await(await fetch('/waste-api/tracking/'+v)).json();if(r.success&&r.data)renderDetail(r.data);else toast('조회 결과가 없습니다',false)}catch(e){toast('조회 실패',false)}
}
function renderTbl(rows){
  const b=document.getElementById('trkBody');
  if(!rows.length){b.innerHTML=emptyRow(8);return}
  b.innerHTML=rows.map(r=>{
    const sc=SC_MAP[r.STATUS]||{bg:'#f3f4f6',c:'#374151',t:r.STATUS};
    return '<tr style="cursor:pointer" onclick="viewId('+r.TRACKING_ID+')"><td style="color:var(--c-text2)">'+r.TRACKING_ID+'</td><td><span class="mono">'+r.TRACKING_NO+'</span></td><td>'+(W[r.WASTE_TYPE]||r.WASTE_TYPE)+'</td><td>'+r.SOURCE_NAME+'</td><td style="font-weight:700">'+fmt(r.TOTAL_WEIGHT_KG)+'</td><td><span style="font-size:12px">'+(SL[r.CURRENT_STAGE]||r.CURRENT_STAGE)+' <span style="color:var(--c-text3)">('+SO[r.CURRENT_STAGE]+'/5)</span></span></td><td><span class="badge" style="background:'+sc.bg+';color:'+sc.c+'">'+sc.t+'</span></td><td style="text-align:center"><i class="fas fa-eye" style="color:var(--c-primary)"></i></td></tr>'
  }).join('');
}
async function viewId(id){
  document.getElementById('srcId').value=id;
  try{const r=await(await fetch('/waste-api/tracking/'+id)).json();if(r.success)renderDetail(r.data)}catch(e){}
}
function renderDetail(d){
  document.getElementById('trkDetail').style.display='block';
  const t=d.tracking;
  document.getElementById('td-no').textContent=t.TRACKING_NO+' (ID: '+t.TRACKING_ID+')';
  const sc=SC_MAP[t.STATUS]||{bg:'#f3f4f6',c:'#374151',t:t.STATUS};
  document.getElementById('td-st').innerHTML='<span class="badge" style="background:'+sc.bg+';color:'+sc.c+';font-size:13px;padding:5px 16px">'+sc.t+'</span>';
  const ci=SO[t.CURRENT_STAGE]||1;
  let tl='';const stages=['DISCHARGE','COLLECTION','COMPRESSION','RECYCLING','PRODUCTION'];
  stages.forEach((s,i)=>{
    const cls=i<ci-1?'done':i===ci-1?'now':'wait';
    const lcls=i<ci-1?'done':'wait';
    tl+='<div class="tl-step"><div class="tl-dot '+cls+'"><i class="fas '+SI[s]+'"></i></div><div class="tl-label" style="color:'+(cls==='wait'?'var(--c-text3)':'var(--c-text)')+'">'+SL[s]+'</div></div>';
    if(i<4)tl+='<div class="tl-connector '+lcls+'"></div>';
  });
  document.getElementById('timeline').innerHTML=tl;
  let html='';
  if(d.discharge){const x=d.discharge;html+=makeCard('배출','fa-truck-loading','#10b981',[['배출처',x.CENTER_NAME],['배출일',x.DISCHARGE_DATE],['중량',fmt(x.WEIGHT_KG)+' kg'],['종류',W[x.WASTE_TYPE]||x.WASTE_TYPE],['담당자',x.DISCHARGE_MANAGER||'-']])}
  if(d.collection){const x=d.collection;html+=makeCard('수거/운송','fa-truck','#3b82f6',[['업체',x.COLLECTOR_NAME],['차량',x.VEHICLE_NO||'-'],['중량',fmt(x.COLLECTED_WEIGHT_KG)+' kg'],['거리',x.DISTANCE_KM?fmt(x.DISTANCE_KM)+' km':'-'],['CO2 배출',x.CO2_EMISSION_KG?fmt(x.CO2_EMISSION_KG)+' kg':'-']])}
  if(d.compression){const x=d.compression;html+=makeCard('압축(KNT)','fa-compress-arrows-alt','#f59e0b',[['업체',x.PROCESSOR_NAME],['입고',fmt(x.INPUT_WEIGHT_KG)+' kg'],['출고',x.OUTPUT_WEIGHT_KG?fmt(x.OUTPUT_WEIGHT_KG)+' kg':'-'],['Loss',x.LOSS_WEIGHT_KG?fmt(x.LOSS_WEIGHT_KG)+' kg ('+x.LOSS_RATE+'%)':'-'],['베일',x.BALE_COUNT||'-']])}
  if(d.recycling){const x=d.recycling;html+=makeCard('재활용','fa-recycle','#8b5cf6',[['업체',x.RECYCLER_NAME],['입고',fmt(x.INPUT_WEIGHT_KG)+' kg'],['산출',x.OUTPUT_WEIGHT_KG?fmt(x.OUTPUT_WEIGHT_KG)+' kg':'-'],['재활용률',x.RECYCLING_RATE?x.RECYCLING_RATE+'%':'-'],['CO2 절감',x.CO2_SAVING_KG?fmt(x.CO2_SAVING_KG)+' kg':'-'],['방법',x.RECYCLING_METHOD||'-']])}
  if(d.production){const x=d.production;html+=makeCard('제품생산','fa-industry','#ef4444',[['업체',x.PRODUCER_NAME],['제품',x.PRODUCT_NAME],['투입',fmt(x.INPUT_WEIGHT_KG)+' kg'],['생산',x.OUTPUT_WEIGHT_KG?fmt(x.OUTPUT_WEIGHT_KG)+' kg':'-'],['수량',x.PRODUCTION_QTY||'-'],['납품처',x.DELIVERY_DESTINATION||'-']])}
  document.getElementById('stCards').innerHTML=html;
  document.getElementById('trkDetail').scrollIntoView({behavior:'smooth',block:'start'});
}
function makeCard(title,icon,color,items){
  let h='<div class="detail-card" style="border-top-color:'+color+'"><h4><i class="fas '+icon+'" style="color:'+color+'"></i>'+title+'</h4>';
  items.forEach(([l,v])=>{h+='<div class="detail-row"><span class="dl">'+l+'</span><span class="dv">'+v+'</span></div>'});
  return h+'</div>';
}

/* =============== ADMIN DATA =============== */
async function adminFetch(url){
  const r=await fetch(url,{headers:authHeaders()});
  const j=await r.json();
  if(!j.success){
    if(r.status===401||r.status===403){doLogout();toast(j.message,false)}
    return null;
  }
  return j.data;
}
async function adminPost(url,body){
  const r=await fetch(url,{method:'POST',headers:authHeaders(),body:JSON.stringify(body)});
  return await r.json();
}
async function adminPut(url,body){
  const r=await fetch(url,{method:'PUT',headers:authHeaders(),body:JSON.stringify(body)});
  return await r.json();
}
async function adminDel(url){
  const r=await fetch(url,{method:'DELETE',headers:authHeaders()});
  return await r.json();
}

async function loadAdminData(){
  await Promise.all([loadCenters(),loadWasteTypes(),loadCollectors(),loadProcessors(),loadRecyclers(),loadProducers(),loadIssues(),loadUsers()]);
}

/* --- Centers --- */
async function loadCenters(){
  const data=await adminFetch('/waste-api/admin/centers?all=true');
  if(!data)return;
  document.getElementById('acCnt').textContent='('+data.length+'건)';
  const b=document.getElementById('tbCenters');
  if(!data.length){b.innerHTML=emptyRow(7);return}
  b.innerHTML=data.map(r=>'<tr><td class="mono">'+r.CENTER_CODE+'</td><td style="font-weight:600">'+r.CENTER_NAME+'</td><td>'+(r.ADDRESS||'-')+'</td><td>'+(r.CONTACT_NAME||'-')+'</td><td>'+(r.CONTACT_PHONE||'-')+'</td><td>'+activeBadge(r.ACTIVE_YN)+'</td><td><button class="btn btn-sm btn-outline" onclick="editCenter('+r.CENTER_ID+')"><i class="fas fa-edit"></i></button> <button class="btn btn-sm btn-red" onclick="delCenter('+r.CENTER_ID+',\\''+r.CENTER_NAME+'\\')"><i class="fas fa-trash"></i></button></td></tr>').join('');
}
function openAddCenter(){openEditModal('신규 물류센터 등록','fa-building','#8b5cf6',[{n:'CENTER_CODE',l:'코드 *',ph:'CTR-007'},{n:'CENTER_NAME',l:'센터명 *',ph:'세종 물류센터'},{n:'ADDRESS',l:'주소',ph:'세종시 조치원읍'},{n:'CONTACT_NAME',l:'담당자',ph:'홍길동'},{n:'CONTACT_PHONE',l:'연락처',ph:'010-0000-0000'},{n:'REMARKS',l:'비고',type:'textarea'},{n:'ACTIVE_YN',l:'상태',type:'select',opts:[['Y','활성'],['N','비활성']]}],async d=>{const r=await adminPost('/waste-api/admin/centers',d);if(r.success){toast(r.message);closeEditModal();loadCenters();loadLookups()}else toast(r.message,false)})}
async function editCenter(id){
  const d=await adminFetch('/waste-api/admin/centers/'+id);if(!d)return;
  openEditModal('물류센터 수정','fa-building','#8b5cf6',[{n:'CENTER_CODE',l:'코드',v:d.CENTER_CODE,dis:true},{n:'CENTER_NAME',l:'센터명 *',v:d.CENTER_NAME},{n:'ADDRESS',l:'주소',v:d.ADDRESS},{n:'CONTACT_NAME',l:'담당자',v:d.CONTACT_NAME},{n:'CONTACT_PHONE',l:'연락처',v:d.CONTACT_PHONE},{n:'REMARKS',l:'비고',v:d.REMARKS,type:'textarea'},{n:'ACTIVE_YN',l:'상태',type:'select',opts:[['Y','활성'],['N','비활성']],v:d.ACTIVE_YN}],async data=>{const r=await adminPut('/waste-api/admin/centers/'+id,data);if(r.success){toast(r.message);closeEditModal();loadCenters();loadLookups()}else toast(r.message,false)})
}
async function delCenter(id,name){if(!confirm(name+' 센터를 삭제하시겠습니까?'))return;const r=await adminDel('/waste-api/admin/centers/'+id);if(r.success){toast(r.message);loadCenters();loadLookups()}else toast(r.message,false)}

/* --- Waste Types --- */
async function loadWasteTypes(){
  const data=await adminFetch('/waste-api/admin/waste-types?all=true');if(!data)return;
  document.getElementById('awCnt').textContent='('+data.length+'건)';
  const b=document.getElementById('tbWasteTypes');
  if(!data.length){b.innerHTML=emptyRow(6);return}
  b.innerHTML=data.map(r=>'<tr><td class="mono">'+r.TYPE_CODE+'</td><td style="font-weight:600">'+r.TYPE_NAME+'</td><td>'+(r.DESCRIPTION||'-')+'</td><td>'+(r.UNIT||'kg')+'</td><td>'+activeBadge(r.ACTIVE_YN)+'</td><td><button class="btn btn-sm btn-outline" onclick="editWT('+r.TYPE_ID+')"><i class="fas fa-edit"></i></button> <button class="btn btn-sm btn-red" onclick="delWT('+r.TYPE_ID+',\\''+r.TYPE_NAME+'\\')"><i class="fas fa-trash"></i></button></td></tr>').join('');
}
function openAddWT(){openEditModal('신규 폐기물 종류 등록','fa-trash','#14b8a6',[{n:'TYPE_CODE',l:'코드 *',ph:'PLASTIC'},{n:'TYPE_NAME',l:'종류명 *',ph:'플라스틱'},{n:'DESCRIPTION',l:'설명',ph:'각종 플라스틱류'},{n:'UNIT',l:'단위',v:'kg'},{n:'ACTIVE_YN',l:'상태',type:'select',opts:[['Y','활성'],['N','비활성']]}],async d=>{const r=await adminPost('/waste-api/admin/waste-types',d);if(r.success){toast(r.message);closeEditModal();loadWasteTypes();loadLookups()}else toast(r.message,false)})}
async function editWT(id){const d=await adminFetch('/waste-api/admin/waste-types/'+id);if(!d)return;openEditModal('폐기물 종류 수정','fa-trash','#14b8a6',[{n:'TYPE_CODE',l:'코드',v:d.TYPE_CODE,dis:true},{n:'TYPE_NAME',l:'종류명 *',v:d.TYPE_NAME},{n:'DESCRIPTION',l:'설명',v:d.DESCRIPTION},{n:'UNIT',l:'단위',v:d.UNIT},{n:'ACTIVE_YN',l:'상태',type:'select',opts:[['Y','활성'],['N','비활성']],v:d.ACTIVE_YN}],async data=>{const r=await adminPut('/waste-api/admin/waste-types/'+id,data);if(r.success){toast(r.message);closeEditModal();loadWasteTypes();loadLookups()}else toast(r.message,false)})}
async function delWT(id,name){if(!confirm(name+' 종류를 삭제하시겠습니까?'))return;const r=await adminDel('/waste-api/admin/waste-types/'+id);if(r.success){toast(r.message);loadWasteTypes();loadLookups()}else toast(r.message,false)}

/* --- Collectors --- */
async function loadCollectors(){
  const data=await adminFetch('/waste-api/admin/collectors?all=true');if(!data)return;
  document.getElementById('acolCnt').textContent='('+data.length+'건)';
  const b=document.getElementById('tbCollectors');
  if(!data.length){b.innerHTML=emptyRow(8);return}
  b.innerHTML=data.map(r=>'<tr><td class="mono">'+r.COLLECTOR_CODE+'</td><td style="font-weight:600">'+r.COLLECTOR_NAME+'</td><td>'+(r.ADDRESS||'-')+'</td><td>'+(r.CONTACT_NAME||'-')+'</td><td>'+(r.CONTACT_PHONE||'-')+'</td><td>'+(r.VEHICLE_COUNT||0)+'</td><td>'+activeBadge(r.ACTIVE_YN)+'</td><td><button class="btn btn-sm btn-outline" onclick="editCol('+r.COLLECTOR_ID+')"><i class="fas fa-edit"></i></button> <button class="btn btn-sm btn-red" onclick="delCol('+r.COLLECTOR_ID+',\\''+r.COLLECTOR_NAME+'\\')"><i class="fas fa-trash"></i></button></td></tr>').join('');
}
function openAddCol(){openEditModal('신규 수거 업체 등록','fa-truck','#3b82f6',[{n:'COLLECTOR_CODE',l:'코드 *',ph:'COL-004'},{n:'COLLECTOR_NAME',l:'업체명 *',ph:'(주)새로운수거'},{n:'ADDRESS',l:'주소'},{n:'CONTACT_NAME',l:'담당자'},{n:'CONTACT_PHONE',l:'연락처'},{n:'VEHICLE_COUNT',l:'차량 수',type:'number'},{n:'REMARKS',l:'비고',type:'textarea'},{n:'ACTIVE_YN',l:'상태',type:'select',opts:[['Y','활성'],['N','비활성']]}],async d=>{const r=await adminPost('/waste-api/admin/collectors',d);if(r.success){toast(r.message);closeEditModal();loadCollectors();loadLookups()}else toast(r.message,false)})}
async function editCol(id){const d=await adminFetch('/waste-api/admin/collectors/'+id);if(!d)return;openEditModal('수거 업체 수정','fa-truck','#3b82f6',[{n:'COLLECTOR_CODE',l:'코드',v:d.COLLECTOR_CODE,dis:true},{n:'COLLECTOR_NAME',l:'업체명 *',v:d.COLLECTOR_NAME},{n:'ADDRESS',l:'주소',v:d.ADDRESS},{n:'CONTACT_NAME',l:'담당자',v:d.CONTACT_NAME},{n:'CONTACT_PHONE',l:'연락처',v:d.CONTACT_PHONE},{n:'VEHICLE_COUNT',l:'차량 수',v:d.VEHICLE_COUNT,type:'number'},{n:'REMARKS',l:'비고',v:d.REMARKS,type:'textarea'},{n:'ACTIVE_YN',l:'상태',type:'select',opts:[['Y','활성'],['N','비활성']],v:d.ACTIVE_YN}],async data=>{const r=await adminPut('/waste-api/admin/collectors/'+id,data);if(r.success){toast(r.message);closeEditModal();loadCollectors();loadLookups()}else toast(r.message,false)})}
async function delCol(id,name){if(!confirm(name+' 업체를 삭제하시겠습니까?'))return;const r=await adminDel('/waste-api/admin/collectors/'+id);if(r.success){toast(r.message);loadCollectors();loadLookups()}else toast(r.message,false)}

/* --- Processors --- */
async function loadProcessors(){
  const data=await adminFetch('/waste-api/admin/processors?all=true');if(!data)return;
  document.getElementById('aprocCnt').textContent='('+data.length+'건)';
  const b=document.getElementById('tbProcessors');
  if(!data.length){b.innerHTML=emptyRow(8);return}
  b.innerHTML=data.map(r=>'<tr><td class="mono">'+r.PROCESSOR_CODE+'</td><td style="font-weight:600">'+r.PROCESSOR_NAME+'</td><td>'+(r.ADDRESS||'-')+'</td><td>'+(r.CONTACT_NAME||'-')+'</td><td>'+(r.CONTACT_PHONE||'-')+'</td><td>'+(r.CAPACITY_KG?fmt(r.CAPACITY_KG):'-')+'</td><td>'+activeBadge(r.ACTIVE_YN)+'</td><td><button class="btn btn-sm btn-outline" onclick="editProc('+r.PROCESSOR_ID+')"><i class="fas fa-edit"></i></button> <button class="btn btn-sm btn-red" onclick="delProc('+r.PROCESSOR_ID+',\\''+r.PROCESSOR_NAME+'\\')"><i class="fas fa-trash"></i></button></td></tr>').join('');
}
function openAddProc(){openEditModal('신규 압축 업체 등록','fa-compress-arrows-alt','#f59e0b',[{n:'PROCESSOR_CODE',l:'코드 *',ph:'KNT-004'},{n:'PROCESSOR_NAME',l:'업체명 *',ph:'KNT 세종'},{n:'ADDRESS',l:'주소'},{n:'CONTACT_NAME',l:'담당자'},{n:'CONTACT_PHONE',l:'연락처'},{n:'CAPACITY_KG',l:'처리 용량(kg)',type:'number'},{n:'REMARKS',l:'비고',type:'textarea'},{n:'ACTIVE_YN',l:'상태',type:'select',opts:[['Y','활성'],['N','비활성']]}],async d=>{const r=await adminPost('/waste-api/admin/processors',d);if(r.success){toast(r.message);closeEditModal();loadProcessors();loadLookups()}else toast(r.message,false)})}
async function editProc(id){const d=await adminFetch('/waste-api/admin/processors/'+id);if(!d)return;openEditModal('압축 업체 수정','fa-compress-arrows-alt','#f59e0b',[{n:'PROCESSOR_CODE',l:'코드',v:d.PROCESSOR_CODE,dis:true},{n:'PROCESSOR_NAME',l:'업체명 *',v:d.PROCESSOR_NAME},{n:'ADDRESS',l:'주소',v:d.ADDRESS},{n:'CONTACT_NAME',l:'담당자',v:d.CONTACT_NAME},{n:'CONTACT_PHONE',l:'연락처',v:d.CONTACT_PHONE},{n:'CAPACITY_KG',l:'처리 용량(kg)',v:d.CAPACITY_KG,type:'number'},{n:'REMARKS',l:'비고',v:d.REMARKS,type:'textarea'},{n:'ACTIVE_YN',l:'상태',type:'select',opts:[['Y','활성'],['N','비활성']],v:d.ACTIVE_YN}],async data=>{const r=await adminPut('/waste-api/admin/processors/'+id,data);if(r.success){toast(r.message);closeEditModal();loadProcessors();loadLookups()}else toast(r.message,false)})}
async function delProc(id,name){if(!confirm(name+' 업체를 삭제하시겠습니까?'))return;const r=await adminDel('/waste-api/admin/processors/'+id);if(r.success){toast(r.message);loadProcessors();loadLookups()}else toast(r.message,false)}

/* --- Recyclers --- */
async function loadRecyclers(){
  const data=await adminFetch('/waste-api/admin/recyclers?all=true');if(!data)return;
  document.getElementById('arecCnt').textContent='('+data.length+'건)';
  const b=document.getElementById('tbRecyclers');
  if(!data.length){b.innerHTML=emptyRow(8);return}
  b.innerHTML=data.map(r=>'<tr><td class="mono">'+r.RECYCLER_CODE+'</td><td style="font-weight:600">'+r.RECYCLER_NAME+'</td><td>'+(r.ADDRESS||'-')+'</td><td>'+(r.CONTACT_NAME||'-')+'</td><td>'+(r.CONTACT_PHONE||'-')+'</td><td>'+(r.RECYCLING_TYPES||'-')+'</td><td>'+activeBadge(r.ACTIVE_YN)+'</td><td><button class="btn btn-sm btn-outline" onclick="editRecy('+r.RECYCLER_ID+')"><i class="fas fa-edit"></i></button> <button class="btn btn-sm btn-red" onclick="delRecy('+r.RECYCLER_ID+',\\''+r.RECYCLER_NAME+'\\')"><i class="fas fa-trash"></i></button></td></tr>').join('');
}
function openAddRecy(){openEditModal('신규 재활용 업체 등록','fa-recycle','#8b5cf6',[{n:'RECYCLER_CODE',l:'코드 *',ph:'RCY-004'},{n:'RECYCLER_NAME',l:'업체명 *',ph:'인천재활용'},{n:'ADDRESS',l:'주소'},{n:'CONTACT_NAME',l:'담당자'},{n:'CONTACT_PHONE',l:'연락처'},{n:'RECYCLING_TYPES',l:'처리 가능 종류',ph:'PAPER_WASTE,CARDBOARD'},{n:'REMARKS',l:'비고',type:'textarea'},{n:'ACTIVE_YN',l:'상태',type:'select',opts:[['Y','활성'],['N','비활성']]}],async d=>{const r=await adminPost('/waste-api/admin/recyclers',d);if(r.success){toast(r.message);closeEditModal();loadRecyclers();loadLookups()}else toast(r.message,false)})}
async function editRecy(id){const d=await adminFetch('/waste-api/admin/recyclers/'+id);if(!d)return;openEditModal('재활용 업체 수정','fa-recycle','#8b5cf6',[{n:'RECYCLER_CODE',l:'코드',v:d.RECYCLER_CODE,dis:true},{n:'RECYCLER_NAME',l:'업체명 *',v:d.RECYCLER_NAME},{n:'ADDRESS',l:'주소',v:d.ADDRESS},{n:'CONTACT_NAME',l:'담당자',v:d.CONTACT_NAME},{n:'CONTACT_PHONE',l:'연락처',v:d.CONTACT_PHONE},{n:'RECYCLING_TYPES',l:'처리 가능 종류',v:d.RECYCLING_TYPES},{n:'REMARKS',l:'비고',v:d.REMARKS,type:'textarea'},{n:'ACTIVE_YN',l:'상태',type:'select',opts:[['Y','활성'],['N','비활성']],v:d.ACTIVE_YN}],async data=>{const r=await adminPut('/waste-api/admin/recyclers/'+id,data);if(r.success){toast(r.message);closeEditModal();loadRecyclers();loadLookups()}else toast(r.message,false)})}
async function delRecy(id,name){if(!confirm(name+' 업체를 삭제하시겠습니까?'))return;const r=await adminDel('/waste-api/admin/recyclers/'+id);if(r.success){toast(r.message);loadRecyclers();loadLookups()}else toast(r.message,false)}

/* --- Producers --- */
async function loadProducers(){
  const data=await adminFetch('/waste-api/admin/producers?all=true');if(!data)return;
  document.getElementById('aprdCnt').textContent='('+data.length+'건)';
  const b=document.getElementById('tbProducers');
  if(!data.length){b.innerHTML=emptyRow(8);return}
  b.innerHTML=data.map(r=>'<tr><td class="mono">'+r.PRODUCER_CODE+'</td><td style="font-weight:600">'+r.PRODUCER_NAME+'</td><td>'+(r.ADDRESS||'-')+'</td><td>'+(r.CONTACT_NAME||'-')+'</td><td>'+(r.CONTACT_PHONE||'-')+'</td><td>'+(r.PRODUCT_TYPES||'-')+'</td><td>'+activeBadge(r.ACTIVE_YN)+'</td><td><button class="btn btn-sm btn-outline" onclick="editProdComp('+r.PRODUCER_ID+')"><i class="fas fa-edit"></i></button> <button class="btn btn-sm btn-red" onclick="delProdComp('+r.PRODUCER_ID+',\\''+r.PRODUCER_NAME+'\\')"><i class="fas fa-trash"></i></button></td></tr>').join('');
}
function openAddProd(){openEditModal('신규 생산 업체 등록','fa-industry','#ef4444',[{n:'PRODUCER_CODE',l:'코드 *',ph:'PRD-003'},{n:'PRODUCER_NAME',l:'업체명 *',ph:'인천제지'},{n:'ADDRESS',l:'주소'},{n:'CONTACT_NAME',l:'담당자'},{n:'CONTACT_PHONE',l:'연락처'},{n:'PRODUCT_TYPES',l:'생산 품목',ph:'재생 티슈,위생용지'},{n:'REMARKS',l:'비고',type:'textarea'},{n:'ACTIVE_YN',l:'상태',type:'select',opts:[['Y','활성'],['N','비활성']]}],async d=>{const r=await adminPost('/waste-api/admin/producers',d);if(r.success){toast(r.message);closeEditModal();loadProducers();loadLookups()}else toast(r.message,false)})}
async function editProdComp(id){const d=await adminFetch('/waste-api/admin/producers/'+id);if(!d)return;openEditModal('생산 업체 수정','fa-industry','#ef4444',[{n:'PRODUCER_CODE',l:'코드',v:d.PRODUCER_CODE,dis:true},{n:'PRODUCER_NAME',l:'업체명 *',v:d.PRODUCER_NAME},{n:'ADDRESS',l:'주소',v:d.ADDRESS},{n:'CONTACT_NAME',l:'담당자',v:d.CONTACT_NAME},{n:'CONTACT_PHONE',l:'연락처',v:d.CONTACT_PHONE},{n:'PRODUCT_TYPES',l:'생산 품목',v:d.PRODUCT_TYPES},{n:'REMARKS',l:'비고',v:d.REMARKS,type:'textarea'},{n:'ACTIVE_YN',l:'상태',type:'select',opts:[['Y','활성'],['N','비활성']],v:d.ACTIVE_YN}],async data=>{const r=await adminPut('/waste-api/admin/producers/'+id,data);if(r.success){toast(r.message);closeEditModal();loadProducers();loadLookups()}else toast(r.message,false)})}
async function delProdComp(id,name){if(!confirm(name+' 업체를 삭제하시겠습니까?'))return;const r=await adminDel('/waste-api/admin/producers/'+id);if(r.success){toast(r.message);loadProducers();loadLookups()}else toast(r.message,false)}

/* --- Issues --- */
async function loadIssues(){
  const st=document.getElementById('issFilter').value;
  const data=await adminFetch('/waste-api/admin/issues?status='+st);if(!data)return;
  document.getElementById('aissCnt').textContent='('+data.length+'건)';
  const b=document.getElementById('tbIssues');
  if(!data.length){b.innerHTML=emptyRow(8,'이슈가 없습니다');return}
  b.innerHTML=data.map(r=>{
    const sev='sev-'+(r.SEVERITY||'medium').toLowerCase();
    const ist='ist-'+(r.STATUS||'open').toLowerCase();
    return '<tr><td>'+r.ISSUE_ID+'</td><td class="mono">'+(r.TRACKING_NO||'-')+'</td><td>'+(IT[r.ISSUE_TYPE]||r.ISSUE_TYPE)+'</td><td><span class="badge '+sev+'">'+(SEV[r.SEVERITY]||r.SEVERITY)+'</span></td><td style="font-weight:600">'+r.TITLE+'</td><td>'+(r.REPORTED_BY||'-')+'</td><td><span class="badge '+ist+'">'+(IST[r.STATUS]||r.STATUS)+'</span></td><td><button class="btn btn-sm btn-outline" onclick="editIssue('+r.ISSUE_ID+')"><i class="fas fa-edit"></i></button> <button class="btn btn-sm btn-red" onclick="delIssue('+r.ISSUE_ID+')"><i class="fas fa-trash"></i></button></td></tr>'
  }).join('');
}
function openAddIssue(){openEditModal('이슈 등록','fa-exclamation-circle','#ef4444',[{n:'TRACKING_ID',l:'트래킹 ID',type:'number',ph:'연관 트래킹 ID (선택)'},{n:'ISSUE_TYPE',l:'유형 *',type:'select',opts:[['DELAY','지연'],['QUALITY','품질'],['WEIGHT_DIFF','중량차이'],['ACCIDENT','사고'],['OTHER','기타']]},{n:'SEVERITY',l:'심각도',type:'select',opts:[['LOW','낮음'],['MEDIUM','보통'],['HIGH','높음'],['CRITICAL','긴급']]},{n:'TITLE',l:'제목 *',ph:'이슈 제목'},{n:'DESCRIPTION',l:'상세 내용',type:'textarea',ph:'이슈 상세 설명'},{n:'REPORTED_BY',l:'보고자',ph:'홍길동'},{n:'ASSIGNED_TO',l:'담당자',ph:'담당자명'}],async d=>{const r=await adminPost('/waste-api/admin/issues',d);if(r.success){toast(r.message);closeEditModal();loadIssues()}else toast(r.message,false)})}
async function editIssue(id){
  const data=await adminFetch('/waste-api/admin/issues');if(!data)return;
  const d=data.find(x=>x.ISSUE_ID===id);if(!d)return;
  openEditModal('이슈 수정','fa-exclamation-circle','#ef4444',[{n:'TRACKING_ID',l:'트래킹 ID',type:'number',v:d.TRACKING_ID},{n:'ISSUE_TYPE',l:'유형',type:'select',opts:[['DELAY','지연'],['QUALITY','품질'],['WEIGHT_DIFF','중량차이'],['ACCIDENT','사고'],['OTHER','기타']],v:d.ISSUE_TYPE},{n:'SEVERITY',l:'심각도',type:'select',opts:[['LOW','낮음'],['MEDIUM','보통'],['HIGH','높음'],['CRITICAL','긴급']],v:d.SEVERITY},{n:'TITLE',l:'제목 *',v:d.TITLE},{n:'DESCRIPTION',l:'상세 내용',type:'textarea',v:d.DESCRIPTION},{n:'REPORTED_BY',l:'보고자',v:d.REPORTED_BY},{n:'ASSIGNED_TO',l:'담당자',v:d.ASSIGNED_TO},{n:'STATUS',l:'상태',type:'select',opts:[['OPEN','미해결'],['IN_PROGRESS','처리중'],['RESOLVED','해결됨'],['CLOSED','종료']],v:d.STATUS},{n:'RESOLUTION',l:'해결 내용',type:'textarea',v:d.RESOLUTION}],async data=>{const r=await adminPut('/waste-api/admin/issues/'+id,data);if(r.success){toast(r.message);closeEditModal();loadIssues()}else toast(r.message,false)})
}
async function delIssue(id){if(!confirm('이슈를 삭제하시겠습니까?'))return;const r=await adminDel('/waste-api/admin/issues/'+id);if(r.success){toast(r.message);loadIssues()}else toast(r.message,false)}

/* --- Users --- */
async function loadUsers(){
  const data=await adminFetch('/waste-api/admin/users');if(!data)return;
  document.getElementById('ausrCnt').textContent='('+data.length+'건)';
  const b=document.getElementById('tbUsers');
  if(!data.length){b.innerHTML=emptyRow(8);return}
  b.innerHTML=data.map(r=>'<tr><td>'+r.USER_ID+'</td><td class="mono">'+r.LOGIN_ID+'</td><td style="font-weight:600">'+r.USER_NAME+'</td><td><span class="badge" style="background:'+(r.ROLE==='ADMIN'?'#d1fae5;color:#065f46':'#dbeafe;color:#1d4ed8')+'">'+r.ROLE+'</span></td><td>'+(r.EMAIL||'-')+'</td><td>'+(r.PHONE||'-')+'</td><td>'+activeBadge(r.ACTIVE_YN)+'</td><td><button class="btn btn-sm btn-outline" onclick="editUser('+r.USER_ID+')"><i class="fas fa-edit"></i></button> <button class="btn btn-sm btn-red" onclick="delUser('+r.USER_ID+',\\''+r.LOGIN_ID+'\\')"><i class="fas fa-trash"></i></button></td></tr>').join('');
}
function openAddUser(){openEditModal('사용자 등록','fa-users','#059669',[{n:'LOGIN_ID',l:'로그인 ID *',ph:'newuser'},{n:'PASSWORD',l:'비밀번호 *',ph:'비밀번호 입력',type:'password'},{n:'USER_NAME',l:'이름 *',ph:'홍길동'},{n:'ROLE',l:'역할',type:'select',opts:[['USER','일반 사용자'],['ADMIN','관리자']]},{n:'EMAIL',l:'이메일',ph:'user@company.com'},{n:'PHONE',l:'연락처',ph:'010-0000-0000'}],async d=>{const r=await adminPost('/waste-api/admin/users',d);if(r.success){toast(r.message);closeEditModal();loadUsers()}else toast(r.message,false)})}
async function editUser(id){
  const data=await adminFetch('/waste-api/admin/users');if(!data)return;
  const d=data.find(x=>x.USER_ID===id);if(!d)return;
  openEditModal('사용자 수정','fa-users','#059669',[{n:'LOGIN_ID',l:'로그인 ID',v:d.LOGIN_ID,dis:true},{n:'PASSWORD',l:'비밀번호 (변경시만)',type:'password',ph:'변경할 비밀번호'},{n:'USER_NAME',l:'이름 *',v:d.USER_NAME},{n:'ROLE',l:'역할',type:'select',opts:[['USER','일반 사용자'],['ADMIN','관리자']],v:d.ROLE},{n:'EMAIL',l:'이메일',v:d.EMAIL},{n:'PHONE',l:'연락처',v:d.PHONE},{n:'ACTIVE_YN',l:'상태',type:'select',opts:[['Y','활성'],['N','비활성']],v:d.ACTIVE_YN}],async data=>{if(!data.PASSWORD)delete data.PASSWORD;const r=await adminPut('/waste-api/admin/users/'+id,data);if(r.success){toast(r.message);closeEditModal();loadUsers()}else toast(r.message,false)})
}
async function delUser(id,loginId){if(!confirm(loginId+' 사용자를 삭제하시겠습니까?'))return;const r=await adminDel('/waste-api/admin/users/'+id);if(r.success){toast(r.message);loadUsers()}else toast(r.message,false)}

/* ===== GENERIC EDIT MODAL ===== */
let editCallback=null;
function openEditModal(title,icon,color,fields,cb){
  editCallback=cb;
  let html='<h3><i class="fas '+icon+'" style="color:'+color+'"></i>'+title+'</h3><form id="editForm" class="form-grid">';
  fields.forEach(f=>{
    const cls=f.type==='textarea'?'full':'';
    html+='<div class="form-group '+cls+'"><label>'+f.l+'</label>';
    if(f.type==='select'){
      html+='<select name="'+f.n+'">';
      (f.opts||[]).forEach(o=>{html+='<option value="'+o[0]+'"'+(f.v===o[0]?' selected':'')+'>'+o[1]+'</option>'});
      html+='</select>';
    }else if(f.type==='textarea'){
      html+='<textarea name="'+f.n+'" rows="3" placeholder="'+(f.ph||'')+'"'+(f.dis?' disabled':'')+'>'+((f.v!=null?f.v:''))+'</textarea>';
    }else if(f.type==='password'){
      html+='<input type="password" name="'+f.n+'" placeholder="'+(f.ph||'')+'" value="">';
    }else{
      html+='<input type="'+(f.type||'text')+'" name="'+f.n+'" value="'+((f.v!=null?f.v:''))+'" placeholder="'+(f.ph||'')+'"'+(f.dis?' disabled':'')+'>';
    }
    html+='</div>';
  });
  html+='<div class="full" style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px"><button type="button" class="btn btn-outline" onclick="closeEditModal()">취소</button><button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> 저장</button></div></form>';
  document.getElementById('editModalBody').innerHTML=html;
  document.getElementById('editModal').classList.add('show');
  document.getElementById('editForm').addEventListener('submit',async e=>{
    e.preventDefault();
    const data={};
    new FormData(e.target).forEach((v,k)=>{if(v!=='')data[k]=v});
    if(editCallback)await editCallback(data);
  });
}
function closeEditModal(){document.getElementById('editModal').classList.remove('show');editCallback=null}
document.getElementById('editModal').addEventListener('click',e=>{if(e.target===document.getElementById('editModal'))closeEditModal()});
</script>
</body>
</html>`
}

export default app
