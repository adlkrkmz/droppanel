# Cursor Workflow — ListJetGo

Current priority:
Admin/User separation for eBay panel.

Working directory:
C:\Users\pc\Desktop\ebay listing\backend

Important:
- Open only the backend folder in Cursor, not Desktop and not the parent "ebay listing" folder.
- Keep tasks small.
- Do not scan or modify Etsy project.
- Do not touch node_modules or .next.
- Existing /admin/* internal operations must keep working.
- New user-facing APIs should be under /app/*.
- User APIs must use JWT workspaceId and ownership guard.
