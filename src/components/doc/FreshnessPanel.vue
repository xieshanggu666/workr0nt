<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useReviewStore } from '@/stores/review'
import { useAccessStore } from '@/stores/access'
import { useFreshStore } from '@/stores/fresh'
import { formatFull, formatDate } from '@/utils/format'
import { canSubmitReview } from '@/utils/review'
import { GUEST_ID } from '@/utils/permission'
import {
  FRESH, FRESH_CYCLES, isFreshPaused, canSetFreshness,
  freshStatusLabel, freshStatusCls, freshDueText, freshTimelineLabel
} from '@/utils/fresh'

const props = defineProps({
  doc: { type: Object, required: true }
})

const router = useRouter()
const auth = useAuthStore()
const reviewStore = useReviewStore()
const accessStore = useAccessStore()
const freshStore = useFreshStore()

const editing = ref(false)
const cycleSel = ref(30)
const busy = ref(false)
const tip = ref('')
// 展开的复核轮次 id
const expanded = ref({})

const policy = computed(() => props.doc.freshness || null)
const activeTicket = computed(() => freshStore.activeTicketOf(props.doc.id))
const rounds = computed(() => freshStore.ticketsOfDoc(props.doc.id))
const paused = computed(() => isFreshPaused(props.doc))
const pendingReview = computed(() => reviewStore.pendingReviewOf(props.doc.id))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const dueText = computed(() => freshDueText(props.doc))

// 设置/清除周期：仅负责人或管理员
const canManage = computed(() => canSetFreshness(props.doc, auth.user?.id, auth.user?.role))
// 修订送审入口：与发起评审同一套文档级资格（拥有者/协作成员/管理员/限时协作）
const canSubmit = computed(() => canSubmitReview(props.doc, {
  userId: auth.user?.id || GUEST_ID,
  role: auth.user?.role,
  grant: accessStore.grantOf(props.doc.id, auth.user?.id)
}, pendingReview.value))

function startEdit() {
  cycleSel.value = policy.value?.cycleDays || 30
  editing.value = true
}

async function savePolicy() {
  if (busy.value) return
  busy.value = true
  try {
    const res = await freshStore.setPolicy(props.doc.id, cycleSel.value, auth.user)
    if (res.status === 'ok') {
      editing.value = false
      tip.value = '复核周期已保存，到期将自动生成复核单'
      setTimeout(() => { tip.value = '' }, 3000)
    } else if (res.status === 'guest') {
      alert('访客不能设置复核周期，请先登录。')
    } else if (res.status === 'denied') {
      alert('仅文档负责人或管理员可设置复核周期。')
    } else {
      alert('保存失败，请重试。')
    }
  } finally {
    busy.value = false
  }
}

async function clearPolicy() {
  if (!confirm('确定清除该文档的复核周期？未完成的复核单将取消，问答引用恢复。')) return
  if (busy.value) return
  busy.value = true
  try {
    const res = await freshStore.clearPolicy(props.doc.id, auth.user)
    if (res.status === 'ok') {
      editing.value = false
      tip.value = res.cancelled ? '已清除复核周期，未完成的复核单已取消' : '已清除复核周期'
      setTimeout(() => { tip.value = '' }, 3000)
    } else if (res.status === 'guest') {
      alert('访客不能清除复核周期，请先登录。')
    } else if (res.status === 'denied') {
      alert('仅文档负责人或管理员可清除复核周期。')
    }
  } finally {
    busy.value = false
  }
}

function goRevise() {
  router.push('/docs/' + props.doc.id + '/edit?submitReview=1')
}

function toggle(id) { expanded.value = { ...expanded.value, [id]: !expanded.value[id] } }
</script>

