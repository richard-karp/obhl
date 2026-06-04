"use client";

import { uploadTeamLogo } from "@/lib/actions/logos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LogoUpload({ teamId }: { teamId: string }) {
  return (
    <form action={uploadTeamLogo} className="flex items-end gap-2">
      <input type="hidden" name="team_id" value={teamId} />
      <Input type="file" name="logo" accept="image/*" className="max-w-xs" required />
      <Button type="submit" variant="outline" size="sm">
        Upload logo
      </Button>
    </form>
  );
}
