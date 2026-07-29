# Task ID 2 — Workspace Sub-Pages (Team, Audit, Settings)

## Agent
main (Z.ai Code)

## Task
Phase 10 — Build three workspace sub-pages: Team, Audit Log, Settings.

## Work Log
- Read prior worklog (1029 lines) and existing workspace/billing pages to align on emerald-primary design system, sticky-header/mt-auto-footer pattern, and breadcrumb conventions.
- Inspected all relevant API routes: GET /api/v1/workspaces/[workspaceId] (workspace info + plan), GET /api/v1/workspaces/[workspaceId]/members (member list), GET /api/v1/workspaces/[workspaceId]/audit-logs (page/pageSize pagination, NOT cursor), GET /api/v1/workspaces/[workspaceId]/white-label (branding settings), PATCH /api/v1/workspaces/[workspaceId]/white-label (update branding).
- Noted audit-logs API uses page/pageSize pagination (not cursor) — adapted the UI accordingly.
- Discovered all audit action types from codebase: WORKSPACE_CREATE, WORKSPACE_UPDATE, PROJECT_CREATE/UPDATE/DELETE, MEMBER_INVITE/ACCEPT/REMOVE, ROLE_CHANGE, RUN_CREATE/CANCEL/COMPLETE, REPORT_SUBMIT_APPROVAL/APPROVE/REJECT, FINDING_ACKNOWLEDGE/RESOLVE, ENVIRONMENT_CREATE, DOMAIN_VERIFY_START/COMPLETE, LOGIN, LOGOUT.

### Team Page (`/app/workspaces/[workspaceId]/team`)
- Client component fetching workspace info + members in parallel.
- Members table: avatar circle (first initials, role-colored), name + email, role Badge (OWNER=default, ADMIN=secondary, MEMBER/VIEWER=outline with muted text), joined date (hidden on mobile).
- Invitation form: email input with Mail icon prefix + role Select (ADMIN/MEMBER/VIEWER/CLIENT) + Invite button (UI only, no API call).
- Loading skeleton + error state with retry button.
- Sticky header with ShieldCheck logo + nav links (Settings, Audit log).
- Breadcrumb: Dashboard → Workspace Name → Team.

### Audit Log Page (`/app/workspaces/[workspaceId]/audit`)
- Client component fetching workspace info + audit logs in parallel.
- Table columns: Timestamp (relative time + exact date), Action (color-coded Badge — destructive for DELETE/REMOVE/REJECT, default for CREATE/APPROVE/COMPLETE/RESOLVE, secondary for others), Actor type, Description (target type + truncated ID), Result outcome (emerald/red/amber).
- Action type filter via Select dropdown with 22 known action types + "All actions".
- Page-based pagination (prev/next) with page X of Y + total count.
- Max-height 600px scrollable container with responsive column hiding.
- Loading skeleton + error state with retry.

### Settings Page (`/app/workspaces/[workspaceId]/settings`)
- Client component fetching workspace info + white-label settings in parallel (white-label gracefully handles 403).
- Tabs component with 3 tabs: General, White Label, Danger Zone.
- **General tab**: read-only display — workspace name, slug (monospace), created date, plan badge with link to billing, user role, data retention days.
- **White Label tab**: Switch (disabled, reflects plan status), form fields for brandName, accentColor (with color preview swatch), brandIntro, brandFooter, brandContactEmail, logoUrl. Save button calls PATCH /api/v1/workspaces/[workspaceId]/white-label with CSRF token, shows loading spinner + success checkmark. Error handling with AlertCircle. Disabled when plan doesn't support white-label.
- **Danger Zone tab**: destructive-styled Card with Delete Workspace section. AlertDialog confirmation with strong warning text. Button only (no actual delete API call).
- Loading skeleton + error state with retry.

### Shared patterns across all 3 pages
- `min-h-screen flex flex-col bg-background` root layout.
- Sticky header with ShieldCheck logo + nav links to sibling pages.
- Breadcrumb nav: Dashboard → Workspace Name → current page.
- `mt-auto` footer with `© ${year} ProofPilot. Automated QA, not penetration testing.`
- Client-side `fetch('/api/v1/...')` only — no absolute URLs, no port numbers.
- All shadcn/ui components used (Card, Badge, Button, Input, Table, Select, AlertDialog, Tabs, Skeleton, Separator, Label, Switch).
- Emerald/green primary, no blue/indigo colors.
- Mobile-first responsive design.
- Light/dark theme via CSS vars.

- Lint: 0 errors, 0 warnings from new files (all 3 files clean).
- Dev server: confirmed running and ready on port 3000.

## Stage Summary
- New files: src/app/app/workspaces/[workspaceId]/team/page.tsx, src/app/app/workspaces/[workspaceId]/audit/page.tsx, src/app/app/workspaces/[workspaceId]/settings/page.tsx
- No new API routes created — used existing endpoints only.
- No schema changes needed.
- All three pages follow consistent design system and UX patterns established by prior Phase 10 pages.