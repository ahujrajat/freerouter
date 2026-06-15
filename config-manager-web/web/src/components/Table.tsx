import type { ReactNode } from 'react'

export function Table({ headers, children }: { headers: ReactNode[]; children: ReactNode }) {
  return (
    <table className="table">
      <thead>
        <tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}
