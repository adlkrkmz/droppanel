export type NotificationType = 'success' | 'error' | 'warning' | 'info'

export interface NotificationPayload {
  type: NotificationType
  title: string
  message: string
}

export function addNotification(
  type: NotificationType,
  title: string,
  message: string
): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<NotificationPayload>('app:notification', {
      detail: { type, title, message },
    })
  )
}
