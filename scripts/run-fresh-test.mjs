// 知识保鲜：端到端回归（fake-indexeddb + 真实 store）
// 覆盖：复核周期设置权限、到期自动生成复核单并暂停问答引用（扫描幂等 + 调度器到点触发）、
//       编辑者送审自动关联复核单、管理员批准恢复引用并重算周期（版本留复核轮次标记）、
//       驳回/撤回继续整改、清除周期取消复核单、每轮复核记录保留（轮次递增）。
// 运行：npm run test:fresh（esbuild 打包后在 node 中执行）
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useReviewStore } from '@/stores/review'
import { useFreshStore } from '@/stores/fresh'
import { uid } from '@/utils/format'
import { FRESH, isFreshPaused } from '@/utils/fresh'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const review = useReviewStore(pinia)
const fresh = useFreshStore(pinia)

const admin = { id: 'u-admin', role: 'admin', name: '管理员' }
const owner = { id: 'u-owner', role: 'editor', name: '负责人' }
const outsider = { id: 'u-out', role: 'editor', name: '无关编辑者' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = new Date().toISOString()
const pastIso = new Date(Date.now() - 86400000).toISOString()

async function mkDoc(extra = {}) {
  const d = {
    id: uid('doc'), title: '保鲜测试-' + Math.random().toString(36).slice(2, 7),
    body: '<p>正文</p>', categoryId: 'c', tagIds: [], visibility: 'public',
    ownerId: owner.id, editors: [owner.id], publishState: 'published', activeReviewId: null,
    createdAt: nowIso, updatedAt: nowIso,
    versions: [{ version: 1, savedAt: nowIso, savedBy: owner.id, note: '初始' }],
    ...extra
  }
  await db.docs.add(d)
  await kb.reloadDocs()
  return d
}

const patchOf = (doc, body) => ({
  title: doc.title, body: body || '<p>修订后正文</p>', categoryId: doc.categoryId,
  tagIds: [...(doc.tagIds || [])], visibility: doc.visibility
})

await kb.loadAll()
await fresh.loadAll()

// ---------- 1. 设置复核周期：权限与字段 ----------
console.log('\n[1] 设置复核周期')
const d1 = await mkDoc()
const r1 = await fresh.setPolicy(d1.id, 30, owner)
assert(r1.status === 'ok', '负责人可设置复核周期')
const doc1 = await db.docs.get(d1.id)
assert(doc1.freshness?.cycleDays === 30, '周期天数已写入')
assert(!doc1.freshness.paused && new Date(doc1.freshness.nextDueAt) > new Date(), '首次设置：未暂停，到期时间在未来')
assert((await fresh.setPolicy(d1.id, 30, outsider)).status === 'denied', '无关编辑者不可设置（仅负责人/管理员）')
assert((await fresh.setPolicy(d1.id, 30, null)).status === 'guest', '访客不可设置')
assert((await fresh.setPolicy(d1.id, 0, owner)).status === 'bad-cycle', '非法周期被拒绝')

// ---------- 2. 到期扫描：自动生成复核单 + 暂停引用（幂等） ----------
console.log('\n[2] 到期自动生成复核单并暂停问答引用')
const d2 = await mkDoc({ freshness: { cycleDays: 7, lastReviewedAt: pastIso, nextDueAt: pastIso, paused: false } })
await fresh.sweepDue()
assert(isFreshPaused(await db.docs.get(d2.id)), '到期后文档暂停问答引用')
let tickets2 = await db.freshTickets.where('docId').equals(d2.id).toArray()
assert(tickets2.length === 1 && tickets2[0].round === 1, '自动生成第 1 轮复核单')
assert(tickets2[0].status === FRESH.OPEN && tickets2[0].dueAt === pastIso, '复核单为待整改并记录到期时间')
assert((tickets2[0].timeline || []).some((t) => t.action === 'expire'), '复核单留痕：到期自动生成')
await fresh.sweepDue()
tickets2 = await db.freshTickets.where('docId').equals(d2.id).toArray()
assert(tickets2.length === 1, '重复扫描不重复建单（幂等）')
const ticket1 = tickets2[0]

// ---------- 3. 编辑者送审：自动关联复核单 ----------
console.log('\n[3] 修订送审自动关联复核单')
const doc2 = await db.docs.get(d2.id)
const sub1 = await review.submitReview(d2.id, patchOf(doc2), '第 1 轮复核修订', owner)
assert(sub1.status === 'ok', '送审成功')
assert(sub1.review.freshTicketId === ticket1.id && sub1.review.freshRound === 1, '评审单标记复核轮次')
let tk = await db.freshTickets.get(ticket1.id)
assert(tk.status === FRESH.IN_REVIEW && tk.reviewId === sub1.review.id, '复核单转为送审中并关联评审单')

// ---------- 4. 驳回：继续整改，引用保持暂停 ----------
console.log('\n[4] 驳回继续整改')
const dec1 = await review.decideReview(sub1.review.id, 'reject', '内容仍需补充', admin)
assert(dec1.status === 'ok' && !dec1.approved, '管理员驳回成功')
tk = await db.freshTickets.get(ticket1.id)
assert(tk.status === FRESH.OPEN && !tk.reviewId, '驳回后复核单退回待整改')
assert((tk.timeline || []).some((t) => t.action === 'return'), '复核单留痕：驳回退回')
assert(isFreshPaused(await db.docs.get(d2.id)), '驳回后问答引用保持暂停')

// ---------- 5. 再次送审 → 批准：恢复引用 + 重算周期 + 版本标记 ----------
console.log('\n[5] 批准恢复引用并重算周期')
const doc2b = await db.docs.get(d2.id)
const sub2 = await review.submitReview(d2.id, patchOf(doc2b), '二次修订', owner)
assert(sub2.status === 'ok' && sub2.review.freshRound === 1, '再次送审仍关联第 1 轮复核单')
const dec2 = await review.decideReview(sub2.review.id, 'approve', '复核通过', admin)
assert(dec2.status === 'ok' && dec2.approved, '管理员批准成功')
tk = await db.freshTickets.get(ticket1.id)
assert(tk.status === FRESH.RESOLVED && tk.resolvedBy === admin.id && tk.resolvedAt, '复核单已解决并记录复核人')
assert((tk.timeline || []).some((t) => t.action === 'resolve'), '复核单留痕：复核通过')
const doc2c = await db.docs.get(d2.id)
assert(!isFreshPaused(doc2c), '批准后恢复问答引用')
assert(new Date(doc2c.freshness.nextDueAt) > new Date(), '周期已重算：新到期时间在未来')
assert(doc2c.freshness.lastReviewedAt > pastIso, '上次复核时间更新为批准时间')
const lastV = doc2c.versions[doc2c.versions.length - 1]
assert(lastV.freshness?.ticketId === ticket1.id && lastV.freshness?.round === 1, '版本记录带复核轮次标记')
assert(lastV.reviewStatus === 'approved', '版本记录保留审批标记')

// ---------- 6. 撤回：复核单退回待整改 ----------
console.log('\n[6] 撤回送审继续整改')
const d3 = await mkDoc({ freshness: { cycleDays: 7, lastReviewedAt: pastIso, nextDueAt: pastIso, paused: false } })
await fresh.sweepDue()
const doc3 = await db.docs.get(d3.id)
const sub3 = await review.submitReview(d3.id, patchOf(doc3), '', owner)
assert(sub3.status === 'ok', '送审成功')
const wd = await review.withdrawReview(sub3.review.id, owner)
assert(wd.status === 'ok', '发起人撤回成功')
const tk3 = (await db.freshTickets.where('docId').equals(d3.id).toArray())[0]
assert(tk3.status === FRESH.OPEN && !tk3.reviewId, '撤回后复核单退回待整改')
assert(isFreshPaused(await db.docs.get(d3.id)), '撤回后问答引用保持暂停')

// ---------- 7. 清除周期：取消复核单 + 恢复引用 ----------
console.log('\n[7] 清除复核周期')
const rc = await fresh.clearPolicy(d3.id, owner)
assert(rc.status === 'ok' && rc.cancelled === 1, '负责人清除周期并取消复核单')
const doc3b = await db.docs.get(d3.id)
assert(!doc3b.freshness, '复核周期已清除（引用恢复）')
const tk3b = await db.freshTickets.get(tk3.id)
assert(tk3b.status === FRESH.CANCELLED, '未完成复核单已取消（留痕保留）')
assert((await fresh.clearPolicy(d3.id, outsider)).status === 'denied', '无关成员不可清除周期')

// ---------- 8. 每轮记录保留：第二轮复核 ----------
console.log('\n[8] 每轮复核记录保留')
await db.docs.update(d2.id, { freshness: { ...doc2c.freshness, nextDueAt: pastIso } })
await kb.reloadDocs()
await fresh.sweepDue()
const tickets8 = await db.freshTickets.where('docId').equals(d2.id).toArray()
assert(tickets8.length === 2, '第 2 轮复核单已生成，历史轮次保留')
assert(tickets8.map((t) => t.round).sort().join(',') === '1,2', '轮次递增')
assert(tickets8.find((t) => t.round === 1).status === FRESH.RESOLVED, '第 1 轮复核记录原样保留')
assert(tickets8.find((t) => t.round === 2).status === FRESH.OPEN, '第 2 轮待整改')

// ---------- 9. 到期调度器：页面停留期间自动生成（不刷新） ----------
console.log('\n[9] 到期调度器自动触发')
const d4 = await mkDoc({ freshness: { cycleDays: 1, lastReviewedAt: nowIso, nextDueAt: new Date(Date.now() + 300).toISOString(), paused: false } })
await fresh.reload() // 重排调度器
await sleep(900)
const tickets9 = await db.freshTickets.where('docId').equals(d4.id).toArray()
assert(tickets9.length === 1 && tickets9[0].status === FRESH.OPEN, '调度器到点自动生成复核单（无需刷新）')
assert(isFreshPaused(await db.docs.get(d4.id)), '调度器到点自动暂停引用')

// ---------- 10. 到期时已有流转评审单：复核单直接关联 ----------
console.log('\n[10] 到期时已有流转评审单')
const d5 = await mkDoc()
const doc5 = await db.docs.get(d5.id)
const sub5 = await review.submitReview(d5.id, patchOf(doc5), '普通修订', owner)
assert(sub5.status === 'ok', '先发起评审')
await db.docs.update(d5.id, { freshness: { cycleDays: 1, lastReviewedAt: pastIso, nextDueAt: pastIso, paused: false } })
await kb.reloadDocs()
await fresh.sweepDue()
const tk5 = (await db.freshTickets.where('docId').equals(d5.id).toArray())[0]
assert(tk5 && tk5.status === FRESH.IN_REVIEW && tk5.reviewId === sub5.review.id, '复核单直接关联流转中的评审单')
const dec5 = await review.decideReview(sub5.review.id, 'approve', '', admin)
assert(dec5.status === 'ok' && dec5.approved, '流转评审单批准成功')
const tk5b = await db.freshTickets.get(tk5.id)
assert(tk5b.status === FRESH.RESOLVED, '批准后复核单同步解决')
assert(!isFreshPaused(await db.docs.get(d5.id)), '批准后恢复引用并重算周期')

// ---------- 11. 删除文档：复核单一并清理 ----------
console.log('\n[11] 删除文档连带清理')
const del = await kb.deleteDoc(d2.id, admin)
assert(del.status === 'ok', '删除文档成功')
assert((await db.freshTickets.where('docId').equals(d2.id).count()) === 0, '复核单随文档一并清理')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
