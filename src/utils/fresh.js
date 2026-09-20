// 知识保鲜：复核周期、复核单状态与权限判定（均为纯函数，便于复用与测试）
// 流程：负责人设置复核周期 → 到期自动生成复核单并暂停问答引用 → 编辑者修订送审 →
// 管理员批准恢复引用并重算周期 / 驳回继续整改。每轮复核单与版本记录全程保留。
import { ROLE, GUEST_ID } from './permission'

// 复核单状态
export const FRESH = {
  OPEN: 'open', // 待整改：周期到期已生成复核单，问答引用暂停中
  IN_REVIEW: 'in_review', // 送审中：已关联流转中的评审单，等待管理员审批
  RESOLVED: 'resolved', // 已复核：审批通过，引用恢复并重算周期
  CANCELLED: 'cancelled' // 已取消：负责人清除复核周期，复核单作废（留痕保留）
}

// 可选复核周期（天）
export const FRESH_CYCLES = [
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
  { value: 180, label: '180 天' }
]

// 文档是否处于「暂停问答引用」状态（到期未复核）
export function isFreshPaused(doc) {
  return !!doc?.freshness?.paused
}

// 复核单是否仍未关闭（待整改 / 送审中）
export function isTicketActive(ticket) {
  return !!ticket && (ticket.status === FRESH.OPEN || ticket.status === FRESH.IN_REVIEW)
}

// 计算下次到期时间：从 from 起推 cycleDays 天
export function calcNextDue(cycleDays, from = new Date()) {
  const n = Number(cycleDays)
  if (!n || n <= 0) return null
  const base = from instanceof Date ? from : new Date(from)
  return new Date(base.getTime() + n * 86400000).toISOString()
}

// 设置/清除复核周期：仅文档负责人（拥有者）或管理员
export function canSetFreshness(doc, userId, role) {
  if (!doc || !userId || userId === GUEST_ID) return false
  return role === ROLE.ADMIN || doc.ownerId === userId
}

export function freshStatusLabel(status) {
  return { open: '待整改', in_review: '送审中', resolved: '已复核', cancelled: '已取消' }[status] || status
}

export function freshStatusCls(status) {
  return { open: 'st-open', in_review: 'st-review', resolved: 'st-ok', cancelled: 'st-off' }[status] || ''
}

// 复核单留痕动作文案
export function freshTimelineLabel(action) {
  return {
    expire: '到期生成复核单',
    submit: '修订送审',
    resolve: '复核通过 · 恢复引用',
    return: '退回 · 继续整改',
    cancel: '清除周期 · 复核单取消'
  }[action] || action
}

// 到期状态描述（监控列表/详情面板共用）
export function freshDueText(doc, now = new Date()) {
  const f = doc?.freshness
  if (!f?.cycleDays) return '未设置复核周期'
  if (f.paused) return '已到期，问答引用暂停中'
  if (!f.nextDueAt) return '—'
  const ms = new Date(f.nextDueAt).getTime() - now.getTime()
  if (ms <= 0) return '已到期'
  const days = Math.ceil(ms / 86400000)
  return days + ' 天后到期'
}

// 版本记录上的复核轮次标记（审批通过时由评审联动写入）
export function versionFreshBadge(v) {
  if (!v?.freshness?.round) return null
  return { text: '第 ' + v.freshness.round + ' 轮复核', cls: 'fresh' }
}
