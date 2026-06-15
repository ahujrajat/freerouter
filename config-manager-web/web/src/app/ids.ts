/** Generate the next auto-increment id of the form `${prefix}-${n}`, where n is
 *  one greater than the highest existing `${prefix}-<number>` id. Ids that don't
 *  match the pattern are ignored, so a fresh list yields `${prefix}-1`. */
export function nextId(existing: string[], prefix: string): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`)
  let max = 0
  for (const id of existing) {
    const m = re.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}-${max + 1}`
}
