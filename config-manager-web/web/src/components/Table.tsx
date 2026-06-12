import type { ReactNode } from 'react'

export function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <table className="table">
      <thead>
        <tr>{headers.map(h => <th key={h}>{h}</th>)}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}
