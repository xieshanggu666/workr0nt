import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { REVIEW, buildTimelineEntry } from '@/utils/review'
import { FRESH, calcNextDue, canSetFreshness, isTicketActive } from '@/utils/fresh'
import { GUEST_ID } from '@/utils/permission'
import { useKbStore } from './kb'

// 知识保鲜 store：
// 负责人在文档上设置复核周期（doc.freshness）→ 周期到期自动生成复核单（freshTickets）
// 并暂停该文档的问答引用 → 编辑者修订送审（复核单由 review store 在同一事务内关联评审单）→
// 管理员批准恢复引用并重算周期 / 驳回退回待整改；每轮复核单与留痕全程保留。
// 到期为「调度器 + 惰性扫描」双保险：页面停留期间由定时器到点触发 sweepDue，
// 加载/变更时扫描兜底；建单与暂停引用在同一事务内完成，多窗口并发扫描也不会重复建单。
export const useFreshStore = defineStore('fresh', () => {
  const tickets = ref([])
  const loaded = ref(false)
  let dueTimer = null
  // setTimeout 延迟上限（2^31-1 ms），超过会溢出立即触发，长周期需分段调度
  const MAX_TIMER_DELAY = 2147483647

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
    // 加载即扫描：历史到期文档补建复核单（幂等）
    await sweepDue()
  }

  async function reload() {
    tickets.value = await db.freshTickets.toArray()
    await scheduleDue()
  }

  // 调度下一次到期唤醒：找到「已设周期且未暂停」文档的最近到期点，到点触发扫描建单。
  // 周期设置/审批重算/加载后重排，保证页面停留期间到期也能即时生成复核单
  async function scheduleDue() {
    if (dueTimer) { clearTimeout(dueTimer); dueTimer = null }
    const docs = await db.docs.toArray()
    const t = Date.now()
    let next = Infinity
    for (const d of docs) {
      const f = d.freshness
      if (!f?.cycleDays || f.paused || !f.nextDueAt) continue
      const due = new Date(f.nextDueAt).getTime()
      if (due > t && due < next) next = due
    }
    if (next === Infinity) return
    // 稍过到期点再判定，避免边界误差；超长延迟分段调度
    const delay = Math.min(Math.max(next - Date.now(), 0) + 50, MAX_TIMER_DELAY)
    dueTimer = setTimeout(onDueTick, delay)
  }

  async function onDueTick() {
    dueTimer = null
    await sweepDue()
    await scheduleDue()
  }

  // 待整改复核单数量（侧边栏角标）
  const openCount = computed(() => tickets.value.filter((t) => t.status === FRESH.OPEN).length)

  // 文档当前未关闭的复核单（待整改/送审中，同一文档同时最多一个）
  function activeTicketOf(docId) {
    return tickets.value.find((t) => t.docId === docId && isTicketActive(t)) || null
  }

  // 文档的全部复核单（每轮一条，按轮次倒序）
  function ticketsOfDoc(docId) {
    return tickets.value
      .filter((t) => t.docId === docId)
      .sort((a, b) => b.round - a.round)
  }

  // 到期扫描：为「已设周期、未暂停、已到期」的文档生成复核单并暂停问答引用。
  // 事务内重读文档与既有复核单：多窗口/重复扫描幂等，不会重复建单；
  // 文档已有流转中评审单时复核单直接关联，随其审批结论联动。
  async function sweepDue() {
    const kb = useKbStore()
    const now = new Date()
    const nowIso = now.toISOString()
    const docs = await db.docs.toArray()
    const dueDocs = docs.filter(
      (d) => d.freshness?.cycleDays && !d.freshness.paused && d.freshness.nextDueAt && new Date(d.freshness.nextDueAt) <= now
    )
    if (!dueDocs.length) return
    let changed = false

    await db.transaction('rw', db.docs, db.freshTickets, db.reviews, async () => {
      for (const d of dueDocs) {
        // 事务内重读：并发扫描/审批重算后可能已不再到期
        const fresh = await db.docs.get(d.id)
        if (!fresh?.freshness?.cycleDays || fresh.freshness.paused) continue
        if (!fresh.freshness.nextDueAt || new Date(fresh.freshness.nextDueAt) > now) continue
        // 幂等：已有未关闭复核单则不重复生成
        const existing = await db.freshTickets
          .where('docId').equals(d.id)
          .filter((t) => isTicketActive(t)).first()
        if (existing) continue

        const round = (await db.freshTickets.where('docId').equals(d.id).count()) + 1
        // 文档已有流转中的评审单：复核单直接关联，随其审批结论联动
        const pendingReview = await db.reviews
          .where('docId').equals(d.id)
          .filter((r) => r.status === REVIEW.PENDING).first()
        const ticket = {
          id: uid('fresh'),
          docId: d.id,
          round,
          status: pendingReview ? FRESH.IN_REVIEW : FRESH.OPEN,
          reviewId: pendingReview?.id || null,
          dueAt: fresh.freshness.nextDueAt,
          createdAt: nowIso,
          resolvedAt: null,
          resolvedBy: null,
          timeline: [buildTimelineEntry('expire', 'system', '复核周期到期（周期 ' + fresh.freshness.cycleDays + ' 天），自动生成复核单并暂停问答引用', nowIso)]
        }
        if (pendingReview) {
          ticket.timeline.push(buildTimelineEntry('submit', pendingReview.submittedBy, '关联流转中的评审单（第 ' + round + ' 轮复核）', nowIso))
        }
        await db.freshTickets.add(ticket)
        // 评审单同步标记复核轮次，供评审中心/详情直接展示
        if (pendingReview) {
          await db.reviews.update(pendingReview.id, { freshTicketId: ticket.id, freshRound: round })
        }
        // 暂停问答引用：文档仍可读可编辑，仅不再作为问答引用来源
        await db.docs.update(d.id, { freshness: { ...fresh.freshness, paused: true } })
        changed = true
      }
    })

    if (changed) await Promise.all([kb.reloadDocs(), reload()])
  }

  // 负责人/管理员设置复核周期：首次设置以当前时间为复核起点；
  // 调整周期以上次复核时间为起点重算到期时间（缩短周期可能使文档立即到期，由扫描接管）。
  // 返回 { status: 'ok' } | 'missing' | 'guest' | 'denied' | 'bad-cycle'
  async function setPolicy(docId, cycleDays, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const days = Number(cycleDays)
    if (!days || days <= 0) return { status: 'bad-cycle' }
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      if (!canSetFreshness(doc, userId, currentUser?.role)) {
        result = { status: userId === GUEST_ID ? 'guest' : 'denied' }
        return
      }
      const now = new Date().toISOString()
      const last = doc.freshness?.lastReviewedAt || now
      await db.docs.update(docId, {
        freshness: {
          cycleDays: days,
          lastReviewedAt: last,
          nextDueAt: calcNextDue(days, last),
          // 已暂停（复核单待整改）的文档保持暂停，待审批通过后恢复
          paused: doc.freshness?.paused || false
        }
      })
      result = { status: 'ok' }
    })

    await kb.reloadDocs()
    await reload()
    // 周期缩短可能使文档立即到期：立刻扫描一次（幂等）
    await sweepDue()
    return result
  }

  // 负责人/管理员清除复核周期：未关闭的复核单取消（留痕保留），问答引用恢复
  async function clearPolicy(docId, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.freshTickets, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      if (!canSetFreshness(doc, userId, currentUser?.role)) {
        result = { status: userId === GUEST_ID ? 'guest' : 'denied' }
        return
      }
      const now = new Date().toISOString()
      const actives = await db.freshTickets
        .where('docId').equals(docId)
        .filter((t) => isTicketActive(t)).toArray()
      for (const t of actives) {
        await db.freshTickets.update(t.id, {
          status: FRESH.CANCELLED,
          reviewId: null,
          timeline: [...(t.timeline || []), buildTimelineEntry('cancel', userId, '负责人清除复核周期，复核单取消，问答引用恢复', now)]
        })
      }
      await db.docs.update(docId, { freshness: null })
      result = { status: 'ok', cancelled: actives.length }
    })

    await Promise.all([kb.reloadDocs(), reload()])
    return result
  }

  return {
    tickets, loaded, loadAll, reload,
    openCount, activeTicketOf, ticketsOfDoc,
    sweepDue, setPolicy, clearPolicy
  }
})
