import type { HTMLAttributes, ReactNode, Ref } from 'react'

export function TransientNotice({ message, children, role = 'status', ...props }: HTMLAttributes<HTMLDivElement> & {
  message?: ReactNode; ref?: Ref<HTMLDivElement>
}) {
  return message || children ? <div {...props} role={role} aria-live={role === 'alert' ? 'assertive' : 'polite'} aria-atomic="true">{message}{children}</div> : null
}
