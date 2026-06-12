import { Button } from './Button.js'
export function ConflictBanner({ onReload }: { onReload: () => void }) {
  return (
    <div className="banner banner--conflict" role="alert">
      This configuration changed on the server since you loaded it.{' '}
      <Button variant="ghost" onClick={onReload}>Reload latest</Button>
    </div>
  )
}
