<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useReviewStore } from '@/stores/review'
import { useAccessStore } from '@/stores/access'
import { useFreshStore } from '@/stores/fresh'
import DocPill from '@/components/common/DocPill.vue'
import { formatDate, formatFull, avatarColor } from '@/utils/format'
import { canSubmitReview } from '@/utils/review'
import { GUEST_ID } from '@/utils/permission'
import { FRESH, isFreshPaused, freshStatusLabel, freshStatusCls, freshDueText, freshTimelineLabel } from '@/utils/fresh'

const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const reviewStore = useReviewStore()
const accessStore = useAccessStore()
const freshStore = useFreshStore()

const tab = ref('open') // open | in_review | resolved | all

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))

const sorted = computed(() =>
  [...freshStore.tickets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
)

const list = computed(() => {
  if (tab.value === 'all') return sorted.value
  return sorted.value.filter((t) => t.status === tab.value)
})

const counts = computed(() => ({
  open: freshStore.tickets.filter((t) => t.status === FRESH.OPEN).length,
  in_review: freshStore.tickets.filter((t) => t.status === FRESH.IN_REVIEW).length,
  resolved: freshStore.tickets.filter((t) => t.status === FRESH.RESOLVED).length,
  all: freshStore.tickets.length
}))

// 复核监控：已设置周期的文档（暂停引用的排最前，其余按到期时间升序）
const monitorDocs = computed(() =>
  kb.docs
    .filter((d) => d.freshness?.cycleDays)
    .sort((a, b) => {
      const pa = isFreshPaused(a) ? 0 : 1
      const pb = isFreshPaused(b) ? 0 : 1
      if (pa !== pb) return pa - pb
      return new Date(a.freshness.nextDueAt) - new Date(b.freshness.nextDueAt)
    })
)

// 即将到期：3 天内到期且未暂停
function dueSoon(d) {
  if (isFreshPaused(d) || !d.freshness?.nextDueAt) return false
  const ms = new Date(d.freshness.nextDueAt).getTime() - Date.now()
  return ms > 0 && ms <= 3 * 86400000
}

// 修订送审入口：与发起评审同一套文档级资格
function canSubmitFor(ticket) {
  const doc = docById.value[ticket.docId]
  if (!doc) return false
  return canSubmitReview(doc, {
    userId: auth.user?.id || GUEST_ID,
    role: auth.user?.role,
    grant: accessStore.grantOf(doc.id, auth.user?.id)
  }, reviewStore.pendingReviewOf(doc.id))
}

function goRevise(ticket) {
  router.push('/docs/' + ticket.docId + '/edit?submitReview=1')
}

onMounted(async () => {
  await freshStore.loadAll()
})
</script>

<template>
  <div class="fc-page">
    <header class="head">
      <h2>🧊 知识保鲜</h2>
      <p class="sub">负责人设置复核周期 → 到期自动生成复核单并暂停问答引用 → 编辑者修订送审 → 管理员批准后恢复引用并重算周期。</p>
      <div class="tabs">
        <button :class="{ on: tab === 'open' }" @click="tab = 'open'">待整改 <em>{{ counts.open }}</em></button>
        <button :class="{ on: tab === 'in_review' }" @click="tab = 'in_review'">送审中 <em>{{ counts.in_review }}</em></button>
        <button :class="{ on: tab === 'resolved' }" @click="tab = 'resolved'">已复核 <em>{{ counts.resolved }}</em></button>
        <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部 <em>{{ counts.all }}</em></button>
      </div>
    </header>

    <div v-if="!list.length" class="empty card">
      <div class="ico">🧊</div>
      {{ tab === 'open' ? '暂无待整改的复核单，知识库保持新鲜' : tab === 'in_review' ? '暂无送审中的复核单' : tab === 'resolved' ? '暂无已完成的复核记录' : '暂无复核单' }}
    </div>

    <div v-else class="tk-list">
      <div v-for="t in list" :key="t.id" class="tk card">
        <div class="tk-top" @click="docById[t.docId] && router.push('/docs/' + t.docId)">
          <div class="tk-main">
            <span class="tk-doc-title">{{ docById[t.docId]?.title || '已删除文档' }}</span>
            <span class="tk-round">第 {{ t.round }} 轮复核</span>
            <DocPill v-if="docById[t.docId]" :doc="docById[t.docId]" />
          </div>
          <div class="tk-side">
            <span class="st" :class="freshStatusCls(t.status)">{{ freshStatusLabel(t.status) }}</span>
            <span class="tk-time">{{ formatDate(t.createdAt) }} 生成</span>
          </div>
        </div>

        <div class="tk-info">
          <span>到期时间：{{ formatFull(t.dueAt) }}</span>
          <span v-if="t.resolvedAt" class="tk-resolved">
            <span class="ava" :style="{ background: avatarColor(t.resolvedBy) }">{{ userById[t.resolvedBy]?.avatar || '?' }}</span>
            {{ userById[t.resolvedBy]?.name || t.resolvedBy }} 于 {{ formatFull(t.resolvedAt) }} 复核通过
          </span>
          <span v-else-if="t.status === FRESH.IN_REVIEW">已关联评审单，等待管理员审批</span>
          <span v-else-if="t.status === FRESH.OPEN">问答引用已暂停，待编辑者修订送审</span>
        </div>

        <div v-if="t.status === FRESH.OPEN" class="tk-acts">
          <button v-if="canSubmitFor(t)" class="btn sm primary" @click="goRevise(t)">✎ 修订送审</button>
          <span v-else class="tk-tip">仅文档拥有者、协作成员或管理员可修订送审</span>
        </div>

        <details class="timeline">
          <summary>查看留痕时间线（{{ (t.timeline || []).length }}）</summary>
          <div v-for="(e, i) in t.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ freshTimelineLabel(e.action) }}</span>
            <span class="tl-who">{{ e.by === 'system' ? '系统' : (userById[e.by]?.name || e.by) }}</span>
            <span v-if="e.note" class="tl-note">“{{ e.note }}”</span>
            <span class="tl-tm">{{ formatFull(e.at) }}</span>
          </div>
        </details>
      </div>
    </div>

    <!-- 复核监控：所有已设周期文档的保鲜状态 -->
    <div v-if="monitorDocs.length" class="mon card">
      <div class="mon-title">📡 复核监控（{{ monitorDocs.length }} 篇文档已设置周期）</div>
      <div v-for="d in monitorDocs" :key="d.id" class="mon-row" @click="router.push('/docs/' + d.id)">
        <span class="mon-name">{{ d.title }}</span>
        <span class="mon-meta">周期 {{ d.freshness.cycleDays }} 天 · 上次复核 {{ formatDate(d.freshness.lastReviewedAt) }}</span>
        <span class="mon-due" :class="{ paused: isFreshPaused(d), soon: dueSoon(d) }">
          {{ isFreshPaused(d) ? '⏳ 已暂停引用' : freshDueText(d) }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fc-page { max-width: 900px; margin: 0 auto; }
.head h2 { margin: 0 0 4px; }
.sub { color: var(--text-2); font-size: 13px; margin: 0 0 14px; }
.tabs { display: flex; gap: 8px; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }
.tk-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.tk { padding: 16px 20px; }
.tk-top { display: flex; justify-content: space-between; gap: 14px; cursor: pointer; }
.tk-main { min-width: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tk-doc-title { font-weight: 700; font-size: 15px; }
.tk-round { font-size: 11px; padding: 1px 9px; border-radius: 999px; background: #cffafe; color: #0e7490; font-weight: 600; }
.tk-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-open { background: #fef3c7; color: #b45309; }
.st-review { background: #e0e7ff; color: #4338ca; }
.st-ok { background: #dcfce7; color: #15803d; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.tk-time { color: var(--text-3); font-size: 12px; }
.tk-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 10px; font-size: 13px; color: var(--text-2); }
.tk-resolved { display: inline-flex; align-items: center; gap: 6px; }
.ava { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 10px; display: inline-grid; place-items: center; }
.tk-acts { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; display: flex; align-items: center; gap: 10px; }
.tk-tip { font-size: 12px; color: var(--text-3); }
.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 118px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
.mon { margin-top: 20px; padding: 16px 20px; }
.mon-title { font-weight: 700; font-size: 14px; margin-bottom: 8px; }
.mon-row { display: flex; align-items: center; gap: 14px; padding: 9px 10px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.mon-row:hover { background: var(--panel-2); }
.mon-name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-meta { color: var(--text-3); font-size: 12px; white-space: nowrap; }
.mon-due { margin-left: auto; font-size: 12px; color: var(--text-2); white-space: nowrap; }
.mon-due.paused { color: #b45309; font-weight: 600; }
.mon-due.soon { color: #b45309; }
</style>
