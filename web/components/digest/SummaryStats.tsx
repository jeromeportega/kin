import type { Digest } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export function SummaryStats({ digest }: { digest: Digest }) {
  return (
    <div className="grid grid-cols-3 gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Classified</CardTitle>
        </CardHeader>
        <CardContent>
          <span className="text-2xl font-bold">{digest.classified_count}</span>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Actionable</CardTitle>
        </CardHeader>
        <CardContent>
          <span className="text-2xl font-bold">{digest.actionable_count}</span>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Informational</CardTitle>
        </CardHeader>
        <CardContent>
          <span className="text-2xl font-bold">{digest.informational_count}</span>
        </CardContent>
      </Card>
    </div>
  )
}
