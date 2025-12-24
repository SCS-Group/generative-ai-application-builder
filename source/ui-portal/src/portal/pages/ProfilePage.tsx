import { Card, CardContent, CardHeader, CardTitle } from '@/portal/ui/Card';

export function ProfilePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Your profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">Profile settings coming soon.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">Coming soon...</div>
        </CardContent>
      </Card>
    </div>
  );
}

