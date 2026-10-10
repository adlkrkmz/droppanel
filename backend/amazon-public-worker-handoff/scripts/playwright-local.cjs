// Workspace launcher preload. Playwright reads this before it is initialized.
// Keep this value aligned with the workspace-local browser installation.
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