<template>
  <div class="fresh card">
    <div class="f-head">
      <span class="f-title">🧊 知识保鲜</span>
      <span v-if="!policy" class="st st-off">未设置复核周期</span>
      <span v-else-if="activeTicket?.status === FRESH.OPEN" class="st st-open">⏳ 已暂停问答引用</span>
      <span v-else-if="activeTicket?.status === FRESH.IN_REVIEW" class="st st-review">复核送审中</span>
      <span v-else class="st st-ok">保鲜中</span>
      <button v-if="canManage && !editing" class="btn sm" @click="startEdit">{{ policy ? '调整周期' : '设置周期' }}</button>
    </div>

    <div v-if="tip" class="tip-line">✅ {{ tip }}</div>

    <div v-if="policy" class="f-meta">
      <span>复核周期 <b>{{ policy.cycleDays }} 天</b></span>
      <span>上次复核 {{ formatFull(policy.lastReviewedAt) }}</span>
      <span>下次到期 {{ formatFull(policy.nextDueAt) }}（{{ dueText }}）</span>
    </div>
    <div v-else class="f-empty">
      负责人可为文档设置复核周期：到期自动生成复核单并暂停问答引用，编辑者修订送审、管理员批准后恢复引用并重算周期。
    </div>

    <!-- 设置/调整周期 -->
    <div v-if="editing" class="f-edit">
      <span class="f-edit-label">复核周期</span>
      <div class="f-cycles">
        <span v-for="c in FRESH_CYCLES" :key="c.value" class="chip" :class="{ on: cycleSel === c.value }" @click="cycleSel = c.value">{{ c.label }}</span>
      </div>
      <div class="f-edit-acts">
        <button class="btn sm primary" :disabled="busy" @click="savePolicy">保存</button>
        <button class="btn sm ghost" @click="editing = false">取消</button>
        <button v-if="policy" class="btn sm danger" :disabled="busy" @click="clearPolicy">清除周期</button>
      </div>
    </div>

    <!-- 待整改复核单 -->
    <div v-if="activeTicket?.status === FRESH.OPEN" class="f-alert">
      <div class="f-alert-title">⏳ 第 {{ activeTicket.round }} 轮复核待整改</div>
      <div class="f-alert-desc">
        文档已于 {{ formatFull(activeTicket.dueAt) }} 到期，问答引用已暂停。
        编辑者修订并提交评审，管理员批准后恢复引用并重算周期；驳回则继续整改。
      </div>
      <button v-if="canSubmit" class="btn sm primary" @click="goRevise">✎ 修订送审</button>
      <span v-else class="f-alert-tip">等待文档编辑者修订送审</span>
    </div>

    <!-- 送审中 -->
    <div v-else-if="activeTicket?.status === FRESH.IN_REVIEW" class="f-reviewing">
      ⏳ 第 {{ activeTicket.round }} 轮复核已送审，等待管理员审批；批准恢复引用，驳回继续整改。
      <a @click="router.push('/reviews')">前往评审中心 →</a>
    </div>

    <!-- 每轮复核记录 -->
    <div v-if="rounds.length" class="f-history">
      <div class="f-h-title">复核记录（{{ rounds.length }} 轮）</div>
      <div v-for="t in rounds" :key="t.id" class="f-round">
        <div class="f-r-head" @click="toggle(t.id)">
          <span class="f-round-no">第 {{ t.round }} 轮</span>
          <span class="st sm" :class="freshStatusCls(t.status)">{{ freshStatusLabel(t.status) }}</span>
          <span class="f-r-time">{{ formatDate(t.createdAt) }} 生成</span>
          <span v-if="t.resolvedAt" class="f-r-time">{{ userById[t.resolvedBy]?.name || t.resolvedBy }} 于 {{ formatDate(t.resolvedAt) }} 复核通过</span>
          <span class="f-arrow">{{ expanded[t.id] ? '收起 ▲' : '展开 ▼' }}</span>
        </div>
        <div v-if="expanded[t.id]" class="f-timeline">
          <div v-for="(e, i) in t.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ freshTimelineLabel(e.action) }}</span>
            <span class="tl-who">{{ e.by === 'system' ? '系统' : (userById[e.by]?.name || e.by) }}</span>
            <span v-if="e.note" class="tl-note">“{{ e.note }}”</span>
            <span class="tl-tm">{{ formatFull(e.at) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fresh { margin-top: 14px; padding: 18px 24px; }
.f-head { display: flex; align-items: center; gap: 10px; }
.f-title { font-weight: 700; font-size: 15px; }
.f-head .btn { margin-left: auto; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st.sm { font-size: 11px; padding: 1px 8px; }
.st-open { background: #fef3c7; color: #b45309; }
.st-review { background: #e0e7ff; color: #4338ca; }
.st-ok { background: #dcfce7; color: #15803d; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.tip-line { margin-top: 10px; color: #15803d; font-size: 13px; }
.f-meta { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-top: 10px; font-size: 13px; color: var(--text-2); }
.f-meta b { color: var(--primary); }
.f-empty { margin-top: 10px; font-size: 13px; color: var(--text-3); line-height: 1.7; }
.f-edit { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.f-edit-label { font-size: 13px; font-weight: 600; }
.f-cycles { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { padding: 4px 14px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel-2); cursor: pointer; font-size: 13px; }
.chip.on { background: var(--primary); border-color: var(--primary); color: #fff; }
.f-edit-acts { display: flex; gap: 8px; }
.btn.danger { color: var(--danger); border-color: var(--danger); }
.f-alert { margin-top: 12px; padding: 12px 16px; border-radius: 10px; background: #fffbeb; border: 1px solid #f59e0b; }
.f-alert-title { font-weight: 700; color: #b45309; margin-bottom: 4px; }
.f-alert-desc { font-size: 13px; color: var(--text-2); line-height: 1.7; margin-bottom: 10px; }
.f-alert-tip { font-size: 12px; color: var(--text-3); }
.f-reviewing { margin-top: 12px; padding: 10px 16px; border-radius: 10px; font-size: 13px; color: #4338ca; background: #eef2ff; border: 1px solid #c7d2fe; }
.f-reviewing a { cursor: pointer; font-weight: 600; }
.f-history { margin-top: 14px; border-top: 1px solid var(--panel-2); padding-top: 10px; }
.f-h-title { font-size: 12px; color: var(--text-3); margin-bottom: 6px; }
.f-round { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; overflow: hidden; }
.f-r-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; font-size: 13px; background: var(--panel-2); flex-wrap: wrap; }
.f-round-no { font-weight: 700; }
.f-r-time { color: var(--text-3); font-size: 12px; }
.f-arrow { margin-left: auto; color: var(--text-3); font-size: 12px; }
.f-timeline { padding: 8px 14px; }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 5px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 118px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
</style>
